// ============================================================================
// Provider Gateway — provider-neutral concurrency, resilience, and observability.
//
// Wraps any LLMProvider with a bounded semaphore, circuit breaker, metrics
// ring buffer, and event-driven health. No Ollama-specific behaviour.
// Used by cloud providers (OpenAI-compatible) that update availableModels
// lazily (via refreshModels) rather than on a periodic poll, to avoid
// consuming their rate-limit budget.
// ============================================================================

import type {
  LLMProvider, ChatRequest, ChatResponse, StreamChunk,
  CircuitState, RequestStatus, RequestRecord, GatewayMetrics, ProviderHealth,
} from '../core/types/llm.ts'
import { createCircuitBreaker } from './circuit-breaker.ts'
import { createGatewayError, isGatewayError } from './errors.ts'
import { createRingBuffer, createSemaphore } from './concurrency.ts'

export type { CircuitState, RequestStatus, RequestRecord, GatewayMetrics, ProviderHealth }

// === Configuration ===

export interface ProviderGatewayConfig {
  readonly maxConcurrent: number
  readonly maxQueueDepth: number
  readonly queueTimeoutMs: number
  readonly circuitBreakerThreshold: number
  readonly circuitBreakerCooldownMs: number
}

export const PROVIDER_GATEWAY_DEFAULTS: ProviderGatewayConfig = {
  maxConcurrent: 2,
  maxQueueDepth: 6,
  queueTimeoutMs: 30_000,
  circuitBreakerThreshold: 5,
  circuitBreakerCooldownMs: 15_000,
}

// === Per-invocation overrides ===
// Failover routers invoke with maxQueueDepth=0 to shed immediately instead of
// waiting for a slot on a saturated provider.
export interface ChatCallOptions {
  readonly maxQueueDepth?: number
}

// === Predicate injection for permanent-error classification ===
// Ollama uses 4xx → permanent; cloud providers override with auth/quota logic.
export type IsPermanentError = (err: unknown) => boolean

// === Gateway Interface ===

export type HealthChangeCallback<H extends ProviderHealth = ProviderHealth> = (health: H) => void

export interface ProviderGateway extends LLMProvider {
  readonly chat: (request: ChatRequest, options?: ChatCallOptions) => Promise<ChatResponse>
  readonly getMetrics: () => GatewayMetrics
  readonly getHealth: () => ProviderHealth
  readonly getConfig: () => ProviderGatewayConfig
  readonly updateConfig: (partial: Partial<ProviderGatewayConfig>) => void
  readonly onHealthChange: (cb: HealthChangeCallback) => void
  readonly resetCircuitBreaker: () => void
  readonly refreshModels: () => Promise<void>
  readonly recordExternalFailure: () => void
  readonly dispose: () => void
}

// === Percentile ===

const percentile = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return 0
  const idx = Math.ceil(sorted.length * p) - 1
  return sorted[Math.max(0, idx)] ?? 0
}

// === Factory ===

export interface ProviderGatewayDeps {
  readonly isPermanentError?: IsPermanentError
  readonly enrichRequest?: (request: ChatRequest) => ChatRequest
}

