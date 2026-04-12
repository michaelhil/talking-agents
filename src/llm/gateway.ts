// ============================================================================
// LLM Gateway — Concurrency, resilience, and observability for Ollama.
//
// Self-contained module with no Samsinn-specific imports. Wraps any LLMProvider
// with a semaphore, circuit breaker, metrics ring buffer, and health poller.
// Portable to any TypeScript project using Ollama.
// ============================================================================

import type { LLMProvider, ChatRequest, ChatResponse, StreamChunk } from '../core/types.ts'
import type { OllamaPsModel, OllamaProviderExtended } from './ollama.ts'

// === Configuration ===

export interface GatewayConfig {
  readonly maxConcurrent: number
  readonly maxQueueDepth: number
  readonly queueTimeoutMs: number
  readonly circuitBreakerThreshold: number
  readonly circuitBreakerCooldownMs: number
  readonly keepAlive: string
  readonly healthPollIntervalMs: number
}

export const GATEWAY_DEFAULTS: GatewayConfig = {
  maxConcurrent: 2,
  maxQueueDepth: 6,
  queueTimeoutMs: 30_000,
  circuitBreakerThreshold: 5,
  circuitBreakerCooldownMs: 15_000,
  keepAlive: '30m',
  healthPollIntervalMs: 15_000,
}

// === Metrics ===

export type RequestStatus = 'success' | 'error' | 'timeout' | 'circuit_open' | 'shed'

export interface RequestRecord {
  readonly model: string
  readonly promptTokens: number
  readonly completionTokens: number
  readonly durationMs: number
  readonly queueWaitMs: number
  readonly tokensPerSecond: number
  readonly status: RequestStatus
  readonly timestamp: number
}

export interface GatewayMetrics {
  readonly requestCount: number
  readonly errorCount: number
  readonly errorRate: number
  readonly p50Latency: number
  readonly p95Latency: number
  readonly avgTokensPerSecond: number
  readonly queueDepth: number
  readonly concurrentRequests: number
  readonly circuitState: CircuitState
  readonly shedCount: number
  readonly windowMs: number
}

// === Health ===

export interface LoadedModel {
  readonly name: string
  readonly sizeVram: number
  readonly details?: {
    readonly parameterSize?: string
    readonly quantizationLevel?: string
  }
  readonly expiresAt?: string
}

export interface OllamaHealth {
  readonly status: 'healthy' | 'degraded' | 'down'
  readonly latencyMs: number
  readonly loadedModels: ReadonlyArray<LoadedModel>
  readonly availableModels: ReadonlyArray<string>
  readonly lastCheckedAt: number
}

// === Circuit Breaker ===

type CircuitState = 'closed' | 'open' | 'half_open'

interface CircuitBreaker {
  state: CircuitState
  consecutiveFailures: number
  lastFailureAt: number
  openedAt: number
}

// === Gateway Interface ===

export type HealthChangeCallback = (health: OllamaHealth) => void

export interface LLMGateway extends LLMProvider {
  readonly getMetrics: () => GatewayMetrics
  readonly getHealth: () => OllamaHealth
  readonly getConfig: () => GatewayConfig
  readonly updateConfig: (partial: Partial<GatewayConfig>) => void
  readonly loadModel: (name: string) => Promise<void>
  readonly unloadModel: (name: string) => Promise<void>
  readonly onHealthChange: (cb: HealthChangeCallback) => void
  readonly resetCircuitBreaker: () => void
  readonly dispose: () => void
}

// === Ring Buffer ===

const createRingBuffer = <T>(capacity: number) => {
  const items: T[] = []
  let head = 0
  let count = 0

  const push = (item: T): void => {
    if (count < capacity) {
      items.push(item)
      count++
    } else {
      items[head] = item
      head = (head + 1) % capacity
    }
  }

  const toArray = (): T[] => {
    if (count < capacity) return items.slice()
    return [...items.slice(head), ...items.slice(0, head)]
  }

  const clear = (): void => {
    items.length = 0
    head = 0
    count = 0
  }

  return { push, toArray, clear, get count() { return count } }
}

