import { json, errorResponse, parseBody } from '../http-routes.ts'
import type { RouteEntry } from './types.ts'

export const houseRoutes: RouteEntry[] = [
  {
    method: 'GET',
    pattern: /^\/health$/,
    handler: (_req, _match, { system }) => {
      const health = system.ollama.getHealth()
      return json({
        status: 'ok',
        ollama: health.status !== 'down',
        ollamaStatus: health.status,
        ollamaLatencyMs: health.latencyMs,
        rooms: system.house.listAllRooms().length,
        agents: system.team.listAgents().length,
      })
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/tools$/,
    handler: (_req, _match, { system }) =>
      json(system.toolRegistry.list().map(t => ({ name: t.name, description: t.description }))),
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
      system.skillStore.register({ name, description, body: skillBody, scope, tools: [], dirPath })
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
      try {
        const [running, all] = await Promise.all([
          (system.ollama.runningModels?.() ?? Promise.resolve([] as string[])).catch(() => [] as string[]),
          system.ollama.models().catch(() => [] as string[]),
        ])
        const runningSet = new Set(running)
        const available = all.filter(m => !runningSet.has(m))
        return json({ running, available })
      } catch {
        return json({ running: [], available: [] })
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
