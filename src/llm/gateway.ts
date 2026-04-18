// ============================================================================
// Ollama Gateway — provider gateway + Ollama-specific extensions.
//
// Composes the generic provider gateway (semaphore / circuit breaker /
// metrics) with Ollama-specific features:
//   - keep_alive injection into chat requests
//   - loadModel / unloadModel helpers
//   - periodic ps-based health poller that tracks loadedModels in VRAM
//   - Ollama-template-token sanitisation is handled inside ollama.ts itself
// ============================================================================

import type {
  ChatRequest,
  CircuitState, RequestStatus, RequestRecord, GatewayMetrics, LoadedModel,
  OllamaHealth, ProviderHealth, OllamaHealthExtra,
} from '../core/types/llm.ts'
import type { OllamaPsModel, OllamaProviderExtended } from './ollama.ts'
import { isOllamaError, isPermanent } from './errors.ts'
import {
  createProviderGateway,
  PROVIDER_GATEWAY_DEFAULTS,
  type ProviderGatewayConfig, type ProviderGateway,
  type ChatCallOptions, type HealthChangeCallback,
} from './provider-gateway.ts'

// Re-export for legacy import paths.
export type {
  CircuitState, RequestStatus, RequestRecord, GatewayMetrics, LoadedModel,
  OllamaHealth, ProviderHealth, OllamaHealthExtra,
  ProviderGateway, ChatCallOptions,
}
export { createProviderGateway }

// === Configuration ===

export interface OllamaGatewayConfig extends ProviderGatewayConfig {
  readonly keepAlive: string
  readonly healthPollIntervalMs: number
}

export const GATEWAY_DEFAULTS: OllamaGatewayConfig = {
  ...PROVIDER_GATEWAY_DEFAULTS,
  keepAlive: '30m',
  healthPollIntervalMs: 15_000,
}

// === Gateway Interface ===

export interface OllamaGateway extends Omit<ProviderGateway, 'getHealth' | 'getConfig' | 'updateConfig' | 'onHealthChange' | 'chat' | 'stream'> {
  readonly chat: ProviderGateway['chat']
  readonly stream: ProviderGateway['stream']
  readonly getHealth: () => OllamaHealth
  readonly getConfig: () => OllamaGatewayConfig
  readonly updateConfig: (partial: Partial<OllamaGatewayConfig>) => void
  readonly onHealthChange: (cb: HealthChangeCallback<OllamaHealth>) => void
  readonly loadModel: (name: string) => Promise<void>
  readonly unloadModel: (name: string) => Promise<void>
  readonly refreshHealth: () => void
}

// Back-compat alias — existing call sites use LLMGateway / createLLMGateway.
export type LLMGateway = OllamaGateway

// === Factory ===

export const createOllamaGateway = (
  provider: OllamaProviderExtended,
  configOverrides?: Partial<OllamaGatewayConfig>,
): OllamaGateway => {
  let config: OllamaGatewayConfig = { ...GATEWAY_DEFAULTS, ...configOverrides }

  const enrichRequest = (request: ChatRequest): ChatRequest =>
    ({ ...request, keepAlive: config.keepAlive } as ChatRequest)

  const providerIsPermanent = (err: unknown): boolean =>
    isOllamaError(err) && isPermanent(err)

  const base = createProviderGateway(
    provider,
    config,
    { isPermanentError: providerIsPermanent, enrichRequest },
  )

  // Ollama-specific health extras (tracked alongside the base ProviderHealth)
  let extras: OllamaHealthExtra = { loadedModels: [] }
  const ollamaHealthCallbacks: Array<HealthChangeCallback<OllamaHealth>> = []

  const combine = (baseHealth: ProviderHealth): OllamaHealth =>
    ({ ...baseHealth, ...extras })

  const notifyCombined = (): void => {
    const combined = combine(base.getHealth())
    for (const cb of ollamaHealthCallbacks) {
      try { cb(combined) } catch { /* ignore */ }
    }
  }

  base.onHealthChange(() => notifyCombined())

  // === ps-driven health poll (Ollama-specific) ===
  // Refreshes availableModels via the generic gateway, then layers in
  // loadedModels from `ollama ps`. Two calls, one per Ollama endpoint.
  const pollHealth = async (): Promise<void> => {
    try {
      const loaded = await provider.runningModelsDetailed()
        .catch(() => [] as ReadonlyArray<OllamaPsModel>)
      const loadedModels: LoadedModel[] = loaded.map(m => ({
        name: m.name,
        sizeVram: m.size_vram,
        details: m.details ? {
          parameterSize: m.details.parameter_size,
          quantizationLevel: m.details.quantization_level,
        } : undefined,
        expiresAt: m.expires_at,
      }))
      extras = { loadedModels }
      await base.refreshModels()
      notifyCombined()
    } catch {
      // Transient — keep previous state.
    }
  }

  let pollTimer: ReturnType<typeof setInterval> | undefined
  const startPoller = (): void => {
    void pollHealth()
    pollTimer = setInterval(() => void pollHealth(), config.healthPollIntervalMs)
  }
  startPoller()

  const loadModel = async (name: string): Promise<void> => {
    await provider.loadModel(name, config.keepAlive)
    await pollHealth()
  }

  const unloadModel = async (name: string): Promise<void> => {
    await provider.unloadModel(name)
    await pollHealth()
  }

  const updateConfig = (partial: Partial<OllamaGatewayConfig>): void => {
    const baseKeys: Array<keyof ProviderGatewayConfig> = [
      'maxConcurrent', 'maxQueueDepth', 'queueTimeoutMs',
      'circuitBreakerThreshold', 'circuitBreakerCooldownMs',
    ]
    const basePartial: Partial<ProviderGatewayConfig> = {}
    for (const k of baseKeys) {
      if (partial[k] !== undefined) (basePartial as Record<string, unknown>)[k] = partial[k]
    }
    base.updateConfig(basePartial)

    config = { ...config, ...partial }
    if (partial.healthPollIntervalMs !== undefined && pollTimer) {
      clearInterval(pollTimer)
      pollTimer = setInterval(() => void pollHealth(), config.healthPollIntervalMs)
    }
  }

  const dispose = (): void => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined }
    base.dispose()
  }

  return {
    chat: base.chat,
    stream: base.stream,
    models: base.models,
    runningModels: base.runningModels,
    getMetrics: base.getMetrics,
    getHealth: () => combine(base.getHealth()),
    getConfig: () => ({ ...config }),
    updateConfig,
    onHealthChange: (cb) => { ollamaHealthCallbacks.push(cb) },
    resetCircuitBreaker: base.resetCircuitBreaker,
    refreshModels: base.refreshModels,
    recordExternalFailure: base.recordExternalFailure,
    loadModel,
    unloadModel,
    refreshHealth: () => { void pollHealth() },
    dispose,
  }
}

// Back-compat alias so existing call sites compile unchanged.
export const createLLMGateway = createOllamaGateway
