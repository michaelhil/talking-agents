// ============================================================================
// Provider Router — multi-provider failover with per-request cooldown.
//
// Holds a set of ProviderGateway instances keyed by logical name. For each
// chat/stream call, walks the configured priority order, skipping providers
// that are cold (cooldown timer not yet elapsed) or whose cached /models list
// doesn't include the requested model. On rate_limit / quota / provider_down
// errors, trips a per-provider cooldown and falls through. On auth /
// bad_request errors, propagates without fallback (config problem).
//
// Emits routing events so the UI can show toaster notifications:
//   - provider_bound       a call succeeded after a provider change
//   - provider_all_failed  every eligible provider was cold/down
//   - provider_stream_failed  a stream died mid-response (no retry per A3)
//
// Model resolution rules:
//   "provider:model-id"  → pin to that provider, no fallback
//   "model-id"           → try providers in order, skip those that don't
//                          list the model; honour last-successful soft
//                          preference to avoid ping-pong toasts.
//   Prefix is split on the FIRST colon only (OpenRouter slugs contain ':').
// ============================================================================

import type { LLMProvider, ChatRequest, ChatResponse, StreamChunk, GatewayMetrics } from '../core/types/llm.ts'
import type { ProviderGateway, ChatCallOptions } from './provider-gateway.ts'
import { createCloudProviderError, isCloudProviderError, isFallbackable, isGatewayError } from './errors.ts'

// === Events ===

export interface ProviderAttemptRecord {
  readonly provider: string
  readonly reason: string
}

export type ProviderBoundEvent = {
  readonly type: 'provider_bound'
  readonly agentId: string | null
  readonly model: string
  readonly oldProvider: string | null
  readonly newProvider: string
}

export type ProviderAllFailedEvent = {
  readonly type: 'provider_all_failed'
  readonly agentId: string | null
  readonly model: string
  readonly attempts: ReadonlyArray<ProviderAttemptRecord>
}

export type ProviderStreamFailedEvent = {
  readonly type: 'provider_stream_failed'
  readonly agentId: string | null
  readonly model: string
  readonly provider: string
  readonly reason: string
}

export type ProviderRoutingEvent =
  | ProviderBoundEvent
  | ProviderAllFailedEvent
  | ProviderStreamFailedEvent

export type ProviderRoutingListener = (event: ProviderRoutingEvent) => void

// === Extended call options ===

export interface RouterCallOptions extends ChatCallOptions {
  readonly agentId?: string | null
}

// === Config ===

export interface ContextLookupFn {
  (provider: string, model: string): Promise<{ contextMax: number; source: string }>
}

export interface ProviderRouterConfig {
  // Logical provider names (keys into providers map) in priority order.
  readonly order: ReadonlyArray<string>
  // Default cooldown when a provider returns rate_limit without a Retry-After.
  readonly defaultRateLimitCooldownMs?: number
  // Cooldown applied on quota errors (usually resets daily).
  readonly defaultQuotaCooldownMs?: number
  // Cooldown applied on 5xx errors.
  readonly defaultProviderDownCooldownMs?: number
  // Test hook: provider name to force-fail (simulates errors for E2E).
  readonly forceFailProvider?: string | null
  // Resolve the model's max context window. Results are consumed per call and
  // attached to ChatResponse / the final StreamChunk.
  readonly contextLookup?: ContextLookupFn
  // Runtime gate — return false to skip a provider entirely (e.g. no API key
  // supplied yet). Called on every request; safe to change over time.
  readonly isProviderEnabled?: (name: string) => boolean
}

const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000          // 1 min
const DEFAULT_QUOTA_COOLDOWN_MS = 60 * 60_000          // 1 hour (quotas often hourly/daily)
const DEFAULT_PROVIDER_DOWN_COOLDOWN_MS = 30_000       // 30 sec

// === Deps (testable clock) ===

export interface ProviderRouterDeps {
  readonly now?: () => number
}

// === Router interface ===

export interface ProviderRouter extends LLMProvider {
  readonly chat: (request: ChatRequest, options?: RouterCallOptions) => Promise<ChatResponse>
  readonly stream: (request: ChatRequest, signal?: AbortSignal, options?: RouterCallOptions) => AsyncIterable<StreamChunk>
  readonly onRoutingEvent: (listener: ProviderRoutingListener) => void
  readonly getProviderNames: () => ReadonlyArray<string>
  readonly getAggregatedMetrics: () => RouterMetrics
  readonly getCooldownState: () => Record<string, { coldUntilMs: number; reason: string } | null>
  readonly getOrder: () => ReadonlyArray<string>
  readonly setOrder: (names: ReadonlyArray<string>) => void
  readonly dispose: () => void
}

