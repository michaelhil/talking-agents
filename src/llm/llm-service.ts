// ============================================================================
// LLMService — single gateway every LLM call goes through.
//
// Wraps the ProviderRouter with the cross-cutting policy that every consumer
// (agents, summary, whisper, callSystemLLM) needs:
//
//   1. Pre-call cooldown skip — consult the live monitor snapshot. If the
//      primary's provider is in `backoff` with retryAt > now+1s, route to
//      the first chain element instead of the doomed primary.
//
//   2. Walk-on-fallbackable — single source of truth for the agent-level
//      fallbackable codes. On a transient/account-state error, advance to
//      the next chain element.
//
//   3. One network-only retry per chain element on bare network errors
//      (ECONNRESET / ETIMEDOUT / EPIPE / generic "fetch failed"). Classified
//      provider errors (auth, rate_limit, quota, etc.) advance immediately.
//
//   4. Stream-content normalisation — strips <think>...</think> blocks so
//      consumers never see internal reasoning leakage.
//
//   5. Structured observability — one `[llm]` log line per call with source,
//      provider, model, tokens, cache_read, duration.
//
//   6. Chain-switch signalling — fires opts.onChainSwitch each time the
//      service advances to a new chain element. Reuses the existing
//      model_fallback event shape at the agent layer.
//
// Surface: a single entry point, `bound(opts)`, returns a standard
// LLMProvider with source/agentId/onChainSwitch baked in. There is NO bare
// chat/stream/models on LLMService — every call must go through `bound()`,
// which forces every site to declare its source.
//
// Chain resolution priority:
//   per-call override   — opts.fallbackChain (rare, code-only)
//   system default      — getSystemChain() at request time (live policy)
//
// Per-call override wins; empty array means "primary only — do not walk".
// ============================================================================

import type { ChatRequest, ChatResponse, LLMProvider, StreamChunk } from '../core/types/llm.ts'
import type { ProviderRouter, ProviderAttemptRecord, RouterCallOptions } from './router.ts'
import type { MonitorState } from './provider-monitor.ts'
import { parsePrefixedModel } from './models/parse-prefix.ts'
import { isAgentFallbackable as classifyIsAgentFallbackable } from '../agents/error-classify.ts'

// === Source tagging — every call site declares its identity ===

export type LLMSource = 'agent' | 'summary' | 'whisper' | 'system'

// === Codes that warrant advancing to the next chain element ===
// Single source of truth. Includes `model_unavailable` because cross-provider
// chains hit different account state (Anthropic credit-out, OpenAI plan-
// restricted model) which the next provider may not share.
export const FALLBACKABLE_AGENT_CODES: ReadonlySet<string> = new Set([
  'rate_limited', 'provider_down', 'network', 'model_unavailable',
])

// === Bind options ===

export interface LLMServiceBindOptions {
  readonly source: LLMSource
  readonly agentId?: string | null
  // Fired once per chain advance. Reused by the agent layer to emit the
  // existing `model_fallback` EvalEvent kind.
  readonly onChainSwitch?: (preferred: string, effective: string, reason: string) => void
  // Per-call-site override. Empty array disables chain walk entirely;
  // undefined falls through to the system default chain.
  readonly fallbackChain?: ReadonlyArray<string>
}

// === Failure shape attached to thrown errors ===

export interface LLMServiceFailure {
  readonly attempts: ReadonlyArray<ProviderAttemptRecord>
  readonly primaryCode: string
  readonly primaryReason: string
  // Derived from attempts[] — actionable for the user, not a fixed string.
  readonly remediation: string
}

// === Service ===

export interface LLMService {
  // Returns a standard LLMProvider with the supplied options baked in. All
  // resilience (cooldown skip, chain walk, network retry, content strip,
  // observability) is automatic on the returned provider's chat/stream.
  readonly bound: (opts: LLMServiceBindOptions) => LLMProvider
}

// === Implementation ===

const COOLDOWN_SKIP_GUARD_MS = 1_000
const NETWORK_RETRY_BACKOFF_MS = 250

const THINK_BLOCK_RE = /<think>[\s\S]*?<\/think>/g

