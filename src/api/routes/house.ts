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
  {
    method: 'GET',
    pattern: /^\/api\/skills$/,
    handler: (_req, _match, { system }) =>
      json(system.skillStore.list().map(s => ({
        name: s.name, description: s.description,
        scope: s.scope.length > 0 ? s.scope : 'global',
        tools: s.tools,
      }))),
  },
  {
    method: 'GET',
    pattern: /^\/api\/skills\/([^/]+)$/,
    handler: (_req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const skill = system.skillStore.get(name)
      if (!skill) return errorResponse(`Skill "${name}" not found`, 404)
      return json({ name: skill.name, description: skill.description, body: skill.body, scope: skill.scope, tools: skill.tools })
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/skills$/,
    handler: async (req, _match, { system }) => {
      const body = await parseBody(req)
      const name = body.name as string
      const description = body.description as string
      const skillBody = body.body as string
      if (!name || !description || !skillBody) return errorResponse('name, description, and body are required')
      if (system.skillStore.get(name)) return errorResponse(`Skill "${name}" already exists`)
      const { mkdir, writeFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const dirPath = join(system.skillsDir, name)
      await mkdir(dirPath, { recursive: true })
      const scope = Array.isArray(body.scope) ? body.scope as string[] : []
      const scopeLine = scope.length > 0 ? `\nscope: [${scope.join(', ')}]` : ''
      await writeFile(join(dirPath, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}${scopeLine}\n---\n\n${skillBody}\n`, 'utf-8')
      system.skillStore.register({ name, description, body: skillBody, scope, tools: [], allowedToolNames: [], dirPath })
      return json({ created: true, name }, 201)
    },
  },
  {
    method: 'PUT',
    pattern: /^\/api\/skills\/([^/]+)$/,
    handler: async (req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const skill = system.skillStore.get(name)
      if (!skill) return errorResponse(`Skill "${name}" not found`, 404)
      const body = await parseBody(req)
      const newDesc = (body.description as string) ?? skill.description
      const newBody = (body.body as string) ?? skill.body
      const newScope = Array.isArray(body.scope) ? body.scope as string[] : [...skill.scope]
      const { writeFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const scopeLine = newScope.length > 0 ? `\nscope: [${newScope.join(', ')}]` : ''
      await writeFile(join(skill.dirPath, 'SKILL.md'), `---\nname: ${name}\ndescription: ${newDesc}${scopeLine}\n---\n\n${newBody}\n`, 'utf-8')
      system.skillStore.register({ ...skill, description: newDesc, body: newBody, scope: newScope })
      return json({ updated: true, name })
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/skills\/([^/]+)$/,
    handler: async (_req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const skill = system.skillStore.get(name)
      if (!skill) return errorResponse(`Skill "${name}" not found`, 404)
      const { rm } = await import('node:fs/promises')
      await rm(skill.dirPath, { recursive: true, force: true })
      system.skillStore.remove(name)
      return json({ deleted: true, name })
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/models$/,
    handler: async (_req, _match, { system }) => {
      // Structured response grouped by provider, with per-model metadata
      // (context window, running flag, recommended flag). Consumed by the
      // UI's model-selection dropdown.
      try {
        const { CURATED_MODELS, isCuratedModel, DEFAULT_PREFERENCE_ORDER } =
          await import('../../llm/models/catalog.ts')
        const { PROVIDER_PROFILES } = await import('../../llm/providers-config.ts')
        const { getContextWindowSync } = await import('../../llm/models/context-window.ts')
        const { loadProviderStore, mergeWithEnv } = await import('../../llm/providers-store.ts')

        const { data: storeData } = await loadProviderStore(system.providersStorePath)
        const merged = mergeWithEnv(storeData)

        const cooldowns = system.llm.getCooldownState()
        const providers: Array<{
          name: string
          status: 'ok' | 'no_key' | 'cooldown' | 'down'
          models: Array<{ id: string; contextMax: number; recommended: boolean; pinned?: boolean; running?: boolean; label?: string }>
        }> = []

        // Cloud providers, in router order (so UI shows them in priority order)
        for (const name of system.providerConfig.order) {
          if (name === 'ollama') continue
          const gw = system.gateways[name]
          const enabled = system.providerKeys.isEnabled(name)
          const cool = cooldowns[name]
          const status: 'ok' | 'no_key' | 'cooldown' | 'down' =
            !enabled ? 'no_key' :
            cool ? 'cooldown' :
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
          providers.push({ name, status, models })
          void PROVIDER_PROFILES
        }

        // Ollama: running vs on-disk. "recommended" = running.
        if (system.ollama) {
          const [running, all] = await Promise.all([
            (system.ollama.runningModels?.() ?? Promise.resolve([] as string[])).catch(() => [] as string[]),
            system.ollama.models().catch(() => [] as string[]),
          ])
          const runSet = new Set(running)
          const cool = cooldowns.ollama
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
            models,
          })
        }

        // Default model pick — first curated entry of the first "ok" provider
        // in the preferred order, prefixed with the provider name.
        let defaultModel = ''
        for (const prov of DEFAULT_PREFERENCE_ORDER) {
          const p = providers.find(x => x.name === prov && x.status === 'ok')
          if (!p || p.models.length === 0) continue
          defaultModel = prov === 'ollama' ? p.models[0]!.id : `${prov}:${p.models[0]!.id}`
          break
        }
        if (!defaultModel) {
          // Fallback: first model of first ok provider
          const p = providers.find(x => x.status === 'ok' && x.models.length > 0)
          if (p) defaultModel = p.name === 'ollama' ? p.models[0]!.id : `${p.name}:${p.models[0]!.id}`
        }

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
