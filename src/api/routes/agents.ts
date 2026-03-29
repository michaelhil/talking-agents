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
      try {
        const agent = await system.spawnAIAgent({
          name: body.name as string,
          model: body.model as string,
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
      const aiAgent = asAIAgent(agent)
      if (!aiAgent) return errorResponse('Only AI agents can be updated')
      const body = await parseBody(req)
      if (body.systemPrompt) aiAgent.updateSystemPrompt(body.systemPrompt as string)
      if (body.model) aiAgent.updateModel(body.model as string)
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
]
