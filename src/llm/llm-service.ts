// ============================================================================
// LLMService — single gateway for every LLM call in the codebase.
//
// Wraps the ProviderRouter with three cross-cutting concerns that every
// consumer (agents, summary engine, whisper, standalone callLLM) needs but
// historically reimplemented or skipped:
//
//   1. Pre-call cooldown skip — consult the live monitor snapshot. If the
//      primary's provider is in `backoff` with retryAt > now+1s, route to
//      the first chain element instead of the doomed primary. Eliminates
//      the "wait 28s for Gemini to time out" UX symptom.
//
//   2. Walk-on-fallbackable — single source of truth for FALLBACKABLE_CODES.
//      On a transient/account-state error, advance to the next chain
//      element. Stops on success or non-fallbackable error.
//
//   3. Structured observability — every call emits the canonical [llm] log
//      line with source tag (agent/summary/whisper/tool/system), provider,
//      model, prompt/completion tokens, cache_read, duration, attempts.
//
// Design choice: chain walk inside the service applies to single-shot calls
// (callChat / one-shot callStream). For agent eval which runs a multi-round
// tool loop, the agent layer owns chain semantics — service is invoked
// per-round but with `fallbackChain: []` so the service does NOT walk; the
// agent walks the chain across full evaluate() calls. This avoids
// mid-tool-loop provider switches that could confuse the new model with
// the prior provider's tool-call protocol.
//
// Chain resolution priority:
//   per-call override   — caller-supplied (code-only API)
//   per-agent override  — opts.agentChain (back-compat path; not surfaced in UI)
//   system default      — opts.systemChain (read from llm-policy at request time)
//
// First non-empty wins. Empty array = no chain walk.
// ============================================================================

import type { ChatRequest, ChatResponse, StreamChunk } from '../core/types/llm.ts'
import type { ProviderRouter, ProviderAttemptRecord, RouterCallOptions } from './router.ts'
import type { MonitorState } from './provider-monitor.ts'
import { parsePrefixedModel } from './models/parse-prefix.ts'

// === Source tagging — kept open for new consumers without changing the type ===

export type LLMSource = 'agent' | 'summary' | 'whisper' | 'tool' | 'system'

// === Codes that warrant advancing to the next chain element ===

// Single source of truth — duplicates in agents/model-fallback.ts will be
// removed when ai-agent.ts migrates onto this service. Includes
// `model_unavailable` because cross-provider chains hit different account
// state (Anthropic credit-out, OpenAI plan-restricted model, etc.) which
// the next provider may not share.
const FALLBACKABLE_AGENT_CODES: ReadonlySet<string> = new Set([
  'rate_limited', 'provider_down', 'network', 'model_unavailable',
])

// === Call options ===

export interface LLMServiceCallOptions {
  // Per-call override. When set (even to []), bypasses agentChain/systemChain.
  // Empty array means "do not walk any chain" — primary only.
  readonly fallbackChain?: ReadonlyArray<string>
  // Agent's persisted modelFallback (back-compat path). Used when fallbackChain is undefined.
  readonly agentChain?: ReadonlyArray<string>
  // System default chain (from llm-policy.json). Used when neither of the above is set.
  readonly systemChain?: ReadonlyArray<string>
  readonly source?: LLMSource
  readonly signal?: AbortSignal
  readonly agentId?: string | null
}

// === Outcome shapes ===

export interface LLMServiceFailure {
  readonly attempts: ReadonlyArray<ProviderAttemptRecord>
  readonly primaryCode: string
  readonly primaryReason: string
  // Derived from attempts[] — actionable for the user, not a fixed string.
  readonly remediation: string
}

// === Service ===

// LLMService is LLMProvider-compatible at the bare surface (chat/stream/models)
// AND exposes richer callChat/callStream for callers that want explicit
// fallback chain / source tagging / agentId observability.
//
// Agents use callChat/callStream with `fallbackChain: []` to disable the
// service's chain walk (they own their own per-evaluate chain walk).
// Single-shot consumers (summary, whisper, callLLM) use the bare surface
// or pass an explicit chain via callChat/callStream.
export interface LLMService {
  readonly chat: (request: ChatRequest) => Promise<ChatResponse>
  readonly stream: (request: ChatRequest, signal?: AbortSignal) => AsyncIterable<StreamChunk>
  readonly models: () => Promise<string[]>
  readonly callChat: (request: ChatRequest, opts?: LLMServiceCallOptions) => Promise<ChatResponse>
  readonly callStream: (request: ChatRequest, opts?: LLMServiceCallOptions) => AsyncIterable<StreamChunk>
}

