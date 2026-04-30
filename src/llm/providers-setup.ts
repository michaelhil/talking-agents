// ============================================================================
// Providers setup — constructs the per-provider gateways and the router
// from a ProviderConfig. Returns the router (used everywhere agents call
// the LLM) plus a direct reference to the Ollama gateway when present
// (needed by the Ollama dashboard UI for ps / loadModel).
// ============================================================================

import type { ProviderGateway } from './provider-gateway.ts'
import { createProviderGateway } from './provider-gateway.ts'
import type { OllamaGateway } from './gateway.ts'
import { createOllamaGateway } from './gateway.ts'
import type { OllamaProviderExtended } from './ollama.ts'
import { createOllamaProvider } from './ollama.ts'
import { createOpenAICompatibleProvider } from './openai-compatible.ts'
import type { ProviderRouter } from './router.ts'
import { createProviderRouter } from './router.ts'
import { isCloudProviderError } from './errors.ts'
import { PROVIDER_PROFILES, type ProviderConfig, type CloudProviderName } from './providers-config.ts'
import { getContextWindow } from './models/context-window.ts'
import type { ProviderKeys } from './provider-keys.ts'
import type { LimitMetrics } from '../core/limit-metrics.ts'
import type { ProviderMonitor } from './provider-monitor.ts'
import { createProviderMonitor } from './provider-monitor.ts'

export interface ProviderSetupResult {
  readonly router: ProviderRouter
  readonly ollama?: OllamaGateway                      // present iff 'ollama' is in order
  readonly ollamaRaw?: OllamaProviderExtended          // raw provider for URL edit UX
  readonly gateways: Record<string, ProviderGateway>   // all gateways in the router
  readonly monitors: Record<string, ProviderMonitor>   // one per gateway
  readonly dispose: () => void
}

export interface BuildProvidersOptions {
  // Keys store — when provided, gateways read keys via getter so runtime key
  // changes take effect without a restart. When absent, we fall back to a
  // static snapshot captured from `config.cloud` (test paths).
  readonly providerKeys?: ProviderKeys
  // Optional process-global counters; threaded into each cloud provider so
  // SSE-buffer overflow (and any future per-provider cap hits) is observable.
  readonly limitMetrics?: LimitMetrics
  // Per-provider baseUrl override. Production never sets this; integration
  // tests use it to redirect a provider's HTTP calls at a local Bun.serve
  // fixture so the boot-shape wiring (real adapter → real gateway → real
  // router) can be exercised end-to-end against a controlled endpoint.
  readonly baseUrlOverrides?: Partial<Record<string, string>>
  // Returns true when the system has at least one connected client. Heartbeats
  // pause when this returns false, so an idle Samsinn (no open tab) consumes
  // zero requests. Defaults to "always active" for tests and headless mode.
  readonly isActive?: () => boolean
}