// === Semaphore ===

interface QueuedRequest {
  readonly resolve: () => void
  readonly reject: (err: Error) => void
  readonly enqueuedAt: number
}

const createSemaphore = (max: number) => {
  let active = 0
  const queue: QueuedRequest[] = []

  const acquire = async (timeoutMs: number, maxQueueDepth: number): Promise<number> => {
    const enqueuedAt = performance.now()
    if (active < max) {
      active++
      return 0 // no queue wait
    }
    if (queue.length >= maxQueueDepth) {
      throw new GatewayError('queue_full', 'LLM gateway queue full — request shed')
    }
    return new Promise<number>((resolve, reject) => {
      const entry: QueuedRequest = {
        resolve: () => resolve(Math.round(performance.now() - enqueuedAt)),
        reject,
        enqueuedAt,
      }
      queue.push(entry)
      setTimeout(() => {
        const idx = queue.indexOf(entry)
        if (idx !== -1) {
          queue.splice(idx, 1)
          reject(new GatewayError('queue_timeout', `LLM gateway queue timeout after ${timeoutMs}ms`))
        }
      }, timeoutMs)
    })
  }

  const release = (): void => {
    const next = queue.shift()
    if (next) {
      next.resolve()
    } else {
      active--
    }
  }

  return {
    acquire,
    release,
    get active() { return active },
    get queueDepth() { return queue.length },
    updateMax: (newMax: number) => { max = newMax },
  }
}

// === Gateway Error ===

export class GatewayError extends Error {
  constructor(readonly code: 'circuit_open' | 'queue_full' | 'queue_timeout', message: string) {
    super(message)
    this.name = 'GatewayError'
  }
}

// === Percentile Computation ===

const percentile = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return 0
  const idx = Math.ceil(sorted.length * p) - 1
  return sorted[Math.max(0, idx)] ?? 0
}

// === Factory ===

