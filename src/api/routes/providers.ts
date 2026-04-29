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

import { json, errorResponse, parseBody } from './helpers.ts'
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
import {
  TEST_TIMEOUT_MS, runProbe, pickTestModel, computeStatus, isCloud,
  type ProbeResult, type ProviderStatus,
} from '../../llm/provider-probe.ts'

interface ProviderStatusEntry {
  readonly name: string
  readonly kind: 'cloud' | 'ollama'
  readonly keyMask: string
  readonly source: 'env' | 'stored' | 'none'
  readonly enabled: boolean            // effective (has key AND userEnabled)
  readonly userEnabled: boolean        // user intent, independent of key
  readonly hasKey: boolean
  readonly maxConcurrent: number | null
  readonly cooldown: { readonly coldUntilMs: number; readonly reason: string } | null
  readonly status: ProviderStatus
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
        const hasKey = m.apiKey.length > 0
        // Runtime user-enabled flag (may diverge from stored while we refactor).
        const userEnabled = system.providerKeys.isUserEnabled(name)
        byName.set(name, {
          name, kind: 'cloud',
          keyMask: m.maskedKey,
          source: m.source,
          hasKey,
          userEnabled,
          enabled: hasKey && userEnabled,
          maxConcurrent: m.maxConcurrent ?? PROVIDER_PROFILES[name].defaultMaxConcurrent,
          cooldown: cooldowns[name] ?? null,
          status: computeStatus('cloud', hasKey, userEnabled, cooldowns[name] ?? null, circuitOpen),
        })
      }

      // Ollama — no key concept, but still has a user-enabled toggle.
      const ollamaGw = system.gateways.ollama
      const ollamaCircuitOpen = !!(ollamaGw?.getHealth().status === 'down')
      const ollamaUserEnabled = merged.ollama.enabled
      byName.set('ollama', {
        name: 'ollama', kind: 'ollama',
        keyMask: '',
        source: 'none',
        hasKey: true, // N/A — treat as "always keyed" so status reduces to user/cooldown/down
        userEnabled: ollamaUserEnabled,
        enabled: ollamaUserEnabled,
        maxConcurrent: merged.ollama.maxConcurrent ?? 2,
        cooldown: cooldowns.ollama ?? null,
        status: computeStatus('ollama', true, ollamaUserEnabled, cooldowns.ollama ?? null, ollamaCircuitOpen),
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
        const gw = system.gateways[name]
        if (gw && nextKey) {
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

  // --- Refresh the provider's model cache and return the full list with
  //     metadata (used by the UI models popover).
  {
    method: 'POST',
    pattern: /^\/api\/providers\/([^/]+)\/refresh-models$/,
    handler: async (_req, match, { system }) => {
      const name = decodeURIComponent(match[1] ?? '')
      if (name !== 'ollama' && !isCloud(name)) return errorResponse(`Unknown provider: ${name}`, 404)

      const gw = system.gateways[name]
      if (!gw) return errorResponse(`Gateway not found for ${name}`, 500)

      const started = performance.now()
      let refreshError: string | undefined
      try {
        await gw.refreshModels()
      } catch (err) {
        refreshError = err instanceof Error ? err.message : String(err)
      }
      const elapsedMs = Math.round(performance.now() - started)

      const reported = gw.getHealth().availableModels

      const { CURATED_MODELS } = await import('../../llm/models/catalog.ts')
      const { getContextWindowSync } = await import('../../llm/models/context-window.ts')

      const curatedIds = new Set((CURATED_MODELS[name] ?? []).map(m => m.id))
      const curatedLabel: Record<string, string | undefined> = {}
      for (const m of (CURATED_MODELS[name] ?? [])) curatedLabel[m.id] = m.label

      const { data: store } = await loadProviderStore(system.providersStorePath)
      const merged = mergeWithEnv(store)
      const pinned = new Set(
        name === 'ollama'
          ? []
          : (merged.cloud[name as CloudProviderName]?.pinnedModels ?? []),
      )

      // Union: reported + curated (curated may include models not in the
      // /models response for this provider — still worth showing).
      const allIds = new Set<string>(reported)
      for (const id of curatedIds) allIds.add(id)

      const models = [...allIds].map(id => {
        const ctx = getContextWindowSync(name, id)
        return {
          id,
          contextMax: ctx.contextMax,
          curated: curatedIds.has(id),
          pinned: pinned.has(id),
          ...(curatedLabel[id] ? { label: curatedLabel[id] } : {}),
        }
      }).sort((a, b) => {
        // Pinned first, then curated, then alphabetical.
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        if (a.curated !== b.curated) return a.curated ? -1 : 1
        return a.id.localeCompare(b.id)
      })

      return json({
        ok: !refreshError,
        ...(refreshError ? { error: refreshError } : {}),
        elapsedMs,
        models,
      })
    },
  },

  // --- Test a single model (from the models popover) ---
  {
    method: 'POST',
    pattern: /^\/api\/providers\/([^/]+)\/test-model$/,
    handler: async (req, match, { system }) => {
      const name = decodeURIComponent(match[1] ?? '')
      const body = await parseBody(req).catch(() => ({} as Record<string, unknown>))
      const model = typeof body.model === 'string' ? body.model.trim() : ''
      if (!model) return errorResponse('model is required')

      // Ollama path.
      if (name === 'ollama') {
        const { createOllamaProvider } = await import('../../llm/ollama.ts')
        const raw = createOllamaProvider(system.providerConfig.ollamaUrl)
        const t0 = performance.now()
        try {
          const resp = await raw.chat({ model, messages: [{ role: 'user', content: 'ping' }], maxTokens: 1, temperature: 0 })
          return json({
            ok: true, elapsedMs: Math.round(performance.now() - t0),
            usage: resp.tokensUsed ?? null,
          })
        } catch (err) {
          const elapsedMs = Math.round(performance.now() - t0)
          return json({ ok: false, error: err instanceof Error ? err.message : String(err), elapsedMs })
        }
      }

      if (!isCloud(name)) return errorResponse(`Unknown provider: ${name}`, 404)

      const { data: storeLocal } = await loadProviderStore(system.providersStorePath)
      const mergedLocal = mergeWithEnv(storeLocal)
      const apiKey = mergedLocal.cloud[name]?.apiKey ?? ''
      if (!apiKey) return json({ ok: false, error: 'No API key stored', elapsedMs: 0 })

      const authHeaders = name === 'anthropic'
        ? () => ({ 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' })
        : undefined
      const provider = createOpenAICompatibleProvider({
        name,
        baseUrl: PROVIDER_PROFILES[name].baseUrl,
        getApiKey: () => apiKey,
        ...(authHeaders ? { authHeaders } : {}),
      })

      const t0 = performance.now()
      try {
        const resp = await provider.chat({ model, messages: [{ role: 'user', content: 'ping' }], maxTokens: 1, temperature: 0 })
        return json({
          ok: true, elapsedMs: Math.round(performance.now() - t0),
          usage: resp.tokensUsed ?? null,
        })
      } catch (err) {
        const elapsedMs = Math.round(performance.now() - t0)
        let reason = err instanceof Error ? err.message : String(err)
        if (apiKey) reason = reason.split(apiKey).join('•••REDACTED•••')
        // Cap the error body so a chatty 5xx (which can include arbitrary
        // upstream content) doesn't get echoed back to the client wholesale.
        if (reason.length > 500) reason = reason.slice(0, 500) + '… [truncated]'
        const code = isCloudProviderError(err) ? err.code : 'error'
        return json({ ok: false, error: reason, code, elapsedMs })
      }
    },
  },

  // --- Test a key (pending or stored) ---
  {
    method: 'POST',
    pattern: /^\/api\/providers\/([^/]+)\/test$/,
    handler: async (req, match, { system }) => {
      const name = decodeURIComponent(match[1] ?? '')

      // Ollama: ping /models, then run a concurrency probe against the
      // configured maxConcurrent using a single-token chat call. Free because
      // it's local.
      if (name === 'ollama') {
        const gw = system.gateways.ollama
        if (!gw) return json({ ok: false, error: 'Ollama gateway not configured', elapsedMs: 0 }, 200)
        const startedAt = performance.now()
        let models: ReadonlyArray<string>
        try {
          models = await gw.models()
        } catch (err) {
          const elapsedMs = Math.round(performance.now() - startedAt)
          const reason = err instanceof Error ? err.message : String(err)
          return json({ ok: false, error: reason, elapsedMs })
        }
        const elapsedMs = Math.round(performance.now() - startedAt)

        const { CURATED_MODELS } = await import('../../llm/models/catalog.ts')
        const { createOllamaProvider } = await import('../../llm/ollama.ts')
        const pinnedList = [] as ReadonlyArray<string>
        const curatedIds = (CURATED_MODELS.ollama ?? []).map(m => m.id)
        const model = pickTestModel(pinnedList, curatedIds, models)
        if (!model) {
          return json({ ok: true, elapsedMs, sampleModel: null, modelCount: models.length })
        }

        const target = Math.max(1, system.providerConfig.ollamaMaxConcurrent || 2)
        const raw = createOllamaProvider(system.providerConfig.ollamaUrl)
        const probe = await runProbe(
          async (m) => { await raw.chat({ model: m, messages: [{ role: 'user', content: 'ping' }], maxTokens: 1, temperature: 0 }) },
          model, target, TEST_TIMEOUT_MS,
        )

        return json({
          ok: probe.succeeded > 0,
          elapsedMs,
          sampleModel: models[0] ?? null,
          modelCount: models.length,
          concurrency: probe,
        })
      }

      if (!isCloud(name)) {
        return errorResponse(`Unknown provider: ${name}`, 404)
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

      // Mirror providers-setup.ts for per-provider auth headers. Anthropic's
      // OpenAI-compat endpoint rejects Bearer.
      const authHeaders = name === 'anthropic'
        ? () => ({ 'x-api-key': apiKey!, 'anthropic-version': '2023-06-01' })
        : undefined
      const provider = createOpenAICompatibleProvider({
        name,
        baseUrl: PROVIDER_PROFILES[name].baseUrl,
        getApiKey: () => apiKey!,
        ...(authHeaders ? { authHeaders } : {}),
        modelsTimeoutMs: TEST_TIMEOUT_MS,
      })

      const startedAt = performance.now()
      let list: ReadonlyArray<string>
      try {
        list = await Promise.race([
          provider.models(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`timeout after ${TEST_TIMEOUT_MS}ms`)), TEST_TIMEOUT_MS)),
        ])
      } catch (err) {
        const elapsedMs = Math.round(performance.now() - startedAt)
        let reason = err instanceof Error ? err.message : String(err)
        if (apiKey) reason = reason.split(apiKey).join('•••REDACTED•••')
        let code: string = 'error'
        if (isCloudProviderError(err)) code = err.code
        return json({ ok: false, error: reason, code, elapsedMs })
      }
      const elapsedMs = Math.round(performance.now() - startedAt)

      // Concurrency probe — fire `maxConcurrent` parallel single-token chat
      // calls and report capacity. Bypasses the gateway's local semaphore to
      // actually probe upstream behaviour, not our own throttle.
      const { CURATED_MODELS } = await import('../../llm/models/catalog.ts')
      const { data: storeAgain } = await loadProviderStore(system.providersStorePath)
      const mergedAgain = mergeWithEnv(storeAgain)
      const pinned = mergedAgain.cloud[name]?.pinnedModels ?? []
      const curatedIds = (CURATED_MODELS[name] ?? []).map(m => m.id)
      const model = pickTestModel(pinned, curatedIds, list)

      let concurrency: ProbeResult | undefined
      if (model) {
        const target = Math.max(1, mergedAgain.cloud[name]?.maxConcurrent ?? PROVIDER_PROFILES[name].defaultMaxConcurrent)
        concurrency = await runProbe(
          async (m) => { await provider.chat({ model: m, messages: [{ role: 'user', content: 'ping' }], maxTokens: 1, temperature: 0 }) },
          model, target, TEST_TIMEOUT_MS,
        )
      }

      return json({
        ok: !concurrency || concurrency.succeeded > 0,
        elapsedMs,
        sampleModel: list[0] ?? null,
        modelCount: list.length,
        ...(concurrency ? { concurrency } : {}),
      })
    },
  },
]
