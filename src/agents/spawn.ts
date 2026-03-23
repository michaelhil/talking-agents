// ============================================================================
// Spawn — Wiring functions that create agents and connect them to the system.
// Creates agent → adds to team → joins rooms → posts join messages.
// Wires the onDecision callback to bridge agent decisions to postAndDeliver.
//
// resolveTarget translates LLM names → internal UUIDs using findByName.
// toolExecutor bridges agent tool calls to the global tool registry.
// ============================================================================

import type {
  Agent,
  AIAgent,
  AIAgentConfig,
  House,
  LLMProvider,
  MessageTarget,
  PostAndDeliver,
  Room,
  Team,
  Tool,
  ToolCall,
  ToolContext,
  ToolExecutor,
  ToolRegistry,
  ToolResult,
} from '../core/types.ts'
import { createAIAgent } from './ai-agent.ts'
import type { Decision } from './ai-agent.ts'
import { executeActions } from './actions.ts'
import { makeJoinMetadata } from './shared.ts'

// --- Tool support ---

const formatToolDescriptions = (tools: ReadonlyArray<Tool>): string => {
  if (tools.length === 0) return ''
  const lines = tools.map(t => {
    const params = Object.keys(t.parameters).length > 0
      ? ` Parameters: ${JSON.stringify(t.parameters)}`
      : ' No parameters.'
    return `- ${t.name}: ${t.description}${params}`
  })
  return `Available tools:\n${lines.join('\n')}`
}

const createToolExecutor = (
  registry: ToolRegistry,
  allowedTools: ReadonlyArray<string>,
  context: ToolContext,
): ToolExecutor => {
  const allowed = new Set(allowedTools)

  return async (calls: ReadonlyArray<ToolCall>): Promise<ReadonlyArray<ToolResult>> => {
    const results: ToolResult[] = []

    for (const call of calls) {
      if (!allowed.has(call.tool)) {
        results.push({ success: false, error: `Tool "${call.tool}" is not available` })
        continue
      }

      const tool = registry.get(call.tool)
      if (!tool) {
        results.push({ success: false, error: `Tool "${call.tool}" not found` })
        continue
      }

      try {
        const result = await tool.execute(call.arguments, context)
        results.push(result)
      } catch (err) {
        results.push({ success: false, error: err instanceof Error ? err.message : 'Tool execution failed' })
      }
    }

    return results
  }
}

// --- Spawn AI Agent ---

export const spawnAIAgent = async (
  config: AIAgentConfig,
  llmProvider: LLMProvider,
  house: House,
  team: Team,
  postAndDeliver: PostAndDeliver,
  toolRegistry?: ToolRegistry,
): Promise<AIAgent> => {

  // Resolve LLM names to internal UUIDs via findByName.
  const resolveTarget = (decision: Decision): MessageTarget => {
    if (decision.response.action !== 'respond') return {}

    const target = decision.response.target
    if (target && ((target.rooms && target.rooms.length > 0) || (target.agents && target.agents.length > 0))) {
      const resolvedRooms = target.rooms
        ?.map(name => house.findByName(name)?.profile.id)
        .filter((id): id is string => id !== undefined)

      const resolvedAgents = target.agents
        ?.map(name => team.findByName(name)?.id)
        .filter((id): id is string => id !== undefined)

      // If all names failed resolution, fall back to trigger source
      const hasResolved = (resolvedRooms && resolvedRooms.length > 0) || (resolvedAgents && resolvedAgents.length > 0)
      if (hasResolved) return { rooms: resolvedRooms, agents: resolvedAgents }
    }

    // Fallback: respond where the trigger came from
    if (decision.triggerRoomId) return { rooms: [decision.triggerRoomId] }
    if (decision.triggerPeerId) return { agents: [decision.triggerPeerId] }
    return {}
  }

  const onDecision = (decision: Decision): void => {
    if (decision.response.action === 'respond') {
      const target = resolveTarget(decision)
      postAndDeliver(target, {
        senderId: agent.id,
        content: decision.response.content,
        type: 'chat',
        generationMs: decision.generationMs,
      })
    }

    const actions = decision.response.actions
    if (actions && actions.length > 0) {
      executeActions(actions, agent.id, agent.name, house, team, postAndDeliver)
        .catch(err => console.error(`[${config.name}] Action execution failed:`, err))
    }
  }

  // Build tool support if agent has tools configured
  const agentTools = config.tools ?? []
  let toolExecutor: ToolExecutor | undefined
  let toolDescriptions: string | undefined

  if (toolRegistry && agentTools.length > 0) {
    const availableTools = agentTools
      .map(name => toolRegistry.get(name))
      .filter((t): t is Tool => t !== undefined)

    if (availableTools.length > 0) {
      // Late-binding context: agent is created after this, but executor is called later
      const lazyContext: ToolContext = {
        get callerId() { return agent.id },
        get callerName() { return agent.name },
      }
      toolExecutor = createToolExecutor(toolRegistry, agentTools, lazyContext)
      toolDescriptions = formatToolDescriptions(availableTools)
    }
  }

  const agent = createAIAgent(config, llmProvider, onDecision, { toolExecutor, toolDescriptions })
  team.add(agent)

  const publicRooms = house.listPublicRooms()
  for (const roomProfile of publicRooms) {
    const room = house.getRoom(roomProfile.id)
    if (!room) continue

    room.addMember(agent.id)
    await agent.join(room)

    postAndDeliver(
      { rooms: [room.profile.id] },
      { senderId: agent.id, content: `[${agent.name}] has joined`, type: 'join', metadata: makeJoinMetadata(agent) },
    )
  }

  return agent
}

export const spawnHumanAgent = async (
  agent: Agent,
  house: House,
  team: Team,
  postAndDeliver: PostAndDeliver,
  roomsToJoin?: ReadonlyArray<Room>,
): Promise<Agent> => {
  team.add(agent)

  const rooms = roomsToJoin ?? house.listPublicRooms().map(
    profile => house.getRoom(profile.id),
  ).filter((r): r is Room => r !== undefined)

  for (const room of rooms) {
    room.addMember(agent.id)
    await agent.join(room)
    postAndDeliver(
      { rooms: [room.profile.id] },
      { senderId: agent.id, content: `[${agent.name}] has joined`, type: 'join', metadata: makeJoinMetadata(agent) },
    )
  }

  return agent
}
