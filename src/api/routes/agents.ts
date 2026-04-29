import { json, errorResponse, parseBody } from './helpers.ts'
import { asAIAgent } from '../../agents/shared.ts'
import { buildToolSupport } from '../../agents/spawn.ts'
import { toolsToDefinitions } from '../../llm/tool-capability.ts'
import { modelSupportsTools } from '../../llm/models/catalog.ts'
import { estimateTokens } from '../../agents/context-builder.ts'
import type { ContextSection, IncludeContext, IncludePrompts, PromptSection } from '../../core/types/agent.ts'
import type { ToolRegistry } from '../../core/types/tool.ts'
import type { RouteEntry } from './types.ts'

const PROMPT_SECTIONS: ReadonlyArray<PromptSection> = ['persona', 'room', 'house', 'responseFormat', 'skills']
const CONTEXT_SECTIONS: ReadonlyArray<ContextSection> = ['participants', 'artifacts', 'activity', 'knownAgents']

// Compute approximate token cost of each registered tool's definition.
// Uses the standard 4-chars-per-token heuristic across JSON-serialised defs.
const computeToolTokens = (toolNames: ReadonlyArray<string>, registry: ToolRegistry): Record<string, number> => {
  const result: Record<string, number> = {}
  const tools = toolNames.map(n => registry.get(n)).filter((t): t is NonNullable<ReturnType<typeof registry.get>> => t !== undefined)
  const defs = toolsToDefinitions(tools)
  for (const def of defs) {
    result[def.function.name] = estimateTokens(JSON.stringify(def))
  }
  return result
}

const sanitizeIncludePrompts = (raw: unknown): IncludePrompts | undefined => {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const out: IncludePrompts = {}
  for (const key of PROMPT_SECTIONS) {
    if (typeof r[key] === 'boolean') out[key] = r[key] as boolean
  }
  return Object.keys(out).length > 0 ? out : undefined
}