export const buildProvidersFromConfig = (
  config: ProviderConfig,
  options: BuildProvidersOptions = {},
): ProviderSetupResult => {
  const gateways: Record<string, ProviderGateway> = {}
  let ollama: OllamaGateway | undefined
  let ollamaRaw: OllamaProviderExtended | undefined

  // Ollama gateway (always constructed — even if not in order — so the UI
  // can still probe the URL; the router just won't route to it).
  if (config.order.includes('ollama')) {
    ollamaRaw = createOllamaProvider(config.ollamaUrl)
    ollama = createOllamaGateway(ollamaRaw, { maxConcurrent: config.ollamaMaxConcurrent })
    // OllamaGateway is assignable to ProviderGateway for the shared surface.
    gateways.ollama = ollama as unknown as ProviderGateway
  }

  // Cloud providers — build a gateway for every known profile so that keys
  // added at runtime can activate a provider without server restart. The
  // router skips providers whose current key is empty via `isProviderEnabled`.
  const providerKeys = options.providerKeys
  for (const name of Object.keys(PROVIDER_PROFILES) as CloudProviderName[]) {
    const cc = config.cloud[name]
    const staticKey = cc?.apiKey ?? ''
    const getApiKey = providerKeys
      ? () => providerKeys.get(name)
      : () => staticKey
    const maxConcurrent = cc?.maxConcurrent
    // Anthropic's OpenAI-compat endpoint rejects `Authorization: Bearer ...`
    // and requires `x-api-key` + `anthropic-version` instead.
    const authHeaders = name === 'anthropic'
      ? () => ({
          'x-api-key': getApiKey(),
          'anthropic-version': '2023-06-01',
        })
      : undefined
    const baseUrl = options.baseUrlOverrides?.[name] ?? PROVIDER_PROFILES[name].baseUrl
    const provider = createOpenAICompatibleProvider({
      name,
      baseUrl,
      getApiKey,
      ...(authHeaders ? { authHeaders } : {}),
      ...(options.limitMetrics ? { limitMetrics: options.limitMetrics } : {}),
    })
    gateways[name] = createProviderGateway(
      provider,
      { maxConcurrent },
      { isPermanentError: (err) => isCloudProviderError(err) },
    )
  }

  // One monitor per gateway. The monitor is the single source of truth for
  // routing eligibility ("may we send to provider X right now?") and drives
  // the background heartbeat. Built BEFORE the router so the router can
  // consult it on every call.
  const monitors: Record<string, ProviderMonitor> = {}
  for (const [name, _gw] of Object.entries(gateways)) {
    const kind = name === 'ollama' ? 'ollama' : 'cloud'
    const hasKey = name === 'ollama'
      ? () => true
      : providerKeys
        ? () => providerKeys.get(name).length > 0
        : () => (config.cloud[name as CloudProviderName]?.apiKey ?? '').length > 0
    const isUserEnabled = name === 'ollama'
      ? () => true
      : providerKeys
        ? () => providerKeys.isUserEnabled(name)
        : () => true
    monitors[name] = createProviderMonitor({
      name,
      kind,
      hasKey,
      isUserEnabled,
      ...(options.isActive ? { isActive: options.isActive } : {}),
    })
  }

  const router = createProviderRouter(gateways, {
    order: config.order,
    forceFailProvider: config.forceFailProvider,
    isProviderEnabled: providerKeys
      ? (name) => name === 'ollama' || providerKeys.isEnabled(name)
      : undefined,
    monitors,
    contextLookup: async (provider, model) => {
      const info = await getContextWindow(provider, model, {
        ollamaBaseUrl: config.ollamaUrl,
        openrouterApiKey: options.providerKeys?.get('openrouter') || config.cloud.openrouter?.apiKey,
      })
      return { contextMax: info.contextMax, source: info.source }
    },
  })

  // Start heartbeats now that gateways exist. The monitor caches the
  // gateway reference and schedules its own timer.
  for (const [name, gw] of Object.entries(gateways)) {
    monitors[name]?.start(gw)
  }

  const dispose = (): void => {
    for (const m of Object.values(monitors)) {
      try { m.dispose() } catch { /* best-effort */ }
    }
    router.dispose()
    for (const gw of Object.values(gateways)) {
      try { gw.dispose() } catch { /* best-effort */ }
    }
  }

  return {
    router,
    ...(ollama ? { ollama } : {}),
    ...(ollamaRaw ? { ollamaRaw } : {}),
    gateways,
    monitors,
    dispose,
  }
}

// Warm the `availableModels` cache on every provider. Called once at startup
// so the first router call doesn't optimistically attempt providers that
// don't serve the requested model.
export const warmProviderModels = async (
  gateways: Record<string, ProviderGateway>,
  timeoutMs = 5_000,
): Promise<Record<string, { status: 'ok'; count: number } | { status: 'error'; message: string }>> => {
  const result: Record<string, { status: 'ok'; count: number } | { status: 'error'; message: string }> = {}
  const entries = Object.entries(gateways)
  await Promise.all(entries.map(async ([name, gateway]) => {
    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('models warm-up timeout')), timeoutMs))
      await Promise.race([gateway.refreshModels(), timeout])
      const count = gateway.getHealth().availableModels.length
      result[name] = { status: 'ok', count }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result[name] = { status: 'error', message }
    }
  }))
  return result
}
