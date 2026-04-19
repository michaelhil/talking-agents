// ============================================================================
// Providers admin routes — cross-provider config and connectivity tests.
//
// GET  /api/providers                 list status (never returns raw keys)
// PUT  /api/providers/:name           set apiKey / enabled / maxConcurrent
// POST /api/providers/:name/test      validate an apiKey against /models
//
// Mutations take effect immediately — gateways read keys lazily via
// ProviderKeys, and the PUT handler kicks a model-list refresh and emits
// a `providers_changed` WS broadcast so open dropdowns refresh.
// ============================================================================

import { json, errorResponse, parseBody } from '../http-routes.ts'
import type { RouteEntry } from './types.ts'
import {
  loadProviderStore, saveProviderStore, mergeWithEnv, maskKey, STORE_VERSION,
  type ProvidersFileShape, type StoredCloudEntry,
} from '../../llm/providers-store.ts'
import {
  PROVIDER_PROFILES, type CloudProviderName,
} from '../../llm/providers-config.ts'
import { createOpenAICompatibleProvider } from '../../llm/openai-compatible.ts'
import { isCloudProviderError } from '../../llm/errors.ts'

const TEST_TIMEOUT_MS = 10_000

const knownCloudNames: ReadonlySet<string> = new Set(Object.keys(PROVIDER_PROFILES))

const isCloud = (name: string): name is CloudProviderName => knownCloudNames.has(name)

// === Status ===

interface ProviderStatusEntry {
  readonly name: string
  readonly kind: 'cloud' | 'ollama'
  readonly keyMask: string
  readonly source: 'env' | 'stored' | 'none'
  readonly enabled: boolean
  readonly maxConcurrent: number | null
  readonly cooldown: { readonly coldUntilMs: number; readonly reason: string } | null
  readonly status: 'ok' | 'no_key' | 'cooldown' | 'down'
}

const computeStatus = (
  kind: 'cloud' | 'ollama',
  enabled: boolean,
  cooldown: { coldUntilMs: number; reason: string } | null,
  circuitOpen: boolean,
): 'ok' | 'no_key' | 'cooldown' | 'down' => {
  if (circuitOpen) return 'down'
  if (cooldown) return 'cooldown'
  if (kind === 'cloud' && !enabled) return 'no_key'
  return 'ok'
}

