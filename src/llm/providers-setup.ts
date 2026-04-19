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
import { getContextWindow } from './model-context.ts'
import type { ProviderKeys } from './provider-keys.ts'

export interface ProviderSetupResult {
  readonly router: ProviderRouter
  readonly ollama?: OllamaGateway                      // present iff 'ollama' is in order
  readonly ollamaRaw?: OllamaProviderExtended          // raw provider for URL edit UX
  readonly gateways: Record<string, ProviderGateway>   // all gateways in the router
  readonly dispose: () => void
}

export interface BuildProvidersOptions {
  // Keys store — when provided, gateways read keys via getter so runtime key
  // changes take effect without a restart. When absent, we fall back to a
  // static snapshot captured from `config.cloud` (test paths).
  readonly providerKeys?: ProviderKeys
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
  for (const name of Object.keys(PROVIDER_PROFILES) as CloudProviderName[]) {
    const cc = config.cloud[name]
    const staticKey = cc?.apiKey ?? ''
    const getApiKey = options.providerKeys
      ? () => options.providerKeys!.get(name)
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
    const provider = createOpenAICompatibleProvider({
      name,
      baseUrl: PROVIDER_PROFILES[name].baseUrl,
      getApiKey,
      ...(authHeaders ? { authHeaders } : {}),
    })
    gateways[name] = createProviderGateway(
      provider,
      { maxConcurrent },
      { isPermanentError: (err) => isCloudProviderError(err) },
    )
  }

  const router = createProviderRouter(gateways, {
    order: config.order,
    forceFailProvider: config.forceFailProvider,
    isProviderEnabled: options.providerKeys
      ? (name) => name === 'ollama' || options.providerKeys!.isEnabled(name)
      : undefined,
    contextLookup: async (provider, model) => {
      const info = await getContextWindow(provider, model, {
        ollamaBaseUrl: config.ollamaUrl,
        openrouterApiKey: options.providerKeys?.get('openrouter') || config.cloud.openrouter?.apiKey,
      })
      return { contextMax: info.contextMax, source: info.source }
    },
  })

  const dispose = (): void => {
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
