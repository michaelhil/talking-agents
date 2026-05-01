// Skills REST routes — split from house.ts so the skills domain has its
// own file like every other domain (rooms, agents, wikis, packs, etc.).
//
//   GET    /api/skills          — list (name, description, scope, tools)
//   GET    /api/skills/:name    — full detail (body included)
//   POST   /api/skills          — create new skill on disk + in-memory
//   PUT    /api/skills/:name    — update description/body/scope; preserves
//                                 allowed-tools across restart
//   DELETE /api/skills/:name    — rm -rf the skill dir + drop from store

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { json, errorResponse, parseBody } from './helpers.ts'
import type { RouteEntry } from './types.ts'

// Build the SKILL.md content from a Skill's persisted fields. Centralised so
// POST and PUT use the same shape — and so allowed-tools is never silently
// dropped by a route that forgets to write it.
const renderSkillMd = (
  name: string,
  description: string,
  body: string,
  scope: ReadonlyArray<string>,
  allowedToolNames: ReadonlyArray<string>,
): string => {
  const scopeLine = scope.length > 0 ? `\nscope: [${scope.join(', ')}]` : ''
  const allowedLine = allowedToolNames.length > 0
    ? `\nallowed-tools: [${allowedToolNames.join(', ')}]`
    : ''
  return `---\nname: ${name}\ndescription: ${description}${scopeLine}${allowedLine}\n---\n\n${body}\n`
}

export const skillRoutes: RouteEntry[] = [
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
      return json({
        name: skill.name,
        description: skill.description,
        body: skill.body,
        scope: skill.scope,
        tools: skill.tools,
      })
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
      const dirPath = join(system.skillsDir, name)
      await mkdir(dirPath, { recursive: true })
      const scope = Array.isArray(body.scope) ? body.scope as string[] : []
      await writeFile(
        join(dirPath, 'SKILL.md'),
        renderSkillMd(name, description, skillBody, scope, []),
        'utf-8',
      )
      system.skillStore.register({
        name, description, body: skillBody, scope,
        tools: [], allowedToolNames: [], dirPath,
      })
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
      // Preserve allowed-tools across restart. The previous version of this
      // route didn't write the allowed-tools frontmatter line, so an
      // operator who edited a skill via PUT would lose its allowed-tools
      // list on the next server restart (loader re-parses on-disk SKILL.md).
      // The body field isn't editable through this route today; if it
      // becomes editable, accept it from `body.allowedToolNames`.
      const newAllowed = skill.allowedToolNames
      await writeFile(
        join(skill.dirPath, 'SKILL.md'),
        renderSkillMd(name, newDesc, newBody, newScope, newAllowed),
        'utf-8',
      )
      system.skillStore.register({
        ...skill,
        description: newDesc,
        body: newBody,
        scope: newScope,
      })
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
      await rm(skill.dirPath, { recursive: true, force: true })
      system.skillStore.remove(name)
      return json({ deleted: true, name })
    },
  },
]