// Bare network errors that warrant one in-place retry on the same chain
// element before advancing. Classified provider errors (CloudProviderError,
// GatewayError) carry their own code and skip this path.
const isBareNetworkError = (err: unknown): boolean => {
  if (err instanceof Error && (err as { kind?: string }).kind) return false  // structured error
  if (!(err instanceof Error)) return false
  return /ECONNRESET|ETIMEDOUT|EPIPE|ECONNREFUSED|fetch failed|network/i.test(err.message)
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

export interface LLMServiceDeps {
  readonly router: ProviderRouter
  // Read at request time so UI edits to the system chain take effect
  // without restart.
  readonly getSystemChain?: () => ReadonlyArray<string> | undefined
  readonly now?: () => number
}

export const createLLMService = (deps: LLMServiceDeps): LLMService => {
  const now = deps.now ?? Date.now
  const router = deps.router
  const getSystemChain = deps.getSystemChain ?? (() => undefined)

  // Reorder candidates: if primary is doomed by monitor state and chain is
  // non-empty, demote primary to last so we still try it if the chain
  // exhausts and the backoff ends mid-flight.
  const buildAttemptOrder = (request: ChatRequest, chain: ReadonlyArray<string>): ReadonlyArray<string> => {
    const { provider: primaryProvider } = parsePrefixedModel(request.model)
    const monitor = router.getMonitorSnapshot()
    const skip = shouldSkipPrimary(primaryProvider, monitor, now())
    if (skip && chain.length > 0) return [...chain, request.model]
    return [request.model, ...chain]
  }

  const logLine = (
    source: LLMSource,
    path: 'chat' | 'stream',
    request: ChatRequest,
    response: { provider?: string; promptTokens?: number; completionTokens?: number; cacheRead?: number; durationMs: number; chunksEmit?: number; toolCalls?: number; contentLen?: number },
  ): void => {
    console.log(
      `[llm] source=${source} path=${path} provider=${response.provider ?? '?'} ` +
      `model=${request.model} content_len=${response.contentLen ?? '?'} tools=${response.toolCalls ?? 0} ` +
      `prompt_tokens=${response.promptTokens ?? '?'} completion_tokens=${response.completionTokens ?? '?'} ` +
      `cache_read=${response.cacheRead ?? '?'} chunks_emit=${response.chunksEmit ?? '?'} ` +
      `duration_ms=${response.durationMs}`,
    )
  }

  const resolveChain = (override: ReadonlyArray<string> | undefined): ReadonlyArray<string> => {
    if (override !== undefined) return override
    return getSystemChain() ?? []
  }

  const finalizeFailure = (
    attempts: ReadonlyArray<ProviderAttemptRecord>,
    firstFallbackable: { code: string; reason: string } | null,
    hasChain: boolean,
    modelRef: string,
    lastError: unknown,
  ): never => {
    const failure: LLMServiceFailure = {
      attempts,
      primaryCode: firstFallbackable?.code ?? 'unknown',
      primaryReason: firstFallbackable?.reason ?? '',
      remediation: buildRemediation(attempts, hasChain, modelRef),
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError)
    const out = new Error(message)
    Object.assign(out, failure)
    if (lastError && typeof lastError === 'object' && 'code' in lastError) {
      Object.assign(out, { code: (lastError as { code?: string }).code })
    }
    throw out
  }

  const callChat = async (request: ChatRequest, opts: LLMServiceBindOptions): Promise<ChatResponse> => {
    const chain = dedupChain(request.model, resolveChain(opts.fallbackChain))
    const order = buildAttemptOrder(request, chain)
    const allAttempts: ProviderAttemptRecord[] = []
    let lastError: unknown
    let firstFallbackable: { code: string; reason: string } | null = null

    for (let idx = 0; idx < order.length; idx++) {
      const model = order[idx]!
      if (idx > 0) opts.onChainSwitch?.(request.model, model, 'preferred_unavailable')
      const attemptRequest = { ...request, model }

      // Up to 2 tries per chain element (1 retry on bare network error only).
      for (let tryNo = 0; tryNo < 2; tryNo++) {
        const startMs = performance.now()
        try {
          const routerOpts: RouterCallOptions = {
            ...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
          }
          const response = await router.chat(attemptRequest, routerOpts)
          const durationMs = Math.round(performance.now() - startMs)
          logLine(opts.source, 'chat', attemptRequest, {
            provider: response.provider,
            promptTokens: response.tokensUsed.prompt,
            completionTokens: response.tokensUsed.completion,
            cacheRead: response.tokensUsed.cacheRead,
            durationMs,
            contentLen: response.content.length,
            toolCalls: response.toolCalls?.length ?? 0,
          })
          return { ...response, content: response.content.replace(THINK_BLOCK_RE, '') }
        } catch (err) {
          lastError = err
          const errObj = err as { code?: string; message?: string }
          if (typeof errObj.code === 'string' && firstFallbackable === null) {
            firstFallbackable = { code: errObj.code, reason: errObj.message ?? '' }
          }
          const errAttempts = (err as { attempts?: ProviderAttemptRecord[] }).attempts
          if (Array.isArray(errAttempts)) allAttempts.push(...errAttempts)

          if (tryNo === 0 && isBareNetworkError(err)) {
            await new Promise(r => setTimeout(r, NETWORK_RETRY_BACKOFF_MS))
            continue   // retry same chain element
          }
          break  // advance to next chain element (or finalize)
        }
      }
      if (!classifyIsAgentFallbackable(lastError)) break
    }
    return finalizeFailure(allAttempts, firstFallbackable, chain.length > 0, request.model, lastError)
  }

  const callStream = async function* (
    request: ChatRequest,
    signal: AbortSignal | undefined,
    opts: LLMServiceBindOptions,
  ): AsyncIterable<StreamChunk> {
    const chain = dedupChain(request.model, resolveChain(opts.fallbackChain))
    const order = buildAttemptOrder(request, chain)
    const allAttempts: ProviderAttemptRecord[] = []
    let lastError: unknown
    let firstFallbackable: { code: string; reason: string } | null = null

    for (let idx = 0; idx < order.length; idx++) {
      const model = order[idx]!
      if (idx > 0) opts.onChainSwitch?.(request.model, model, 'preferred_unavailable')
      const attemptRequest = { ...request, model }

      for (let tryNo = 0; tryNo < 2; tryNo++) {
        const startMs = performance.now()
        const routerOpts: RouterCallOptions = {
          ...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
        }
        let chunkCount = 0, contentLen = 0, toolCallCount = 0
        let promptTokens: number | undefined, completionTokens: number | undefined, cacheRead: number | undefined
        let providerName: string | undefined
        let firstChunkSeen = false
        let pendingThinkBuf = ''     // only flushed AFTER strip; tiny since blocks are bounded

        try {
          const stream = router.stream(attemptRequest, signal, routerOpts)
          for await (const chunk of stream) {
            firstChunkSeen = true
            if (chunk.delta) {
              pendingThinkBuf += chunk.delta
              // Emit only once a complete <think> block has either landed
              // (strip+emit remainder) or we're confident no more is incoming.
              // Pragmatic compromise: keep the buffer to ≤4 KB and emit
              // anything beyond that, stripped of any complete think blocks.
              if (pendingThinkBuf.length > 4096 || !pendingThinkBuf.includes('<think>')) {
                const cleaned = pendingThinkBuf.replace(THINK_BLOCK_RE, '')
                if (cleaned) {
                  contentLen += cleaned.length
                  chunkCount++
                  yield { ...chunk, delta: cleaned }
                }
                pendingThinkBuf = ''
              }
            } else {
              if (chunk.done) {
                // Flush remaining buffer with strip, then emit done.
                const cleaned = pendingThinkBuf.replace(THINK_BLOCK_RE, '')
                if (cleaned) {
                  contentLen += cleaned.length
                  chunkCount++
                  yield { delta: cleaned, done: false }
                }
                pendingThinkBuf = ''
                toolCallCount = chunk.toolCalls?.length ?? 0
                promptTokens = chunk.tokensUsed?.prompt
                completionTokens = chunk.tokensUsed?.completion
                cacheRead = chunk.tokensUsed?.cacheRead
                providerName = chunk.provider
              }
              yield chunk
            }
          }
          const durationMs = Math.round(performance.now() - startMs)
          logLine(opts.source, 'stream', attemptRequest, {
            provider: providerName, promptTokens, completionTokens, cacheRead,
            durationMs, chunksEmit: chunkCount, toolCalls: toolCallCount, contentLen,
          })
          return
        } catch (err) {
          lastError = err
          const errObj = err as { code?: string; message?: string }
          if (typeof errObj.code === 'string' && firstFallbackable === null) {
            firstFallbackable = { code: errObj.code, reason: errObj.message ?? '' }
          }
          const errAttempts = (err as { attempts?: ProviderAttemptRecord[] }).attempts
          if (Array.isArray(errAttempts)) allAttempts.push(...errAttempts)
          // Mid-stream failure: cannot recover — caller already received chunks.
          if (firstChunkSeen) throw err
          if (tryNo === 0 && isBareNetworkError(err)) {
            await new Promise(r => setTimeout(r, NETWORK_RETRY_BACKOFF_MS))
            continue
          }
          break
        }
      }
      if (!classifyIsAgentFallbackable(lastError)) break
    }
    return finalizeFailure(allAttempts, firstFallbackable, chain.length > 0, request.model, lastError)
  }

  return {
    bound: (opts) => ({
      chat: (req) => callChat(req, opts),
      stream: (req, signal) => callStream(req, signal, opts),
      models: () => router.models(),
    }),
  }
}