const sanitizeIncludeContext = (raw: unknown): IncludeContext | undefined => {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const out: IncludeContext = {}
  for (const key of CONTEXT_SECTIONS) {
    if (typeof r[key] === 'boolean') out[key] = r[key] as boolean
  }
  return Object.keys(out).length > 0 ? out : undefined
}

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
        detail.persona = aiAgent.getPersona()
        detail.model = aiAgent.getModel()
        detail.temperature = aiAgent.getTemperature()
        detail.historyLimit = aiAgent.getHistoryLimit()
        detail.thinking = aiAgent.getThinking()
        detail.tools = aiAgent.getTools()
        detail.includePrompts = aiAgent.getIncludePrompts()
        detail.includeContext = aiAgent.getIncludeContext()
        detail.includeTools = aiAgent.getIncludeTools()
        detail.promptsEnabled = aiAgent.getPromptsEnabled()
        detail.contextEnabled = aiAgent.getContextEnabled()
        detail.maxToolResultChars = aiAgent.getMaxToolResultChars()
        detail.maxToolIterations = aiAgent.getMaxToolIterations()
        // Registered tools + token cost estimates — enables per-tool UI panel
        const registered = system.toolRegistry.list().map(t => t.name)
        detail.registeredTools = registered
        detail.toolTokens = computeToolTokens(registered, system.toolRegistry)
      }
      if (agent.getDescription) {
        detail.description = agent.getDescription()
      }
      if (agent.getTags) {
        detail.tags = agent.getTags()
      }
      return json(detail)
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/agents$/,
    handler: async (req, _match, { system, instanceId, broadcast, broadcastToInstance }) => {
      const body = await parseBody(req)
      if (!body.name || !body.model || !body.persona) {
        return errorResponse('name, model, and persona are required')
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
        // subscribeAgentState happens automatically inside the wrapped
        // system.spawnAIAgent — see wireAgentTracking in bootstrap.ts.
        const agent = await system.spawnAIAgent({
          name: body.name as string,
          model: requestedModel,
          persona: body.persona as string,
          temperature: body.temperature as number | undefined,
          historyLimit: body.historyLimit as number | undefined,
        })
        const aiA = asAIAgent(agent)
        const evt = { type: 'agent_joined' as const, agent: { id: agent.id, name: agent.name, kind: agent.kind, ...(aiA ? { model: aiA.getModel() } : {}) } }
        if (broadcastToInstance) broadcastToInstance(instanceId, evt)
        else broadcast(evt)
        return json({ id: agent.id, name: agent.name }, 201)
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : 'Failed to create agent')
      }
    },
  },
  // Quick "create human" endpoint used by the send-as picker when the user
  // wants to post but has no humans in the system yet. Body: { name, roomName? }.
  // If roomName is provided, the new human is auto-added to that room.
  {
    method: 'POST',
    pattern: /^\/api\/agents\/human$/,
    handler: async (req, _match, { system, instanceId, broadcast, broadcastToInstance }) => {
      const body = await parseBody(req)
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!name) return errorResponse('name is required')
      try {
        const agent = await system.spawnHumanAgent({ name }, () => { /* no-op transport */ })
        if (typeof body.roomName === 'string' && body.roomName.trim()) {
          const room = system.house.getRoom(body.roomName.trim())
          if (room) {
            await system.addAgentToRoom(agent.id, room.profile.id)
          }
        }
        const evt = { type: 'agent_joined' as const, agent: { id: agent.id, name: agent.name, kind: agent.kind } }
        if (broadcastToInstance) broadcastToInstance(instanceId, evt)
        else broadcast(evt)
        return json({ id: agent.id, name: agent.name }, 201)
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : 'Failed to create human')
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
        if (body.persona) aiAgent.updatePersona(body.persona as string)
        if (body.model) aiAgent.updateModel(body.model as string)
        if (body.temperature !== undefined) aiAgent.updateTemperature?.(body.temperature as number | undefined)
        if (body.historyLimit !== undefined) aiAgent.updateHistoryLimit?.(body.historyLimit as number)
        if (body.thinking !== undefined) aiAgent.updateThinking?.(body.thinking as boolean)
        const inc = sanitizeIncludePrompts(body.includePrompts)
        if (inc) aiAgent.updateIncludePrompts(inc)
        const incCtx = sanitizeIncludeContext(body.includeContext)
        if (incCtx) aiAgent.updateIncludeContext(incCtx)
        if (typeof body.includeTools === 'boolean') aiAgent.updateIncludeTools(body.includeTools)
        if (typeof body.promptsEnabled === 'boolean') aiAgent.updatePromptsEnabled(body.promptsEnabled)
        if (typeof body.contextEnabled === 'boolean') aiAgent.updateContextEnabled(body.contextEnabled)
        if (body.maxToolResultChars === null) aiAgent.updateMaxToolResultChars(undefined)
        else if (typeof body.maxToolResultChars === 'number') aiAgent.updateMaxToolResultChars(body.maxToolResultChars)
        if (typeof body.maxToolIterations === 'number') aiAgent.updateMaxToolIterations(body.maxToolIterations)
        // Tool-list edits rebuild the agent's tool support so updated tools
        // reach the next LLM request. Rejects names not in the registry.
        if (Array.isArray(body.tools)) {
          const requested = (body.tools as unknown[]).filter((n): n is string => typeof n === 'string')
          const known = new Set(system.toolRegistry.list().map(t => t.name))
          const resolved = requested.filter(n => known.has(n))
          aiAgent.updateTools?.(resolved)
          const support = await buildToolSupport(
            resolved, system.toolRegistry,
            { id: aiAgent.id, name: aiAgent.name, currentModel: () => aiAgent.getModel() },
            system.llm,
          )
          aiAgent.refreshTools?.(support)
        }
      }
      if (typeof body.description === 'string' && agent.updateDescription) {
        agent.updateDescription(body.description)
      }
      if (Array.isArray(body.tags) && agent.updateTags) {
        const tags = (body.tags as unknown[])
          .filter((t): t is string => typeof t === 'string')
          .map(t => t.trim())
          .filter(t => t.length > 0)
        agent.updateTags(tags)
      }
      return json({ updated: true, name: agent.name })
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/agents\/([^/]+)\/context-preview$/,
    handler: (req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const agent = system.team.getAgent(name)
      if (!agent) return errorResponse(`Agent "${name}" not found`, 404)
      const ai = asAIAgent(agent)
      if (!ai) return errorResponse('Only AI agents have a context preview')
      const url = new URL(req.url)
      const roomIdParam = url.searchParams.get('roomId') ?? undefined
      const agentRooms = system.house.getRoomsForAgent(agent.id).map(r => r.profile.id)
      const roomId = roomIdParam && agentRooms.includes(roomIdParam)
        ? roomIdParam
        : agentRooms[0]
      if (!roomId) return errorResponse('Agent is not in any rooms', 400)
      const preview = ai.getContextPreview(roomId)
      const registered = system.toolRegistry.list().map(t => t.name)
      const model = ai.getConfig().model
      return json({
        ...preview,
        toolTokens: computeToolTokens(registered, system.toolRegistry),
        registeredTools: registered,
        modelSupportsTools: modelSupportsTools(model),
      })
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
    handler: (_req, match, { system, instanceId, broadcast, broadcastToInstance }) => {
      const name = decodeURIComponent(match[1]!)
      const agent = system.team.getAgent(name)
      if (!agent) return errorResponse(`Agent "${name}" not found`, 404)
      // unsubscribeAgentState happens automatically inside the wrapped
      // system.removeAgent — see wireAgentTracking in bootstrap.ts.
      system.removeAgent(agent.id)
      const evt = { type: 'agent_removed' as const, agentName: name }
      if (broadcastToInstance) broadcastToInstance(instanceId, evt)
      else broadcast(evt)
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
