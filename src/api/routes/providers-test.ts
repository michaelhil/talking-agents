// POST /api/providers/:name/refresh-models  — refresh model-cache and return list
// POST /api/providers/:name/test-model       — single-model ping (from popover)
// POST /api/providers/:name/test             — full key-test + concurrency probe
//
// All three are user-initiated network probes. Results push into the
// monitor so the panel dot reflects what the user just saw, and emit
// `providers_changed` WS so open UIs refresh.

import { json, errorResponse, parseBody } from './helpers.ts'
import type { RouteEntry } from './types.ts'
import {
  loadProviderStore, mergeWithEnv,
} from '../../llm/providers-store.ts'
import {
  PROVIDER_PROFILES, isLocal,
} from '../../llm/providers-config.ts'
import { createOpenAICompatibleProvider } from '../../llm/openai-compatible.ts'
import { isCloudProviderError } from '../../llm/errors.ts'
import {
  TEST_TIMEOUT_MS, runProbe, pickTestModel, isCloud,
  type ProbeResult,
} from '../../llm/provider-probe.ts'

export const providersTestRoutes: RouteEntry[] = [
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
          : (merged.cloud[name as Exclude<typeof name, 'ollama'>]?.pinnedModels ?? []),
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
          system.monitors.ollama?.recordHeartbeat(true)
          return json({
            ok: true, elapsedMs: Math.round(performance.now() - t0),
            usage: resp.tokensUsed ?? null,
          })
        } catch (err) {
          const elapsedMs = Math.round(performance.now() - t0)
          const reason = err instanceof Error ? err.message : String(err)
          system.monitors.ollama?.markUnhealthy(reason.slice(0, 200), 'test_failed')
          return json({ ok: false, error: reason, elapsedMs })
        }
      }

      if (!isCloud(name)) return errorResponse(`Unknown provider: ${name}`, 404)

      const { data: storeLocal } = await loadProviderStore(system.providersStorePath)
      const mergedLocal = mergeWithEnv(storeLocal)
      const apiKey = mergedLocal.cloud[name]?.apiKey ?? ''
      if (!apiKey && !isLocal(name)) return json({ ok: false, error: 'No API key stored', elapsedMs: 0 })

      const authHeaders = name === 'anthropic'
        ? () => ({ 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' })
        : undefined
      // Honour the stored baseUrl for local providers so the test hits the
      // user's actual endpoint (e.g. a remote llama.cpp box).
      const effectiveBaseUrl = mergedLocal.cloud[name]?.baseUrl ?? PROVIDER_PROFILES[name].baseUrl
      const provider = createOpenAICompatibleProvider({
        name,
        getBaseUrl: () => effectiveBaseUrl,
        getApiKey: () => apiKey,
        ...(authHeaders ? { authHeaders } : {}),
      })

      const t0 = performance.now()
      try {
        const resp = await provider.chat({ model, messages: [{ role: 'user', content: 'ping' }], maxTokens: 1, temperature: 0 })
        system.monitors[name]?.recordHeartbeat(true)
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
        system.monitors[name]?.markUnhealthy(reason.slice(0, 200), code)
        return json({ ok: false, error: reason, code, elapsedMs })
      }
    },
  },

  // --- Test a key (pending or stored) ---
  {
    method: 'POST',
    pattern: /^\/api\/providers\/([^/]+)\/test$/,
    handler: async (req, match, { system, broadcast }) => {
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
          // Same as the cloud branch: surface the test failure in monitor
          // state so the panel dot turns red instead of staying green.
          system.monitors.ollama?.markUnhealthy(reason.slice(0, 200), 'test_failed')
          try { broadcast({ type: 'providers_changed', providers: ['ollama'] }) } catch { /* ignore */ }
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

        // Reflect probe result in monitor state.
        const ollamaMon = system.monitors.ollama
        if (ollamaMon) {
          if (probe.succeeded > 0) {
            ollamaMon.recordHeartbeat(true, models.length)
          } else {
            const top = Object.entries(probe.byFailure).sort(([, a], [, b]) => b - a)[0]
            ollamaMon.markUnhealthy(top ? `test probe failed (${top[0]})` : 'test probe failed', top?.[0] ?? 'test_failed')
          }
          try { broadcast({ type: 'providers_changed', providers: ['ollama'] }) } catch { /* ignore */ }
        }

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
      if (!apiKey && !isLocal(name)) {
        return json({ ok: false, error: 'No API key provided or stored', elapsedMs: 0 }, 200)
      }

      // Mirror providers-setup.ts for per-provider auth headers. Anthropic's
      // OpenAI-compat endpoint rejects Bearer.
      const authHeaders = name === 'anthropic'
        ? () => ({ 'x-api-key': apiKey!, 'anthropic-version': '2023-06-01' })
        : undefined
      // Use the stored baseUrl when present (local providers may have a
      // user-configured URL); otherwise fall back to the profile default.
      const { data: storeForBase } = await loadProviderStore(system.providersStorePath)
      const mergedForBase = mergeWithEnv(storeForBase)
      const effectiveBaseUrl = mergedForBase.cloud[name]?.baseUrl ?? PROVIDER_PROFILES[name].baseUrl
      const provider = createOpenAICompatibleProvider({
        name,
        getBaseUrl: () => effectiveBaseUrl,
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
        // Surface the test result in monitor state. A failed user-initiated
        // test is authoritative — we don't need to wait for a streak. This
        // is what fixes "anthropic shows green even though Test returns
        // red": the monitor's rate-limit/streak logic doesn't apply to
        // permanent errors like auth, so without this push the dot stays
        // green forever despite a broken key.
        system.monitors[name]?.markUnhealthy(reason.slice(0, 200), code)
        try { broadcast({ type: 'providers_changed', providers: [name] }) } catch { /* ignore */ }
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

      // Push the test result into the monitor so the dot reflects what the
      // user just saw. Success → record a healthy heartbeat (clears any
      // prior backoff/unhealthy). Failure → mark unhealthy with the most
      // common failure reason from the probe.
      const monitor = system.monitors[name]
      if (monitor) {
        if (!concurrency || concurrency.succeeded > 0) {
          monitor.recordHeartbeat(true, list.length)
        } else {
          const topFailure = Object.entries(concurrency.byFailure)
            .sort(([, a], [, b]) => b - a)[0]
          const reason = topFailure ? `test probe failed (${topFailure[0]})` : 'test probe failed'
          monitor.markUnhealthy(reason, topFailure?.[0] ?? 'test_failed')
        }
        try { broadcast({ type: 'providers_changed', providers: [name] }) } catch { /* ignore */ }
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
