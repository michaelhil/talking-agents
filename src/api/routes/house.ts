import { json, errorResponse, parseBody } from './helpers.ts'
import type { RouteEntry } from './types.ts'

export const houseRoutes: RouteEntry[] = [
  {
    method: 'GET',
    pattern: /^\/health$/,
    handler: (_req, _match, { system }) => {
      const health = system.ollama?.getHealth()
      return json({
        status: 'ok',
        ollama: health ? health.status !== 'down' : false,
        ollamaStatus: health?.status ?? 'unconfigured',
        ollamaLatencyMs: health?.latencyMs ?? 0,
        providers: system.providerConfig.order,
        rooms: system.house.listAllRooms().length,
        agents: system.team.listAgents().length,
      })
    },
  },
  // Skills routes moved to routes/skills.ts. Other house-shaped endpoints
  // (/health, /api/models, /api/house/prompts, /api/ollama/urls) stay here
  // because they're cross-cutting reads that don't belong to any single
  // domain.
  {
    method: 'GET',
    pattern: /^\/api\/models$/,
    handler: async (_req, _match, { system }) => {
      // Structured response grouped by provider, with per-model metadata
      // (context window, running flag, recommended flag). Consumed by the
      // UI's model-selection dropdown.
      try {
        const { CURATED_MODELS, isCuratedModel } =
          await import('../../llm/models/catalog.ts')
        const { resolveDefaultModel } = await import('../../llm/models/default-resolver.ts')
        const { PROVIDER_PROFILES } = await import('../../llm/providers-config.ts')
        const { getContextWindowSync } = await import('../../llm/models/context-window.ts')
        const { loadProviderStore, mergeWithEnv } = await import('../../llm/providers-store.ts')

        const { data: storeData } = await loadProviderStore(system.providersStorePath)
        const merged = mergeWithEnv(storeData)

        const monitor = system.llm.getMonitorSnapshot()
        const providers: Array<{
          name: string
          status: 'ok' | 'no_key' | 'cooldown' | 'down'
          // Optional richer fields surfaced for the model-select dropdown's
          // tooltip + countdown — older clients ignore them.
          reason?: string
          retryAt?: number | null
          models: Array<{ id: string; contextMax: number; recommended: boolean; pinned?: boolean; running?: boolean; label?: string }>
        }> = []

        // Cloud providers, in router order (so UI shows them in priority order)
        for (const name of system.providerConfig.order) {
          if (name === 'ollama') continue
          const gw = system.gateways[name]
          const enabled = system.providerKeys.isEnabled(name)
          const m = monitor[name]
          // Map the monitor's richer sub-state down to this endpoint's
          // legacy 4-value enum so existing UI consumers keep working.
          const status: 'ok' | 'no_key' | 'cooldown' | 'down' =
            !enabled ? 'no_key' :
            m && (m.sub === 'no_key' || m.sub === 'disabled') ? 'no_key' :
            m && (m.sub === 'down' || m.sub === 'unhealthy') ? 'down' :
            m && m.sub === 'backoff' ? 'cooldown' :
            'ok'

          const reported = gw?.getHealth().availableModels ?? []
          const curated = CURATED_MODELS[name] ?? []
          const pinnedList = merged.cloud[name as keyof typeof merged.cloud]?.pinnedModels ?? []
          const pinnedSet = new Set(pinnedList)

          // Merge order:
          //   1. Pinned models (in the order the user pinned them)
          //   2. Curated models not already pinned
          //   3. Everything else the provider reported
          const seen = new Set<string>()
          const models: typeof providers[number]['models'] = []
          const curatedLabel: Record<string, string | undefined> = {}
          for (const c of curated) curatedLabel[c.id] = c.label

          for (const id of pinnedList) {
            if (seen.has(id)) continue
            seen.add(id)
            const ctx = getContextWindowSync(name, id)
            models.push({
              id,
              contextMax: ctx.contextMax,
              recommended: true,
              pinned: true,
              ...(curatedLabel[id] ? { label: curatedLabel[id] } : {}),
            })
          }
          for (const c of curated) {
            if (seen.has(c.id)) continue
            seen.add(c.id)
            const ctx = getContextWindowSync(name, c.id)
            models.push({
              id: c.id,
              contextMax: ctx.contextMax,
              recommended: true,
              ...(c.label ? { label: c.label } : {}),
            })
          }
          for (const id of reported) {
            if (seen.has(id)) continue
            const ctx = getContextWindowSync(name, id)
            models.push({ id, contextMax: ctx.contextMax, recommended: false, pinned: pinnedSet.has(id) })
          }
          providers.push({
            name, status, models,
            ...(m && m.reason ? { reason: m.reason } : {}),
            ...(m && m.retryAt !== null ? { retryAt: m.retryAt } : {}),
          })
          void PROVIDER_PROFILES
        }

        // Ollama: running vs on-disk. "recommended" = running.
        if (system.ollama) {
          const [running, all] = await Promise.all([
            (system.ollama.runningModels?.() ?? Promise.resolve([] as string[])).catch(() => [] as string[]),
            system.ollama.models().catch(() => [] as string[]),
          ])
          const runSet = new Set(running)
          const ollamaMon = monitor.ollama ?? null
          const cool = ollamaMon && ollamaMon.sub === 'backoff'
          // All Ollama models are "recommended" — they're local and free, so
          // there's no reason to hide them behind "show all". Running models
          // just get an extra star.
          const models = all.map(id => {
            const ctx = getContextWindowSync('ollama', id)
            return {
              id, contextMax: ctx.contextMax,
              recommended: true,
              running: runSet.has(id),
            }
          })
          providers.push({
            name: 'ollama',
            status: cool ? 'cooldown' : (all.length === 0 ? 'down' : 'ok'),
            ...(ollamaMon && ollamaMon.reason ? { reason: ollamaMon.reason } : {}),
            ...(ollamaMon && ollamaMon.retryAt !== null ? { retryAt: ollamaMon.retryAt } : {}),
            models,
          })
        }

        // Default model pick — delegated to the pure resolver so the same logic
        // can be reused by per-call effective-model resolution in agent eval.
        // The resolver only sees 'ok' providers as candidates (key + no cooldown
        // already encoded in the status field above).
        const defaultModel = resolveDefaultModel(providers)

        void isCuratedModel

        return json({ providers, defaultModel })
      } catch (err) {
        console.error('/api/models error:', err)
        return json({ providers: [], defaultModel: '' })
      }
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/house\/prompts$/,
    handler: (_req, _match, { system }) =>
      json({
        housePrompt: system.house.getHousePrompt(),
        responseFormat: system.house.getResponseFormat(),
      }),
  },
  {
    method: 'PUT',
    pattern: /^\/api\/house\/prompts$/,
    handler: async (req, _match, { system }) => {
      const body = await parseBody(req)
      if (typeof body.housePrompt === 'string') system.house.setHousePrompt(body.housePrompt)
      if (typeof body.responseFormat === 'string') system.house.setResponseFormat(body.responseFormat)
      return json({
        housePrompt: system.house.getHousePrompt(),
        responseFormat: system.house.getResponseFormat(),
      })
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/ollama\/urls$/,
    handler: (_req, _match, { system }) =>
      json({ current: system.ollamaUrls.getCurrent(), saved: system.ollamaUrls.list() }),
  },
  {
    method: 'PUT',
    pattern: /^\/api\/ollama\/urls$/,
    handler: async (req, _match, { system }) => {
      const body = await parseBody(req)
      if (typeof body.url === 'string') {
        system.ollamaUrls.setCurrent(body.url)
        return json({ current: system.ollamaUrls.getCurrent(), saved: system.ollamaUrls.list() })
      }
      return errorResponse('url is required')
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/ollama\/urls$/,
    handler: async (req, _match, { system }) => {
      const body = await parseBody(req)
      if (typeof body.url === 'string') {
        if (body.url === system.ollamaUrls.getCurrent()) return errorResponse('Cannot delete the active URL')
        system.ollamaUrls.remove(body.url)
        return json({ saved: system.ollamaUrls.list() })
      }
      return errorResponse('url is required')
    },
  },
]
