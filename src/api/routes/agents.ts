import { json, errorResponse, parseBody } from '../http-routes.ts'
import { asAIAgent } from '../../agents/shared.ts'
import type { RouteEntry } from './types.ts'

export const agentRoutes: RouteEntry[] = [
  {
    method: 'GET',
    pattern: /^\/api\/agents$/,
    handler: (_req, _match, { system }) =>
      json(system.team.listAgents().map(a => ({
        id: a.id, name: a.name, kind: a.kind, state: a.state.get(),
      }))),
  },
  {
    method: 'GET',
    pattern: /^\/api\/agents\/([^/]+)\/rooms$/,
    handler: (_req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const agent = system.team.getAgent(name)
      if (!agent) return errorResponse(`Agent "${name}" not found`, 404)
      return json(system.house.getRoomsForAgent(agent.id).map(r => r.profile))
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/agents\/([^/]+)$/,
    handler: (_req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const agent = system.team.getAgent(name)
      if (!agent) return errorResponse(`Agent "${name}" not found`, 404)
      const detail: Record<string, unknown> = {
        id: agent.id, name: agent.name,
        kind: agent.kind, state: agent.state.get(), rooms: system.house.getRoomsForAgent(agent.id).map(r => r.profile.id),
      }
      const aiAgent = asAIAgent(agent)
      if (aiAgent) {
        detail.systemPrompt = aiAgent.getSystemPrompt()
        detail.model = aiAgent.getModel()
        detail.temperature = aiAgent.getTemperature()
        detail.historyLimit = aiAgent.getHistoryLimit()
        detail.thinking = aiAgent.getThinking()
        detail.tools = aiAgent.getTools()
      }
      if (agent.getDescription) {
        detail.description = agent.getDescription()
      }
      return json(detail)
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/agents$/,
    handler: async (req, _match, { system, broadcast, subscribeAgentState }) => {
      const body = await parseBody(req)
      if (!body.name || !body.model || !body.systemPrompt) {
        return errorResponse('name, model, and systemPrompt are required')
      }
      // Best-effort model validation — warn but don't block.
      // Use router-level model list (covers Ollama + cloud, prefixed) plus
      // Ollama's unprefixed list (back-compat for legacy agent configs).
      const ollamaAvailable = system.ollama?.getHealth().availableModels ?? []
      const routerAvailable = await system.llm.models().catch(() => [] as string[])
      const allAvailable = [...ollamaAvailable, ...routerAvailable]
      const requestedModel = body.model as string
      if (allAvailable.length > 0 && !allAvailable.includes(requestedModel)) {
        console.warn(`[agents] Model "${requestedModel}" not in available models.`)
      }
      try {
        const agent = await system.spawnAIAgent({
          name: body.name as string,
          model: requestedModel,
          systemPrompt: body.systemPrompt as string,
          temperature: body.temperature as number | undefined,
          historyLimit: body.historyLimit as number | undefined,
        })
        subscribeAgentState(agent.id, agent.name)
        const aiA = asAIAgent(agent)
        broadcast({ type: 'agent_joined', agent: { id: agent.id, name: agent.name, kind: agent.kind, ...(aiA ? { model: aiA.getModel() } : {}) } })
        return json({ id: agent.id, name: agent.name }, 201)
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : 'Failed to create agent')
      }
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/agents\/([^/]+)$/,
    handler: async (req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const agent = system.team.getAgent(name)
      if (!agent) return errorResponse(`Agent "${name}" not found`, 404)
      const body = await parseBody(req)
      const aiAgent = asAIAgent(agent)
      if (aiAgent) {
        if (body.systemPrompt) aiAgent.updateSystemPrompt(body.systemPrompt as string)
        if (body.model) aiAgent.updateModel(body.model as string)
        if (body.temperature !== undefined) aiAgent.updateTemperature?.(body.temperature as number | undefined)
        if (body.historyLimit !== undefined) aiAgent.updateHistoryLimit?.(body.historyLimit as number)
        if (body.thinking !== undefined) aiAgent.updateThinking?.(body.thinking as boolean)
      }
      if (typeof body.description === 'string' && agent.updateDescription) {
        agent.updateDescription(body.description)
      }
      return json({ updated: true, name: agent.name })
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/agents\/([^/]+)\/cancel$/,
    handler: (_req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const agent = system.team.getAgent(name)
      if (!agent) return errorResponse(`Agent "${name}" not found`, 404)
      const aiAgent = asAIAgent(agent)
      if (!aiAgent) return errorResponse('Only AI agents can be cancelled')
      aiAgent.cancelGeneration()
      return json({ cancelled: true, name: agent.name })
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/agents\/([^/]+)$/,
    handler: (_req, match, { system, broadcast, unsubscribeAgentState }) => {
      const name = decodeURIComponent(match[1]!)
      const agent = system.team.getAgent(name)
      if (!agent) return errorResponse(`Agent "${name}" not found`, 404)
      unsubscribeAgentState?.(agent.id)
      system.removeAgent(agent.id)
      broadcast({ type: 'agent_removed', agentName: name })
      return json({ removed: true })
    },
  },
  // --- Memory introspection ---
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
