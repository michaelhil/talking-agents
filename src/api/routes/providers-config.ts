// PUT /api/providers/order        — router priority (UI reorder arrows)
// PUT /api/providers/:name         — set apiKey / enabled / maxConcurrent /
//                                    baseUrl / pinnedModels for one provider
//
// Mutations take effect immediately — gateways read keys lazily via
// ProviderKeys, and the :name PUT kicks a model-list refresh and emits a
// `providers_changed` WS broadcast so open dropdowns refresh.

import { json, errorResponse, parseBody } from './helpers.ts'
import type { RouteEntry } from './types.ts'
import {
  loadProviderStore, saveProviderStore, maskKey, STORE_VERSION,
  type ProvidersFileShape, type StoredCloudEntry,
} from '../../llm/providers-store.ts'
import { isLocal } from '../../llm/providers-config.ts'
import { isCloud } from '../../llm/provider-probe.ts'

export const providersConfigRoutes: RouteEntry[] = [
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
      if ('baseUrl' in body) {
        // Only meaningful for local providers (llamacpp). Cloud providers
        // ignore — their baseUrl is fixed in PROVIDER_PROFILES.
        if (!isLocal(name)) return errorResponse('baseUrl is only configurable for local providers')
        if (body.baseUrl === null || body.baseUrl === '') {
          (patch as { baseUrl?: string }).baseUrl = ''
        } else if (typeof body.baseUrl === 'string') {
          const trimmed = body.baseUrl.trim()
          // Sanity-check that it parses; reject early to avoid persisting garbage.
          try { new URL(trimmed) } catch { return errorResponse('baseUrl must be a valid URL') }
          ;(patch as { baseUrl?: string }).baseUrl = trimmed
        } else {
          return errorResponse('baseUrl must be a string or null')
        }
      }
      if ('pinnedModels' in body) {
        if (body.pinnedModels === null) {
          (patch as { pinnedModels?: ReadonlyArray<string> }).pinnedModels = []
        } else if (Array.isArray(body.pinnedModels)) {
          const pins = (body.pinnedModels as unknown[]).filter((v): v is string => typeof v === 'string' && v.length > 0)
          ;(patch as { pinnedModels?: ReadonlyArray<string> }).pinnedModels = pins
        } else {
          return errorResponse('pinnedModels must be an array of strings or null')
        }
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

      // Apply baseUrl change to the live providerConfig so the OAI adapter's
      // getBaseUrl closure (created at boot) picks up the new URL on the next
      // request. The closure re-reads `config.baseUrls[name]` each call.
      if ('baseUrl' in body && isLocal(name)) {
        const liveBaseUrls = system.providerConfig.baseUrls as Record<string, string | undefined>
        const trimmed = (patch as { baseUrl?: string }).baseUrl ?? ''
        if (trimmed) liveBaseUrls[name] = trimmed
        else delete liveBaseUrls[name]
      }

      // Apply immediately to the running system:
      //   - Cloud providers: mutate the in-memory keys registry; gateways pick
      //     up the new key on the next request.
      //   - Ollama: enabled/maxConcurrent changes need restart for now; keys
      //     don't apply (no API key concept).
      let requiresRestart = false
      if (name !== 'ollama') {
        const nextKey = clearKey ? '' : (updated.apiKey ?? '')
        system.providerKeys.set(name, nextKey)
        // Reflect the stored `enabled` flag in the runtime registry.
        // Saving a fresh key auto-enables the provider (matches UI expectation
        // that a successful save brings the provider online).
        if (typeof body.enabled === 'boolean') {
          system.providerKeys.setEnabled(name, body.enabled)
        } else if (nextKey && !system.providerKeys.isUserEnabled(name)) {
          // Implicit re-enable when user saves a key on a disabled provider.
          system.providerKeys.setEnabled(name, true)
        }
        // Fire-and-forget a model-list refresh so the dropdown populates.
        // Local providers (llamacpp) refresh on key OR baseUrl change so the
        // user sees the loaded model immediately after pointing at a new URL.
        const gw = system.gateways[name]
        if (gw && (nextKey || (isLocal(name) && 'baseUrl' in body))) {
          void gw.refreshModels().catch(() => { /* swallow — UI will surface */ })
        }
      } else {
        requiresRestart = true
      }

      // Refresh the per-call effective-model cache so any agent whose preferred
      // model became available (or unavailable) on this change resolves the
      // updated state on its next eval. Mirrors resolveActiveWikis: derive on
      // read, no boot-time freeze.
      void system.refreshAvailableModels()

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
]