export const providersRoutes: RouteEntry[] = [
  // --- List status ---
  {
    method: 'GET',
    pattern: /^\/api\/providers$/,
    handler: async (_req, _match, { system }) => {
      const { data: store, warnings } = await loadProviderStore(system.providersStorePath)
      const merged = mergeWithEnv(store)
      const cooldowns = system.llm.getCooldownState()
      const activeOrder = system.llm.getOrder()
      const orderLockedByEnv = !!process.env.PROVIDER_ORDER

      const byName = new Map<string, ProviderStatusEntry>()

      for (const name of Object.keys(PROVIDER_PROFILES) as CloudProviderName[]) {
        const m = merged.cloud[name]
        if (!m) continue
        const gw = system.gateways[name]
        const circuitOpen = !!(gw?.getHealth().status === 'down')
        byName.set(name, {
          name, kind: 'cloud',
          keyMask: m.maskedKey,
          source: m.source,
          enabled: m.enabled,
          maxConcurrent: m.maxConcurrent ?? PROVIDER_PROFILES[name].defaultMaxConcurrent,
          cooldown: cooldowns[name] ?? null,
          status: computeStatus('cloud', m.enabled, cooldowns[name] ?? null, circuitOpen),
        })
      }

      // Ollama — no key concept
      const ollamaGw = system.gateways.ollama
      const ollamaCircuitOpen = !!(ollamaGw?.getHealth().status === 'down')
      byName.set('ollama', {
        name: 'ollama', kind: 'ollama',
        keyMask: '',
        source: 'none',
        enabled: merged.ollama.enabled,
        maxConcurrent: merged.ollama.maxConcurrent ?? 2,
        cooldown: cooldowns.ollama ?? null,
        status: computeStatus('ollama', merged.ollama.enabled, cooldowns.ollama ?? null, ollamaCircuitOpen),
      })

      // Emit in router order so the UI can just render top-to-bottom.
      const entries: ProviderStatusEntry[] = []
      for (const name of activeOrder) {
        const entry = byName.get(name)
        if (entry) entries.push(entry)
      }

      return json({
        providers: entries,
        activeOrder,
        orderLockedByEnv,
        droppedFromOrder: system.providerConfig.droppedFromOrder,
        forceFailProvider: system.providerConfig.forceFailProvider,
        storeWarnings: warnings,
      })
    },
  },

  // --- Set router order (UI reorder arrows) ---
  // Must precede the generic /:name route so the pattern matches first.
  {
    method: 'PUT',
    pattern: /^\/api\/providers\/order$/,
    handler: async (req, _match, { system, broadcast }) => {
      const body = await parseBody(req)
      const incoming = body.order
      if (!Array.isArray(incoming)) return errorResponse('order must be an array of provider names')
      const order: string[] = []
      for (const n of incoming) {
        if (typeof n !== 'string' || !n) return errorResponse('order entries must be non-empty strings')
        order.push(n)
      }

      try {
        system.llm.setOrder(order)
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : String(err))
      }

      const { data: store } = await loadProviderStore(system.providersStorePath)
      const next: ProvidersFileShape = { ...store, order }
      await saveProviderStore(system.providersStorePath, next)

      try { broadcast({ type: 'providers_changed', providers: order }) } catch { /* ignore */ }

      return json({ saved: true, order })
    },
  },

  // --- Set / clear a single provider's key / settings ---
  {
    method: 'PUT',
    pattern: /^\/api\/providers\/([^/]+)$/,
    handler: async (req, match, { system, broadcast }) => {
      const name = decodeURIComponent(match[1] ?? '')
      if (!name) return errorResponse('Provider name required')
      if (name !== 'ollama' && !isCloud(name)) {
        return errorResponse(`Unknown provider: ${name}`, 404)
      }

      const body = await parseBody(req)
      // Accept apiKey?: string | null, enabled?: boolean, maxConcurrent?: number
      const patch: StoredCloudEntry = {}
      let clearKey = false
      if ('apiKey' in body) {
        if (body.apiKey === null) {
          clearKey = true
        } else if (typeof body.apiKey === 'string') {
          const trimmed = body.apiKey.trim()
          if (trimmed.length > 0) (patch as { apiKey?: string }).apiKey = trimmed
          else clearKey = true
        } else {
          return errorResponse('apiKey must be a string or null')
        }
      }
      if (typeof body.enabled === 'boolean') {
        (patch as { enabled?: boolean }).enabled = body.enabled
      }
      if (typeof body.maxConcurrent === 'number') {
        if (body.maxConcurrent <= 0) return errorResponse('maxConcurrent must be > 0')
        if (body.maxConcurrent > 100) return errorResponse('maxConcurrent must be ≤ 100')
        ;(patch as { maxConcurrent?: number }).maxConcurrent = body.maxConcurrent
      }
      // Ollama entries never carry apiKey.
      if (name === 'ollama' && patch.apiKey) {
        return errorResponse('Ollama does not accept an apiKey')
      }

      const { data: store } = await loadProviderStore(system.providersStorePath)
      const existing = (store.providers as Record<string, StoredCloudEntry>)[name] ?? {}
      const updated: StoredCloudEntry = { ...existing, ...patch }
      if (clearKey) delete (updated as { apiKey?: string }).apiKey

      const next: ProvidersFileShape = {
        version: STORE_VERSION,
        providers: {
          ...store.providers,
          [name]: updated,
        },
      }
      await saveProviderStore(system.providersStorePath, next)

      // Apply immediately to the running system:
      //   - Cloud providers: mutate the in-memory keys registry; gateways pick
      //     up the new key on the next request.
      //   - Ollama has no key concept — settings changes (enabled, maxConcurrent)
      //     still require restart for now, but this is rare and we keep
      //     `requiresRestart` honest for that case.
      let requiresRestart = false
      if (name !== 'ollama') {
        const nextKey = clearKey ? '' : (updated.apiKey ?? '')
        system.providerKeys.set(name, nextKey)
        // Fire-and-forget a model-list refresh so the dropdown populates.
        // We don't await — PUT returns promptly and the WS broadcast below
        // prompts the UI to refetch /api/models a moment later.
        const gw = system.gateways[name]
        if (gw && nextKey) {
          void gw.refreshModels().catch(() => { /* swallow — UI will surface */ })
        }
      } else {
        requiresRestart = true
      }

      // Notify UIs so open model dropdowns re-render.
      try { broadcast({ type: 'providers_changed', providers: [name] }) } catch { /* ignore */ }

      return json({
        saved: true,
        requiresRestart,
        provider: {
          name,
          keyMask: maskKey(updated.apiKey ?? ''),
          enabled: updated.enabled ?? (updated.apiKey ? true : false),
          maxConcurrent: updated.maxConcurrent ?? null,
        },
      })
    },
  },

  // --- Test a key (pending or stored) ---
  {
    method: 'POST',
    pattern: /^\/api\/providers\/([^/]+)\/test$/,
    handler: async (req, match, { system }) => {
      const name = decodeURIComponent(match[1] ?? '')
      if (!isCloud(name)) {
        return errorResponse(`Unknown cloud provider: ${name}`, 404)
      }

      const body: Record<string, unknown> = await parseBody(req).catch(() => ({} as Record<string, unknown>))
      let apiKey: string | undefined
      if (typeof body.apiKey === 'string') apiKey = body.apiKey.trim()
      if (!apiKey || apiKey.length === 0) {
        // Fall back to the currently-resolved key for this provider
        const { data: store } = await loadProviderStore(system.providersStorePath)
        const merged = mergeWithEnv(store)
        apiKey = merged.cloud[name]?.apiKey || ''
      }
      if (!apiKey) {
        return json({ ok: false, error: 'No API key provided or stored', elapsedMs: 0 }, 200)
      }

      const provider = createOpenAICompatibleProvider({
        name,
        baseUrl: PROVIDER_PROFILES[name].baseUrl,
        getApiKey: () => apiKey,
        modelsTimeoutMs: TEST_TIMEOUT_MS,
      })

      const startedAt = performance.now()
      try {
        const list = await Promise.race([
          provider.models(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`timeout after ${TEST_TIMEOUT_MS}ms`)), TEST_TIMEOUT_MS)),
        ])
        return json({
          ok: true,
          elapsedMs: Math.round(performance.now() - startedAt),
          sampleModel: list[0] ?? null,
          modelCount: list.length,
        })
      } catch (err) {
        const elapsedMs = Math.round(performance.now() - startedAt)
        let reason = err instanceof Error ? err.message : String(err)
        // Don't leak the key if an error unexpectedly includes it. Simple redact.
        if (apiKey) reason = reason.split(apiKey).join('•••REDACTED•••')
        let code: string = 'error'
        if (isCloudProviderError(err)) code = err.code
        return json({ ok: false, error: reason, code, elapsedMs })
      }
    },
  },
]