export interface RouterMetrics {
  readonly byProvider: Record<string, GatewayMetrics>
  readonly lastSuccessByModel: Record<string, string>  // model → provider
  readonly routingEvents: {
    readonly bound: number
    readonly allFailed: number
    readonly streamFailed: number
  }
}

// Re-export from the unified model-naming subsystem so existing tests and
// any internal call sites that reach for `parseProviderPrefix` keep working.
// The single source of truth lives in src/llm/models/parse-prefix.ts.
import { parsePrefixedModel } from './models/parse-prefix.ts'
export { parsePrefixedModel as parseProviderPrefix }
const parseProviderPrefix = parsePrefixedModel

// === Factory ===

export const createProviderRouter = (
  providers: Record<string, ProviderGateway>,
  config: ProviderRouterConfig,
  deps: ProviderRouterDeps = {},
): ProviderRouter => {
  const now = deps.now ?? Date.now
  // Mutable so setOrder() can reassign at runtime (UI reorder).
  let order: ReadonlyArray<string> = config.order.filter(name => providers[name] !== undefined)
  if (order.length === 0) {
    throw new Error('ProviderRouter: no configured providers are available')
  }

  const rateLimitCooldownMs = config.defaultRateLimitCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS
  const quotaCooldownMs = config.defaultQuotaCooldownMs ?? DEFAULT_QUOTA_COOLDOWN_MS
  const providerDownCooldownMs = config.defaultProviderDownCooldownMs ?? DEFAULT_PROVIDER_DOWN_COOLDOWN_MS

  // Per-provider cooldown state. null = healthy. Cooldown is soft — we still
  // let the individual gateway's circuit breaker act as a second line.
  const cooldowns: Map<string, { coldUntilMs: number; reason: string }> = new Map()

  const isCold = (name: string): boolean => {
    const state = cooldowns.get(name)
    if (!state) return false
    if (now() >= state.coldUntilMs) {
      cooldowns.delete(name)
      return false
    }
    return true
  }

  const markCold = (name: string, cooldownMs: number, reason: string): void => {
    cooldowns.set(name, { coldUntilMs: now() + cooldownMs, reason })
    // Also tell the gateway to treat this as an external failure (informs metrics).
    providers[name]?.recordExternalFailure()
  }

  // Soft-preference: once a model has succeeded on provider X, prefer X on the
  // next call (stops ping-pong between providers when X re-enters its healthy
  // window before Y's current success).
  const lastSuccessByModel: Map<string, string> = new Map()
  // Per-agent last successful provider, for transition detection on toasts.
  const lastByAgentModel: Map<string, string> = new Map()

  const agentKey = (agentId: string | null | undefined, model: string): string =>
    `${agentId ?? '__system__'}::${model}`

  // Routing listeners
  const listeners: ProviderRoutingListener[] = []
  const emit = (ev: ProviderRoutingEvent): void => {
    for (const l of listeners) {
      // Loud-warn instead of silent-drop — same bug-class as commit 5d73a8e.
      // A buggy listener should be visible, not eaten.
      try { l(ev) } catch (err) {
        console.warn(`[router:onRoutingEvent] listener threw on ${ev.type}:`, err)
      }
    }
    if (ev.type === 'provider_bound') eventCounts.bound++
    else if (ev.type === 'provider_all_failed') eventCounts.allFailed++
    else eventCounts.streamFailed++
  }
  const eventCounts = { bound: 0, allFailed: 0, streamFailed: 0 }

  const isEnabled = (name: string): boolean => {
    if (!config.isProviderEnabled) return true
    return config.isProviderEnabled(name)
  }

  // Resolve the provider list to try for a given model.
  const resolveCandidates = (model: string): { candidates: string[]; modelId: string; pinned: boolean } => {
    const { provider: pinned, modelId } = parseProviderPrefix(model)
    if (pinned) {
      if (!providers[pinned] || !isEnabled(pinned)) return { candidates: [], modelId, pinned: true }
      return { candidates: [pinned], modelId, pinned: true }
    }

    // Filter order by providers whose cached availableModels includes modelId
    // AND who are currently enabled (have an API key).
    //
    // Bootstrap awaits warmProviderModels before serving traffic, so by the
    // time chat()/stream() runs, every provider with credentials has
    // populated its catalog. A still-empty catalog means either (a) the
    // provider had no key and warm was skipped, or (b) warm failed (logged
    // at boot). In neither case should we optimistically include — that
    // produces the "fall through to broken provider" failure mode that
    // surfaced on samsinn.app. Empty catalog = not eligible. If a user
    // explicitly wants a provider that lacks a catalog, they prefix the
    // model (e.g. "groq:llama-3.3"); pinned routing skips this filter.
    const eligible = order.filter(name => {
      if (!isEnabled(name)) return false
      const list = providers[name]?.getHealth().availableModels ?? []
      return list.includes(modelId)
    })

    // Apply soft preference: if lastSuccessByModel[modelId] is in the eligible
    // list and not cold, promote it to front.
    const preferred = lastSuccessByModel.get(modelId)
    if (preferred && eligible.includes(preferred) && !isCold(preferred)) {
      return {
        candidates: [preferred, ...eligible.filter(n => n !== preferred)],
        modelId, pinned: false,
      }
    }
    return { candidates: eligible, modelId, pinned: false }
  }

  // Classify an error → cooldown (ms) + reason (or null if non-fallbackable).
  // Classify a provider error into a routing decision. Mutates `attempts`
  // and (via markCold) cooldowns. Returns:
  //   'fallthrough' — error is fallbackable; caller should try next candidate.
  //   'rethrow'     — permanent error (auth, bad_request, etc); propagate.
  //
  // This used to be inlined twice in chat() with two parallel branches —
  // one for cooldown errors, one for shed (queue_full / circuit_open).
  // Collapsed so the chat path has a single uniform shape; stream() will
  // start using this once its iterator-deferred semantics are factored.
  const classifyProviderError = (
    err: unknown,
    name: string,
    attempts: ProviderAttemptRecord[],
    markColdFn: typeof markCold,
  ): 'fallthrough' | 'rethrow' => {
    const cooldown = cooldownFor(err)
    if (cooldown) {
      markColdFn(name, cooldown.cooldownMs, cooldown.reason)
      attempts.push({ provider: name, reason: cooldown.reason })
      return 'fallthrough'
    }
    if (isGatewayError(err) && (err.code === 'queue_full' || err.code === 'circuit_open')) {
      attempts.push({ provider: name, reason: err.code })
      return 'fallthrough'
    }
    return 'rethrow'
  }

  const cooldownFor = (err: unknown): { cooldownMs: number; reason: string } | null => {
    if (!isCloudProviderError(err)) return null
    if (!isFallbackable(err)) return null
    if (err.code === 'rate_limit') {
      return {
        cooldownMs: err.retryAfterMs ?? rateLimitCooldownMs,
        reason: `rate-limited${err.retryAfterMs ? ` (retry in ${Math.round(err.retryAfterMs / 1000)}s)` : ''}`,
      }
    }
    if (err.code === 'quota') {
      return {
        cooldownMs: err.retryAfterMs ?? quotaCooldownMs,
        reason: 'quota exceeded',
      }
    }
    if (err.code === 'provider_down') {
      return {
        cooldownMs: err.retryAfterMs ?? providerDownCooldownMs,
        reason: 'provider unavailable',
      }
    }
    return null
  }

  const callOnProvider = async (
    name: string,
    request: ChatRequest,
    options: RouterCallOptions | undefined,
    modelId: string,
  ): Promise<ChatResponse> => {
    if (config.forceFailProvider === name) {
      throw createCloudProviderError({
        code: 'provider_down', provider: name,
        message: `FORCE_PROVIDER_FAIL=${name} (test hook)`,
      })
    }
    const adjusted: ChatRequest = { ...request, model: modelId }
    return providers[name]!.chat(adjusted, { ...options, maxQueueDepth: 0 })
  }

  const chat = async (request: ChatRequest, options?: RouterCallOptions): Promise<ChatResponse> => {
    const agentId = options?.agentId ?? null
    const { candidates, modelId, pinned } = resolveCandidates(request.model)
    const attempts: ProviderAttemptRecord[] = []

    for (const name of candidates) {
      if (isCold(name)) {
        const state = cooldowns.get(name)
        attempts.push({ provider: name, reason: state?.reason ?? 'cold' })
        continue
      }
      try {
        const rawResponse = await callOnProvider(name, request, options, modelId)
        // Success — update soft preference + emit bound event if transition.
        const ctx = config.contextLookup
          ? await config.contextLookup(name, modelId).catch(() => ({ contextMax: 0, source: 'unknown' }))
          : { contextMax: 0, source: 'unknown' }
        const response: ChatResponse = {
          ...rawResponse,
          provider: name,
          contextMax: ctx.contextMax,
          contextSource: ctx.source,
        }
        lastSuccessByModel.set(modelId, name)
        const key = agentKey(agentId, request.model)
        const prev = lastByAgentModel.get(key) ?? null
        lastByAgentModel.set(key, name)
        if (prev !== name) {
          emit({
            type: 'provider_bound',
            agentId, model: request.model,
            oldProvider: prev, newProvider: name,
          })
        }
        return response
      } catch (err) {
        const decision = classifyProviderError(err, name, attempts, markCold)
        if (decision === 'rethrow') throw err
        if (pinned) {
          emit({ type: 'provider_all_failed', agentId, model: request.model, attempts })
          throw err
        }
        // 'fallthrough' — try next candidate.
      }
    }

    // All candidates exhausted without success.
    emit({ type: 'provider_all_failed', agentId, model: request.model, attempts })
    throw createCloudProviderError({
      code: 'provider_down',
      provider: 'router',
      message: `All providers failed for model ${request.model}: ${attempts.map(a => `${a.provider}(${a.reason})`).join(', ')}`,
    })
  }

  // Stream: mid-stream failover is NOT attempted (A3 resolution).
  // On initial-connect failure (before any token flush), fall through like chat().
  // Once tokens have flushed, any error surfaces as provider_stream_failed.
  const stream = async function* (
    request: ChatRequest,
    signal?: AbortSignal,
    options?: RouterCallOptions,
  ): AsyncIterable<StreamChunk> {
    const agentId = options?.agentId ?? null
    const { candidates, modelId, pinned } = resolveCandidates(request.model)
    const attempts: ProviderAttemptRecord[] = []

    for (const name of candidates) {
      if (isCold(name)) {
        const state = cooldowns.get(name)
        attempts.push({ provider: name, reason: state?.reason ?? 'cold' })
        continue
      }
      if (config.forceFailProvider === name) {
        const err = createCloudProviderError({
          code: 'provider_down', provider: name,
          message: `FORCE_PROVIDER_FAIL=${name} (test hook)`,
        })
        markCold(name, providerDownCooldownMs, 'forced fail')
        attempts.push({ provider: name, reason: 'forced fail' })
        if (pinned) {
          emit({ type: 'provider_all_failed', agentId, model: request.model, attempts })
          throw err
        }
        continue
      }

      const gateway = providers[name]!
      const adjusted: ChatRequest = { ...request, model: modelId }
      let iter: AsyncIterator<StreamChunk>
      try {
        iter = gateway.stream!(adjusted, signal)[Symbol.asyncIterator]()
      } catch (err) {
        const cooldown = cooldownFor(err)
        if (cooldown) {
          markCold(name, cooldown.cooldownMs, cooldown.reason)
          attempts.push({ provider: name, reason: cooldown.reason })
          if (pinned) {
            emit({ type: 'provider_all_failed', agentId, model: request.model, attempts })
            throw err
          }
          continue
        }
        throw err
      }

      // We have an iterator. First chunk attempt: if it throws BEFORE yielding,
      // still treat as initial-connect failure and fall through.
      let firstChunk: IteratorResult<StreamChunk> | undefined
      try {
        firstChunk = await iter.next()
      } catch (err) {
        const cooldown = cooldownFor(err)
        if (cooldown) {
          markCold(name, cooldown.cooldownMs, cooldown.reason)
          attempts.push({ provider: name, reason: cooldown.reason })
          if (pinned) {
            emit({ type: 'provider_all_failed', agentId, model: request.model, attempts })
            throw err
          }
          continue
        }
        throw err
      }

      // At least one chunk (or done=true). Commit to this provider.
      lastSuccessByModel.set(modelId, name)
      const key = agentKey(agentId, request.model)
      const prev = lastByAgentModel.get(key) ?? null
      lastByAgentModel.set(key, name)
      if (prev !== name) {
        emit({
          type: 'provider_bound',
          agentId, model: request.model,
          oldProvider: prev, newProvider: name,
        })
      }

      // Look up context window once per (provider, modelId); attach to final done chunk.
      const ctxPromise = config.contextLookup
        ? config.contextLookup(name, modelId).catch(() => ({ contextMax: 0, source: 'unknown' }))
        : Promise.resolve({ contextMax: 0, source: 'unknown' })
      const augmentDone = async (chunk: StreamChunk): Promise<StreamChunk> => {
        if (!chunk.done) return chunk
        const ctx = await ctxPromise
        return {
          ...chunk,
          // Augment is additive — preserve provider/context if already set by
          // a downstream layer (unlikely here, but safe).
          ...(chunk as { provider?: string }).provider ? {} : { provider: name },
          ...(chunk as { contextMax?: number }).contextMax !== undefined ? {} : { contextMax: ctx.contextMax },
        } as StreamChunk
      }

      try {
        if (firstChunk && !firstChunk.done) yield firstChunk.value
        else if (firstChunk && firstChunk.done) { yield await augmentDone(firstChunk.value); return }
        while (true) {
          const r = await iter.next()
          if (r.done) return
          yield await augmentDone(r.value)
        }
      } catch (err) {
        // Mid-stream failure — surface as event, no retry.
        const reason = err instanceof Error ? err.message : String(err)
        emit({
          type: 'provider_stream_failed',
          agentId, model: request.model, provider: name, reason,
        })
        const cooldown = cooldownFor(err)
        if (cooldown) markCold(name, cooldown.cooldownMs, cooldown.reason)
        throw err
      }
      return
    }

    // No candidate produced even a first chunk.
    emit({ type: 'provider_all_failed', agentId, model: request.model, attempts })
    throw createCloudProviderError({
      code: 'provider_down',
      provider: 'router',
      message: `All providers failed for stream of model ${request.model}: ${attempts.map(a => `${a.provider}(${a.reason})`).join(', ')}`,
    })
  }

  const models = async (): Promise<string[]> => {
    const results = await Promise.allSettled(
      order.map(async name => {
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('models timeout')), 3000))
        const list = await Promise.race([providers[name]!.models(), timeout])
        return { name, list }
      }),
    )
    const merged = new Set<string>()
    for (const r of results) {
      if (r.status === 'fulfilled') {
        for (const m of r.value.list) merged.add(`${r.value.name}:${m}`)
      }
    }
    return [...merged]
  }

  const onRoutingEvent = (listener: ProviderRoutingListener): void => {
    listeners.push(listener)
  }

  const getAggregatedMetrics = (): RouterMetrics => {
    const byProvider: Record<string, GatewayMetrics> = {}
    for (const name of order) byProvider[name] = providers[name]!.getMetrics()
    const lastSuccess: Record<string, string> = {}
    for (const [model, provider] of lastSuccessByModel) lastSuccess[model] = provider
    return {
      byProvider,
      lastSuccessByModel: lastSuccess,
      routingEvents: { ...eventCounts },
    }
  }

  const getCooldownState = (): Record<string, { coldUntilMs: number; reason: string } | null> => {
    const out: Record<string, { coldUntilMs: number; reason: string } | null> = {}
    for (const name of order) {
      out[name] = cooldowns.get(name) ?? null
    }
    return out
  }

  // Runtime reorder — used by the UI providers panel. The posted order must
  // be the exact set of known providers (no duplicates, no unknowns). The
  // soft-preference cache is cleared so the new order takes effect on the
  // next request, not eventually after existing preferences expire.
  const setOrder = (names: ReadonlyArray<string>): void => {
    if (!Array.isArray(names)) throw new Error('setOrder: expected an array')
    const known = new Set(Object.keys(providers))
    const seen = new Set<string>()
    for (const n of names) {
      if (typeof n !== 'string' || !n) throw new Error('setOrder: entries must be non-empty strings')
      if (seen.has(n)) throw new Error(`setOrder: duplicate provider "${n}"`)
      seen.add(n)
      if (!known.has(n)) throw new Error(`setOrder: unknown provider "${n}"`)
    }
    for (const n of known) {
      if (!seen.has(n)) throw new Error(`setOrder: missing provider "${n}" (must post the full list)`)
    }
    order = [...names]
    lastSuccessByModel.clear()
    lastByAgentModel.clear()
  }

  return {
    chat,
    stream,
    models,
    onRoutingEvent,
    getProviderNames: () => [...order],
    getOrder: () => [...order],
    setOrder,
    getAggregatedMetrics,
    getCooldownState,
    dispose: () => { listeners.length = 0 },
  }
}