// === Implementation ===

const COOLDOWN_SKIP_GUARD_MS = 1_000

const resolveEffectiveChain = (
  opts: LLMServiceCallOptions | undefined,
  defaultSystemChain: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> => {
  if (opts?.fallbackChain !== undefined) return opts.fallbackChain
  if (opts?.agentChain && opts.agentChain.length > 0) return opts.agentChain
  if (opts?.systemChain && opts.systemChain.length > 0) return opts.systemChain
  return defaultSystemChain ?? []
}

// Strip the primary from the chain and dedup. Empty input returns empty.
const dedupChain = (primary: string, chain: ReadonlyArray<string>): ReadonlyArray<string> => {
  const seen = new Set<string>([primary])
  const out: string[] = []
  for (const ref of chain) {
    const t = ref.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

// Decide whether to skip the primary based on monitor state.
// Returns true when the primary's provider is currently in backoff with
// significant time remaining — caller should route directly to the chain.
const shouldSkipPrimary = (
  primaryProvider: string | null,
  monitorSnapshot: Record<string, MonitorState | null>,
  now: number,
): boolean => {
  if (!primaryProvider) return false
  const m = monitorSnapshot[primaryProvider]
  if (!m) return false
  if (m.sub !== 'backoff') return false
  if (m.retryAt === null) return false
  return m.retryAt > now + COOLDOWN_SKIP_GUARD_MS
}

// Build a one-line user-facing remediation derived from the actual attempts
// array. Avoids the "fixed string lies when cause is genuinely something
// else" anti-pattern.
const buildRemediation = (
  attempts: ReadonlyArray<ProviderAttemptRecord>,
  hasChain: boolean,
  modelRef: string,
): string => {
  if (attempts.length === 0) return `No eligible provider for ${modelRef}.`
  const codes = new Set(attempts.map(a => a.code))
  if (codes.has('no_key') || codes.has('disabled')) {
    const blocked = attempts.filter(a => a.code === 'no_key' || a.code === 'disabled').map(a => a.provider).join(', ')
    return `Provider keys missing or disabled: ${blocked}. Add a key in Settings → Providers.`
  }
  if (codes.has('not_listed')) {
    const list = [...new Set(attempts.filter(a => a.code === 'not_listed').map(a => a.provider))].join(', ')
    return `No configured provider lists "${modelRef}". Pick a different model or add the right provider. Tried: ${list}.`
  }
  if (codes.size === 1 && (codes.has('rate_limit') || codes.has('quota') || codes.has('backoff'))) {
    return hasChain
      ? `All chain providers are throttled or over quota. Wait or extend the chain in Settings → Providers.`
      : `Provider throttled or over quota. Set a fallback chain in Settings → Providers → System fallback chain.`
  }
  if (codes.has('provider_down') || codes.has('unhealthy')) {
    return hasChain
      ? `Multiple providers unavailable. Try again shortly, or add more providers to the fallback chain.`
      : `Provider unavailable. Set a fallback chain in Settings → Providers → System fallback chain.`
  }
  if (!hasChain) {
    return `Set a fallback chain in Settings → Providers → System fallback chain so the next failure has somewhere to go.`
  }
  return `Open the Providers panel and check provider status.`
}

const isAgentFallbackable = (err: unknown): boolean => {
  // The router has already classified provider-level errors (auth, bad_request)
  // as rethrowable. By the time we see a structured CloudProviderError here,
  // it's either router-rethrown (permanent — bad_request like Anthropic
  // credit-out) or all-providers-failed (provider_down). Both are agent-level
  // fallbackable when there's a chain to walk.
  const errObj = err as { code?: string }
  if (typeof errObj?.code !== 'string') return true  // unknown → walk anyway
  // Mirror the agent's classifyLLMError mapping:
  //   bad_request → model_unavailable (fallbackable)
  //   auth        → no_api_key (NOT fallbackable — config issue)
  //   rate_limit  → rate_limited (fallbackable)
  //   quota       → rate_limited (fallbackable)
  //   provider_down → provider_down (fallbackable)
  if (errObj.code === 'auth' || errObj.code === 'no_api_key') return false
  // bad_request, rate_limit, quota, provider_down all map to fallbackable
  // agent codes per FALLBACKABLE_AGENT_CODES.
  return true
}

export interface LLMServiceDeps {
  readonly router: ProviderRouter
  // Read at request time so UI edits to the system chain take effect
  // without restart. Returns the system default chain or undefined.
  readonly getSystemChain?: () => ReadonlyArray<string> | undefined
  readonly now?: () => number
}

export const createLLMService = (deps: LLMServiceDeps): LLMService => {
  const now = deps.now ?? Date.now
  const router = deps.router
  const getSystemChain = deps.getSystemChain ?? (() => undefined)

  // Reorder candidates: if primary is doomed by monitor state and chain is
  // non-empty, skip primary. Returns the ordered list of models to try.
  const buildAttemptOrder = (request: ChatRequest, chain: ReadonlyArray<string>): ReadonlyArray<string> => {
    const { provider: primaryProvider } = parsePrefixedModel(request.model)
    const monitor = router.getMonitorSnapshot()
    const skip = shouldSkipPrimary(primaryProvider, monitor, now())
    if (skip && chain.length > 0) {
      // Primary is in backoff; chain is non-empty. Demote primary to last
      // (so we still try it eventually if the chain exhausts and the
      // backoff ends in the meantime).
      return [...chain, request.model]
    }
    return [request.model, ...chain]
  }

  const logLine = (
    source: LLMSource | undefined,
    path: 'chat' | 'stream',
    request: ChatRequest,
    response: { provider?: string; promptTokens?: number; completionTokens?: number; cacheRead?: number; durationMs: number; chunksEmit?: number; toolCalls?: number; contentLen?: number },
  ): void => {
    console.log(
      `[llm] source=${source ?? '?'} path=${path} provider=${response.provider ?? '?'} ` +
      `model=${request.model} content_len=${response.contentLen ?? '?'} tools=${response.toolCalls ?? 0} ` +
      `prompt_tokens=${response.promptTokens ?? '?'} completion_tokens=${response.completionTokens ?? '?'} ` +
      `cache_read=${response.cacheRead ?? '?'} chunks_emit=${response.chunksEmit ?? '?'} ` +
      `duration_ms=${response.durationMs}`,
    )
  }

  const callChat = async (request: ChatRequest, opts?: LLMServiceCallOptions): Promise<ChatResponse> => {
    const chain = dedupChain(request.model, resolveEffectiveChain(opts, getSystemChain()))
    const order = buildAttemptOrder(request, chain)
    const allAttempts: ProviderAttemptRecord[] = []
    let lastError: unknown
    let firstFallbackableError: { code: string; reason: string } | null = null

    for (const model of order) {
      const attemptRequest = { ...request, model }
      const startMs = performance.now()
      try {
        const routerOpts: RouterCallOptions = {
          ...(opts?.agentId !== undefined ? { agentId: opts.agentId } : {}),
        }
        const response = await router.chat(attemptRequest, routerOpts)
        const durationMs = Math.round(performance.now() - startMs)
        logLine(opts?.source, 'chat', attemptRequest, {
          provider: response.provider,
          promptTokens: response.tokensUsed.prompt,
          completionTokens: response.tokensUsed.completion,
          cacheRead: response.tokensUsed.cacheRead,
          durationMs,
          contentLen: response.content.length,
          toolCalls: response.toolCalls?.length ?? 0,
        })
        return response
      } catch (err) {
        lastError = err
        const errObj = err as { code?: string; message?: string }
        if (typeof errObj.code === 'string' && firstFallbackableError === null) {
          firstFallbackableError = { code: errObj.code, reason: errObj.message ?? '' }
        }
        // Carry through any structured attempts attached to the error
        // (router may attach for all_failed cases).
        const errAttempts = (err as { attempts?: ProviderAttemptRecord[] }).attempts
        if (Array.isArray(errAttempts)) allAttempts.push(...errAttempts)
        if (!isAgentFallbackable(err)) break
        // Chain element exhausted; continue to next.
      }
    }
    // Exhausted — synthesize a structured error that carries attempts +
    // remediation. Existing callers expect throws; we throw an Error with
    // those fields attached for the agent layer to surface.
    const failure: LLMServiceFailure = {
      attempts: allAttempts,
      primaryCode: firstFallbackableError?.code ?? 'unknown',
      primaryReason: firstFallbackableError?.reason ?? '',
      remediation: buildRemediation(allAttempts, chain.length > 0, request.model),
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError)
    const out = new Error(message)
    Object.assign(out, failure)
    if (lastError && typeof lastError === 'object' && 'code' in lastError) {
      Object.assign(out, { code: (lastError as { code?: string }).code })
    }
    throw out
  }

  const callStream = async function* (request: ChatRequest, opts?: LLMServiceCallOptions): AsyncIterable<StreamChunk> {
    const chain = dedupChain(request.model, resolveEffectiveChain(opts, getSystemChain()))
    const order = buildAttemptOrder(request, chain)
    const allAttempts: ProviderAttemptRecord[] = []
    let lastError: unknown
    let firstFallbackableError: { code: string; reason: string } | null = null

    for (let i = 0; i < order.length; i++) {
      const model = order[i]!
      const attemptRequest = { ...request, model }
      const startMs = performance.now()
      const routerOpts: RouterCallOptions = {
        ...(opts?.agentId !== undefined ? { agentId: opts.agentId } : {}),
      }
      let chunkCount = 0
      let contentLen = 0
      let toolCallCount = 0
      let promptTokens: number | undefined
      let completionTokens: number | undefined
      let cacheRead: number | undefined
      let providerName: string | undefined
      let firstChunkSeen = false
      try {
        const signal = opts?.signal
        const stream = router.stream(attemptRequest, signal, routerOpts)
        for await (const chunk of stream) {
          firstChunkSeen = true
          chunkCount++
          if (chunk.delta) contentLen += chunk.delta.length
          if (chunk.done) {
            toolCallCount = chunk.toolCalls?.length ?? 0
            promptTokens = chunk.tokensUsed?.prompt
            completionTokens = chunk.tokensUsed?.completion
            cacheRead = chunk.tokensUsed?.cacheRead
            providerName = chunk.provider
          }
          yield chunk
        }
        const durationMs = Math.round(performance.now() - startMs)
        logLine(opts?.source, 'stream', attemptRequest, {
          provider: providerName,
          promptTokens,
          completionTokens,
          cacheRead,
          durationMs,
          chunksEmit: chunkCount,
          toolCalls: toolCallCount,
          contentLen,
        })
        return
      } catch (err) {
        lastError = err
        const errObj = err as { code?: string; message?: string }
        if (typeof errObj.code === 'string' && firstFallbackableError === null) {
          firstFallbackableError = { code: errObj.code, reason: errObj.message ?? '' }
        }
        const errAttempts = (err as { attempts?: ProviderAttemptRecord[] }).attempts
        if (Array.isArray(errAttempts)) allAttempts.push(...errAttempts)
        // If we already started yielding chunks, we can't switch streams
        // mid-flight (mid-stream failover is intentionally NOT done — see
        // router.ts comment). Propagate the error.
        if (firstChunkSeen) throw err
        if (!isAgentFallbackable(err)) break
        // Try next chain element.
      }
    }
    const failure: LLMServiceFailure = {
      attempts: allAttempts,
      primaryCode: firstFallbackableError?.code ?? 'unknown',
      primaryReason: firstFallbackableError?.reason ?? '',
      remediation: buildRemediation(allAttempts, chain.length > 0, request.model),
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError)
    const out = new Error(message)
    Object.assign(out, failure)
    if (lastError && typeof lastError === 'object' && 'code' in lastError) {
      Object.assign(out, { code: (lastError as { code?: string }).code })
    }
    throw out
  }

  // LLMProvider-compatible bare surface. These delegate to callChat/callStream
  // with no per-call override, so the service's standard treatment (cooldown
  // skip, system-default chain walk, observability) applies automatically.
  // Existing callers that take an LLMProvider keep working; the resilience
  // is invisible.
  const chat = (request: ChatRequest): Promise<ChatResponse> => callChat(request)
  const stream = (request: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamChunk> =>
    callStream(request, signal !== undefined ? { signal } : undefined)
  const models = (): Promise<string[]> => router.models()

  return { chat, stream, models, callChat, callStream }
}

// Re-exports for other modules migrating off the old fallback location.
export { FALLBACKABLE_AGENT_CODES }