export const createLLMGateway = (
  provider: OllamaProviderExtended,
  configOverrides?: Partial<GatewayConfig>,
): LLMGateway => {
  let config: GatewayConfig = { ...GATEWAY_DEFAULTS, ...configOverrides }

  const semaphore = createSemaphore(config.maxConcurrent)
  const metrics = createRingBuffer<RequestRecord>(200)
  let shedCount = 0

  // Circuit breaker
  const cb: CircuitBreaker = {
    state: 'closed',
    consecutiveFailures: 0,
    lastFailureAt: 0,
    openedAt: 0,
  }

  const tripCircuit = (): void => {
    cb.state = 'open'
    cb.openedAt = Date.now()
    checkHealthTransition()
  }

  const resetCircuit = (): void => {
    cb.state = 'closed'
    cb.consecutiveFailures = 0
    checkHealthTransition()
  }

  const recordSuccess = (): void => {
    if (cb.state === 'half_open') resetCircuit()
    else cb.consecutiveFailures = 0
  }

  const recordFailure = (): void => {
    cb.consecutiveFailures++
    cb.lastFailureAt = Date.now()
    if (cb.state === 'half_open') {
      tripCircuit()
    } else if (cb.consecutiveFailures >= config.circuitBreakerThreshold) {
      tripCircuit()
    }
  }

  const shouldAllowRequest = (): boolean => {
    if (cb.state === 'closed') return true
    if (cb.state === 'open') {
      if (Date.now() - cb.openedAt >= config.circuitBreakerCooldownMs) {
        cb.state = 'half_open'
        return true // allow one probe
      }
      return false
    }
    // half_open: only one request at a time (the probe)
    return false
  }

  // Health state
  let health: OllamaHealth = {
    status: 'healthy',
    latencyMs: 0,
    loadedModels: [],
    availableModels: [],
    lastCheckedAt: 0,
  }

  const healthChangeCallbacks: HealthChangeCallback[] = []

  const checkHealthTransition = (): void => {
    const prevStatus = health.status
    let newStatus: OllamaHealth['status'] = 'healthy'
    if (cb.state === 'open') newStatus = 'down'
    else if (cb.state === 'half_open') newStatus = 'degraded'
    else if (health.latencyMs > 10_000) newStatus = 'degraded'

    if (newStatus !== prevStatus) {
      health = { ...health, status: newStatus }
      for (const cb2 of healthChangeCallbacks) {
        try { cb2(health) } catch { /* ignore callback errors */ }
      }
    }
  }

  // Health poller
  const pollHealth = async (): Promise<void> => {
    try {
      const [loaded, available] = await Promise.all([
        provider.runningModelsDetailed().catch(() => [] as ReadonlyArray<OllamaPsModel>),
        provider.models().catch(() => [] as string[]),
      ])

      const loadedModels: LoadedModel[] = loaded.map(m => ({
        name: m.name,
        sizeVram: m.size_vram,
        details: m.details ? {
          parameterSize: m.details.parameter_size,
          quantizationLevel: m.details.quantization_level,
        } : undefined,
        expiresAt: m.expires_at,
      }))

      // Use most recent request latency if available, otherwise keep previous
      const recentRecords = metrics.toArray()
      const lastSuccess = recentRecords.filter(r => r.status === 'success').pop()
      const latencyMs = lastSuccess?.durationMs ?? health.latencyMs

      health = {
        ...health,
        latencyMs,
        loadedModels,
        availableModels: available,
        lastCheckedAt: Date.now(),
      }
      checkHealthTransition()
    } catch {
      // Poller failure — if circuit is already open, health is already 'down'
      if (cb.state === 'closed') {
        health = { ...health, lastCheckedAt: Date.now() }
      }
    }
  }

  let pollTimer: ReturnType<typeof setInterval> | undefined
  const startPoller = (): void => {
    pollHealth() // initial poll
    pollTimer = setInterval(pollHealth, config.healthPollIntervalMs)
  }
  startPoller()

  // Wrapped chat with semaphore + circuit breaker + metrics
  const chat = async (request: ChatRequest): Promise<ChatResponse> => {
    if (!shouldAllowRequest()) {
      shedCount++
      metrics.push({
        model: request.model,
        promptTokens: 0,
        completionTokens: 0,
        durationMs: 0,
        queueWaitMs: 0,
        tokensPerSecond: 0,
        status: 'circuit_open',
        timestamp: Date.now(),
      })
      throw new GatewayError('circuit_open', `Circuit breaker open — Ollama appears down (${cb.consecutiveFailures} consecutive failures)`)
    }

    let queueWaitMs: number
    try {
      queueWaitMs = await semaphore.acquire(config.queueTimeoutMs, config.maxQueueDepth)
    } catch (err) {
      shedCount++
      const status: RequestStatus = err instanceof GatewayError && err.code === 'queue_full' ? 'shed' : 'timeout'
      metrics.push({
        model: request.model,
        promptTokens: 0,
        completionTokens: 0,
        durationMs: 0,
        queueWaitMs: 0,
        tokensPerSecond: 0,
        status,
        timestamp: Date.now(),
      })
      throw err
    }

    const startMs = performance.now()
    try {
      // Inject keep_alive into request
      const enrichedRequest = { ...request, keepAlive: config.keepAlive } as ChatRequest
      const response = await provider.chat(enrichedRequest)

      recordSuccess()

      const durationMs = Math.round(performance.now() - startMs)
      metrics.push({
        model: request.model,
        promptTokens: response.tokensUsed.prompt,
        completionTokens: response.tokensUsed.completion,
        durationMs,
        queueWaitMs,
        tokensPerSecond: response.tokensPerSecond ?? 0,
        status: 'success',
        timestamp: Date.now(),
      })

      // Update health latency from real data
      health = { ...health, latencyMs: durationMs }

      return response
    } catch (err) {
      recordFailure()

      const durationMs = Math.round(performance.now() - startMs)
      metrics.push({
        model: request.model,
        promptTokens: 0,
        completionTokens: 0,
        durationMs,
        queueWaitMs,
        tokensPerSecond: 0,
        status: 'error',
        timestamp: Date.now(),
      })

      throw err
    } finally {
      semaphore.release()
    }
  }

  // Wrapped stream — same semaphore + circuit breaker, but metrics recorded at end
  const stream = async function* (request: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamChunk> {
    if (!provider.stream) throw new Error('Provider does not support streaming')

    if (!shouldAllowRequest()) {
      shedCount++
      throw new GatewayError('circuit_open', 'Circuit breaker open')
    }

    const queueWaitMs = await semaphore.acquire(config.queueTimeoutMs, config.maxQueueDepth)
    const startMs = performance.now()

    try {
      const enrichedRequest = { ...request, keepAlive: config.keepAlive } as ChatRequest
      yield* provider.stream(enrichedRequest, signal)
      recordSuccess()

      metrics.push({
        model: request.model,
        promptTokens: 0,
        completionTokens: 0,
        durationMs: Math.round(performance.now() - startMs),
        queueWaitMs,
        tokensPerSecond: 0,
        status: 'success',
        timestamp: Date.now(),
      })
    } catch (err) {
      recordFailure()
      metrics.push({
        model: request.model,
        promptTokens: 0,
        completionTokens: 0,
        durationMs: Math.round(performance.now() - startMs),
        queueWaitMs,
        tokensPerSecond: 0,
        status: 'error',
        timestamp: Date.now(),
      })
      throw err
    } finally {
      semaphore.release()
    }
  }

  // Pass-through model listing (cached by health poller)
  const models = async (): Promise<string[]> => {
    if (health.availableModels.length > 0) return [...health.availableModels]
    return provider.models()
  }

  const runningModels = async (): Promise<string[]> => {
    if (health.loadedModels.length > 0) return health.loadedModels.map(m => m.name)
    return provider.runningModels?.() ?? []
  }

  // Aggregation
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
      requestCount,
      errorCount,
      errorRate: Math.round(errorRate * 100) / 100,
      p50Latency: percentile(durations, 0.5),
      p95Latency: percentile(durations, 0.95),
      avgTokensPerSecond: Math.round(avgTps * 10) / 10,
      queueDepth: semaphore.queueDepth,
      concurrentRequests: semaphore.active,
      circuitState: cb.state,
      shedCount,
      windowMs,
    }
  }

  const getHealth = (): OllamaHealth => health

  const getConfig = (): GatewayConfig => ({ ...config })

  const updateConfig = (partial: Partial<GatewayConfig>): void => {
    config = { ...config, ...partial }
    if (partial.maxConcurrent !== undefined) semaphore.updateMax(partial.maxConcurrent)
    if (partial.healthPollIntervalMs !== undefined && pollTimer) {
      clearInterval(pollTimer)
      pollTimer = setInterval(pollHealth, config.healthPollIntervalMs)
    }
  }

  const loadModel = async (name: string): Promise<void> => {
    await provider.loadModel(name, config.keepAlive)
    await pollHealth() // refresh loaded models
  }

  const unloadModel = async (name: string): Promise<void> => {
    await provider.unloadModel(name)
    await pollHealth()
  }

  const onHealthChange = (cb2: HealthChangeCallback): void => {
    healthChangeCallbacks.push(cb2)
  }

  const dispose = (): void => {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = undefined
    }
  }

  return {
    chat,
    stream,
    models,
    runningModels,
    getMetrics,
    getHealth,
    getConfig,
    updateConfig,
    loadModel,
    unloadModel,
    onHealthChange,
    resetCircuitBreaker: resetCircuit,
    dispose,
  }
}
