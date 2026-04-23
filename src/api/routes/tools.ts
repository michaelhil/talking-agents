// Tool inspection + hot-reload.
//
//   GET  /api/tools         — list (name, description) for the sidebar
//   GET  /api/tools/:name   — full detail: schema, source path, enabledFor;
//                             source code included only for non-built-in tools
//                             when the request originates from localhost.
//
// The source-serving gate protects users who later bind the server to a
// non-loopback address. The check is socket-based (server.requestIP) — not
// header-based — so it cannot be spoofed via Host / X-Forwarded-For.

import { readFile } from 'node:fs/promises'
import type { AIAgent } from '../../core/types/agent.ts'
import { rescanExternalTools } from '../../tools/loader.ts'
import { json, errorResponse } from './helpers.ts'
import type { RouteEntry } from './types.ts'

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'])

const isLoopback = (address: string | undefined): boolean =>
  !!address && LOOPBACK.has(address)

export const toolRoutes: RouteEntry[] = [
  {
    method: 'GET',
    pattern: /^\/api\/tools$/,
    handler: (_req, _match, { system }) =>
      json(system.toolRegistry.list().map(t => ({ name: t.name, description: t.description }))),
  },
  {
    method: 'POST',
    pattern: /^\/api\/tools\/rescan$/,
    handler: async (_req, _match, { system }) => {
      const result = await rescanExternalTools(system.toolRegistry)
      // Refresh every agent's tool list so newly-registered tools reach
      // already-spawned agents and removed ones drop out.
      try {
        await system.refreshAllAgentTools()
      } catch (err) {
        console.error('[tools/rescan] refreshAllAgentTools failed:', err)
      }
      return json(result)
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/tools\/([^/]+)$/,
    handler: async (_req, match, { system, remoteAddress }) => {
      const name = decodeURIComponent(match[1]!)
      const entry = system.toolRegistry.getEntry(name)
      if (!entry) return errorResponse(`Tool "${name}" not found`, 404)

      const { tool, source } = entry

      // enabledFor: iterate AI agents. getTools() returning undefined means
      // the agent has implicit access to every registered tool.
      const enabledFor = system.team.listByKind('ai').reduce<Array<{ id: string; name: string }>>((acc, agent) => {
        const ai = agent as AIAgent
        const toolList = ai.getTools?.()
        const hasIt = toolList === undefined || toolList.includes(name)
        if (hasIt) acc.push({ id: ai.id, name: ai.name })
        return acc
      }, [])

      // Serve source bytes only for disk-backed tools, and only when the caller
      // is on loopback. Local dev gets the viewer; any other bind address
      // returns detail without code.
      let code: string | undefined
      if (source.kind !== 'built-in' && source.path && isLoopback(remoteAddress)) {
        try {
          code = await readFile(source.path, 'utf-8')
        } catch {
          // file deleted since registration — treat as missing source, not error
        }
      }

      return json({
        name: tool.name,
        description: tool.description,
        usage: tool.usage,
        returns: tool.returns,
        parameters: tool.parameters,
        source: {
          kind: source.kind,
          path: source.path,
          skill: source.skill,
          ...(code !== undefined ? { code } : {}),
        },
        enabledFor,
      })
    },
  },
]
