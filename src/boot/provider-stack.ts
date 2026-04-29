// ============================================================================
// Provider stack construction — the wiring that bit us three times after
// the wiki commit. Extracted from bootstrap.ts so the dependency order
// (load store → providerKeys → providerSetup → SharedRuntime) lives in one
// place and the contract between steps is visible.
//
// Returns the SharedRuntime + the providerKeys reference (callers may need
// it for live key edits in the providers admin endpoint).
// ============================================================================

import { sharedPaths } from '../core/paths.ts'
import { createSharedRuntime, type SharedRuntime } from '../core/shared-runtime.ts'
import { createLimitMetrics, type LimitMetrics } from '../core/limit-metrics.ts'
import { initSharedLimiter } from '../api/routes/instances.ts'
import { parseProviderConfig, summariseProviderConfig, type ProviderConfig } from '../llm/providers-config.ts'
import { buildProvidersFromConfig } from '../llm/providers-setup.ts'
import { loadProviderStore, mergeWithEnv } from '../llm/providers-store.ts'
import { createProviderKeys, type ProviderKeys } from '../llm/provider-keys.ts'

export interface ProviderStack {
  readonly providerConfig: ProviderConfig
  readonly providerKeys: ProviderKeys
  readonly limitMetrics: LimitMetrics
  readonly shared: SharedRuntime
}

export const buildProviderStack = async (): Promise<ProviderStack> => {
  // 1. Load store + merge env. Warnings logged but not fatal.
  const providersStorePath = sharedPaths.providers()
  const { data: storeData, warnings: storeWarnings } = await loadProviderStore(providersStorePath)
  for (const w of storeWarnings) console.warn(`[providers.json] ${w}`)
  const fileStore = mergeWithEnv(storeData)

  // 2. Parse config (env + file overlay).
  const providerConfig = parseProviderConfig({ fileStore })

  // 3. Construct limitMetrics first so the same instance flows into the
  // cloud-provider adapters (SSE-overflow tracking) AND SharedRuntime.
  const limitMetrics = createLimitMetrics()

  // 4. Build providerKeys BEFORE providerSetup. The router's
  // isProviderEnabled filter is wired from providerKeys.isEnabled — without
  // it, the router walks every provider in the order, including keyless
  // ones (anthropic), and throws auth errors on every chat call.
  // Bug class: commit d0c1f73.
  const providerKeys = createProviderKeys(fileStore)
  for (const [name, cc] of Object.entries(providerConfig.cloud)) {
    if (cc?.apiKey) providerKeys.set(name, cc.apiKey)
  }

  // 5. Build providerSetup (gateways + router) using the keys we just made.
  const providerSetup = buildProvidersFromConfig(providerConfig, { limitMetrics, providerKeys })

  // 6. Construct SharedRuntime — same providerKeys, same limitMetrics, same
  // setup. Single source for live key edits.
  const shared = createSharedRuntime({ providerConfig, providerSetup, limitMetrics, providerKeys })

  // 7. Wire the shared rate-limiter with the global metrics handle so LRU
  // evictions are counted. Idempotent — safe if called more than once.
  initSharedLimiter(shared.limitMetrics)

  return { providerConfig, providerKeys, limitMetrics, shared }
}

export const summariseProviders = (config: ProviderConfig): string =>
  summariseProviderConfig(config)
