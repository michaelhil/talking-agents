// Agent memory introspection routes — separated from routes/agents.ts to
// keep that file focused on agent CRUD + per-agent config. All five
// endpoints below operate on /api/agents/:name/memory[/...] paths.

import { json, errorResponse } from './helpers.ts'
import { asAIAgent } from '../../agents/shared.ts'
import type { RouteEntry } from './types.ts'

export const agentMemoryRoutes: RouteEntry[] = [
  {
    method: 'GET',
    pattern: /^\/api\/agents\/([^/]+)\/memory$/,
    handler: (_req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const agent = system.team.getAgent(name)
      if (!agent) return errorResponse(`Agent "${name}" not found`, 404)
      const ai = asAIAgent(agent)
      if (!ai?.getMemoryStats) return errorResponse('Only AI agents have memory stats')
      return json(ai.getMemoryStats())
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/agents\/([^/]+)\/memory\/([^/]+)$/,
    handler: (_req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const roomId = decodeURIComponent(match[2]!)
      const agent = system.team.getAgent(name)
      if (!agent) return errorResponse(`Agent "${name}" not found`, 404)
      const ai = asAIAgent(agent)
      if (!ai?.getHistory) return errorResponse('Only AI agents have memory')
      return json(ai.getHistory(roomId))
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/agents\/([^/]+)\/memory\/([^/]+)\/([^/]+)$/,
    handler: (_req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const roomId = decodeURIComponent(match[2]!)
      const messageId = decodeURIComponent(match[3]!)
      const agent = system.team.getAgent(name)
      if (!agent) return errorResponse(`Agent "${name}" not found`, 404)
      const ai = asAIAgent(agent)
      if (!ai?.deleteHistoryMessage) return errorResponse('Only AI agents have memory')
      const deleted = ai.deleteHistoryMessage(roomId, messageId)
      if (!deleted) return errorResponse('Message not found in agent history', 404)
      return json({ deleted: true, messageId })
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/agents\/([^/]+)\/memory\/([^/]+)$/,
    handler: (_req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const roomId = decodeURIComponent(match[2]!)
      const agent = system.team.getAgent(name)
      if (!agent) return errorResponse(`Agent "${name}" not found`, 404)
      const ai = asAIAgent(agent)
      if (!ai?.clearHistory) return errorResponse('Only AI agents have memory')
      ai.clearHistory(roomId)
      return json({ cleared: true, roomId })
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/agents\/([^/]+)\/memory$/,
    handler: (_req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const agent = system.team.getAgent(name)
      if (!agent) return errorResponse(`Agent "${name}" not found`, 404)
      const ai = asAIAgent(agent)
      if (!ai?.clearHistory) return errorResponse('Only AI agents have memory')
      ai.clearHistory()
      return json({ cleared: true })
    },
  },
]