export const createProviderGateway = (
  provider: LLMProvider,
  configOverrides?: Partial<ProviderGatewayConfig>,
  deps: ProviderGatewayDeps = {},
): ProviderGateway => {
  let config: ProviderGatewayConfig = { ...PROVIDER_GATEWAY_DEFAULTS, ...configOverrides }
  const isPermanent = deps.isPermanentError ?? (() => false)
  const enrich = deps.enrichRequest ?? ((r: ChatRequest) => r)

  const semaphore = createSemaphore(config.maxConcurrent)
  const metrics = createRingBuffer<RequestRecord>(200)
  let shedCount = 0

  const cb = createCircuitBreaker(
    { threshold: config.circuitBreakerThreshold, cooldownMs: config.circuitBreakerCooldownMs },
    { onStateChange: () => checkHealthTransition() },
  )

  let health: ProviderHealth = {
    status: 'healthy',
    latencyMs: 0,
    availableModels: [],
    lastCheckedAt: 0,
  }

  const healthChangeCallbacks: HealthChangeCallback[] = []

  const emitHealth = (next: ProviderHealth): void => {
    health = next
    for (const cb2 of healthChangeCallbacks) {
      try { cb2(health) } catch { /* ignore callback errors */ }
    }
  }

  const checkHealthTransition = (): void => {
    const prevStatus = health.status
    let newStatus: ProviderHealth['status'] = 'healthy'
    const cbState = cb.getState()
    if (cbState === 'open') newStatus = 'down'
    else if (cbState === 'half_open') newStatus = 'degraded'
    else if (health.latencyMs > 10_000) newStatus = 'degraded'
    if (newStatus !== prevStatus) emitHealth({ ...health, status: newStatus })
  }

  const chat = async (request: ChatRequest, options?: ChatCallOptions): Promise<ChatResponse> => {
    if (!cb.shouldAllow()) {
      shedCount++
      metrics.push({
        model: request.model, promptTokens: 0, completionTokens: 0,
        durationMs: 0, queueWaitMs: 0, tokensPerSecond: 0,
        status: 'circuit_open', timestamp: Date.now(),
      })
      throw createGatewayError('circuit_open', `Circuit breaker open (${cb.getConsecutiveFailures()} consecutive failures)`)
    }

    const queueDepth = options?.maxQueueDepth ?? config.maxQueueDepth
    let queueWaitMs: number
    try {
      queueWaitMs = await semaphore.acquire(config.queueTimeoutMs, queueDepth)
    } catch (err) {
      shedCount++
      const status: RequestStatus = isGatewayError(err) && err.code === 'queue_full' ? 'shed' : 'timeout'
      metrics.push({
        model: request.model, promptTokens: 0, completionTokens: 0,
        durationMs: 0, queueWaitMs: 0, tokensPerSecond: 0,
        status, timestamp: Date.now(),
      })
      throw err
    }

    const startMs = performance.now()
    try {
      const response = await provider.chat(enrich(request))
      cb.recordSuccess()
      const durationMs = Math.round(performance.now() - startMs)
      metrics.push({
        model: request.model,
        promptTokens: response.tokensUsed.prompt,
        completionTokens: response.tokensUsed.completion,
        durationMs, queueWaitMs,
        tokensPerSecond: response.tokensPerSecond ?? 0,
        status: 'success', timestamp: Date.now(),
      })
      emitHealth({ ...health, latencyMs: durationMs, lastCheckedAt: Date.now() })
      return response
    } catch (err) {
      if (!isPermanent(err)) cb.recordFailure()
      const durationMs = Math.round(performance.now() - startMs)
      metrics.push({
        model: request.model, promptTokens: 0, completionTokens: 0,
        durationMs, queueWaitMs, tokensPerSecond: 0,
        status: 'error', timestamp: Date.now(),
      })
      throw err
    } finally {
      semaphore.release()
    }
  }

  const stream = async function* (request: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamChunk> {
    if (!provider.stream) throw createGatewayError('not_supported', 'Provider does not support streaming')
    if (!cb.shouldAllow()) {
      shedCount++
      throw createGatewayError('circuit_open', 'Circuit breaker open')
    }
    const queueWaitMs = await semaphore.acquire(config.queueTimeoutMs, config.maxQueueDepth)
    const startMs = performance.now()
    try {
      yield* provider.stream(enrich(request), signal)
      cb.recordSuccess()
      metrics.push({
        model: request.model, promptTokens: 0, completionTokens: 0,
        durationMs: Math.round(performance.now() - startMs),
        queueWaitMs, tokensPerSecond: 0,
        status: 'success', timestamp: Date.now(),
      })
    } catch (err) {
      if (!isPermanent(err)) cb.recordFailure()
      metrics.push({
        model: request.model, promptTokens: 0, completionTokens: 0,
        durationMs: Math.round(performance.now() - startMs),
        queueWaitMs, tokensPerSecond: 0,
        status: 'error', timestamp: Date.now(),
      })
      throw err
    } finally {
      semaphore.release()
    }
  }

  const refreshModels = async (): Promise<void> => {
    try {
      const list = await provider.models()
      emitHealth({ ...health, availableModels: list, lastCheckedAt: Date.now() })
    } catch {
      // Leave availableModels unchanged; transient failure shouldn't clear the cache.
    }
  }

  const models = async (): Promise<string[]> => {
    if (health.availableModels.length > 0) return [...health.availableModels]
    await refreshModels()
    return [...health.availableModels]
  }

  const runningModels = async (): Promise<string[]> =>
    provider.runningModels?.() ?? []

  const getMetrics = (): GatewayMetrics => {
    const windowMs = 5 * 60 * 1000
    const cutoff = Date.now() - windowMs
    const recent = metrics.toArray().filter(r => r.timestamp >= cutoff)
    const requestCount = recent.length
    const errorCount = recent.filter(r => r.status !== 'success').length
    const errorRate = requestCount > 0 ? errorCount / requestCount : 0
    const durations = recent.filter(r => r.status === 'success').map(r => r.durationMs).sort((a, b) => a - b)
    const tpsValues = recent.filter(r => r.tokensPerSecond > 0).map(r => r.tokensPerSecond)
    const avgTps = tpsValues.length > 0 ? tpsValues.reduce((a, b) => a + b, 0) / tpsValues.length : 0
    return {
      requestCount, errorCount,
      errorRate: Math.round(errorRate * 100) / 100,
      p50Latency: percentile(durations, 0.5),
      p95Latency: percentile(durations, 0.95),
      avgTokensPerSecond: Math.round(avgTps * 10) / 10,
      queueDepth: semaphore.queueDepth,
      concurrentRequests: semaphore.active,
      circuitState: cb.getState(),
      shedCount, windowMs,
    }
  }

  const updateConfig = (partial: Partial<ProviderGatewayConfig>): void => {
    config = { ...config, ...partial }
    if (partial.maxConcurrent !== undefined) semaphore.updateMax(partial.maxConcurrent)
    if (partial.circuitBreakerThreshold !== undefined || partial.circuitBreakerCooldownMs !== undefined) {
      cb.updateConfig({
        ...(partial.circuitBreakerThreshold !== undefined ? { threshold: partial.circuitBreakerThreshold } : {}),
        ...(partial.circuitBreakerCooldownMs !== undefined ? { cooldownMs: partial.circuitBreakerCooldownMs } : {}),
      })
    }
  }

  return {
    chat, stream, models, runningModels,
    getMetrics,
    getHealth: () => health,
    getConfig: () => ({ ...config }),
    updateConfig,
    onHealthChange: (cb2) => { healthChangeCallbacks.push(cb2) },
    resetCircuitBreaker: () => cb.reset(),
    refreshModels,
    recordExternalFailure: () => cb.recordFailure(),
    dispose: () => { /* no owned timers */ },
  }
}
