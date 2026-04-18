// ============================================================================
// Providers admin routes — cross-provider config and connectivity tests.
//
// GET  /api/providers                 list status (never returns raw keys)
// PUT  /api/providers/:name           set apiKey / enabled / maxConcurrent
// POST /api/providers/:name/test      validate an apiKey against /models
//
// Mutations require restart to take effect (see /api/system/shutdown).
// Responses include { requiresRestart: true } so the UI shows a banner.
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
  readonly inRouter: boolean
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
      const activeOrder = system.providerConfig.order

      const entries: ProviderStatusEntry[] = []

      // Cloud providers
      for (const name of Object.keys(PROVIDER_PROFILES) as CloudProviderName[]) {
        const m = merged.cloud[name]
        if (!m) continue
        entries.push({
          name, kind: 'cloud',
          keyMask: m.maskedKey,
          source: m.source,
          enabled: m.enabled,
          maxConcurrent: m.maxConcurrent ?? PROVIDER_PROFILES[name].defaultMaxConcurrent,
          cooldown: cooldowns[name] ?? null,
          inRouter: activeOrder.includes(name),
        })
      }

      // Ollama — no key concept; show URL + enabled / concurrency
      entries.push({
        name: 'ollama', kind: 'ollama',
        keyMask: '',
        source: 'none',
        enabled: merged.ollama.enabled,
        maxConcurrent: merged.ollama.maxConcurrent ?? 2,
        cooldown: cooldowns.ollama ?? null,
        inRouter: activeOrder.includes('ollama'),
      })

      return json({
        providers: entries,
        activeOrder,
        droppedFromOrder: system.providerConfig.droppedFromOrder,
        forceFailProvider: system.providerConfig.forceFailProvider,
        storeWarnings: warnings,
      })
    },
  },

  // --- Set / clear ---
  {
    method: 'PUT',
    pattern: /^\/api\/providers\/([^/]+)$/,
    handler: async (req, match, { system }) => {
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

      return json({
        saved: true,
        requiresRestart: true,
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
        apiKey,
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
