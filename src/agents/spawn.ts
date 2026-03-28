// ============================================================================
// Spawn — Wiring functions that create agents and connect them to the system.
// Creates agent → adds to team → joins rooms → posts join messages.
// Wires the onDecision callback to bridge agent decisions to routeMessage.
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
  RouteMessage,
  Room,
  Team,
  Tool,
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolExecutor,
  ToolRegistry,
  ToolResult,
} from '../core/types.ts'
import { createAIAgent } from './ai-agent.ts'
import type { Decision } from './ai-agent.ts'
import { addAgentToRoom } from './actions.ts'
import { createToolCapabilityCache, toolsToDefinitions } from '../llm/tool-capability.ts'
import type { ToolCapabilityCache } from '../llm/tool-capability.ts'

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

  return async (calls: ReadonlyArray<ToolCall>, roomId?: string): Promise<ReadonlyArray<ToolResult>> => {
    const results: ToolResult[] = []
    const callContext: ToolContext = roomId ? { ...context, roomId } : context

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
        const result = await tool.execute(call.arguments, callContext)
        results.push(result)
      } catch (err) {
        results.push({ success: false, error: err instanceof Error ? err.message : 'Tool execution failed' })
      }
    }

    return results
  }
}

// --- Spawn AI Agent ---

export interface SpawnOptions {
  readonly overrideId?: string
  readonly skipAutoJoin?: boolean
  readonly toolCapabilityCache?: ToolCapabilityCache
}

export const spawnAIAgent = async (
  config: AIAgentConfig,
  llmProvider: LLMProvider,
  house: House,
  team: Team,
  routeMessage: RouteMessage,
  toolRegistry?: ToolRegistry,
  spawnOptions?: SpawnOptions,
): Promise<AIAgent> => {

  // Resolve target: respond where the trigger came from
  const resolveTarget = (decision: Decision): MessageTarget => {
    if (decision.triggerRoomId) return { rooms: [decision.triggerRoomId] }
    if (decision.triggerPeerId) return { agents: [decision.triggerPeerId] }
    return {}
  }

  const onDecision = (decision: Decision): void => {
    const target = resolveTarget(decision)

    if (decision.response.action === 'respond') {
      routeMessage(target, {
        senderId: agent.id,
        senderName: agent.name,
        content: decision.response.content,
        type: 'chat',
        generationMs: decision.generationMs,
      })
    } else if (decision.response.action === 'pass' && decision.triggerRoomId) {
      // Post pass as a visible message so humans can see agent decisions
      const reason = decision.response.reason ?? 'nothing to add'
      routeMessage(target, {
        senderId: agent.id,
        senderName: agent.name,
        content: `[pass] ${reason}`,
        type: 'pass',
        generationMs: decision.generationMs,
      })
    }
  }

  // Build tool support — auto-assign all registered tools when none specified
  const agentTools = config.tools ?? toolRegistry?.list().map(t => t.name) ?? []
  let toolExecutor: ToolExecutor | undefined
  let toolDescriptions: string | undefined
  let toolDefinitions: ReadonlyArray<ToolDefinition> | undefined

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

      // Probe whether this model supports native tool calling
      const useNativeTools = spawnOptions?.toolCapabilityCache
        ? await spawnOptions.toolCapabilityCache.probe(config.model)
        : false

      if (useNativeTools) {
        // Native: pass tool definitions directly in the LLM request
        toolDefinitions = toolsToDefinitions(availableTools)
        // toolDescriptions intentionally left undefined — no text-protocol instructions needed
      } else {
        // Text protocol: inject tool descriptions into the system prompt
        toolDescriptions = formatToolDescriptions(availableTools)
      }
    }
  }

  const agent = createAIAgent(config, llmProvider, onDecision, {
    toolExecutor,
    toolDescriptions,
    toolDefinitions,
    getHousePrompt: () => house.getHousePrompt(),
    getResponseFormat: () => house.getResponseFormat(),
    getRoomTodos: (roomId: string) => {
      const room = house.getRoom(roomId)
      return room ? room.getTodos() : []
    },
  }, spawnOptions?.overrideId)
  team.addAgent(agent)

  if (!spawnOptions?.skipAutoJoin) {
    const publicRooms = house.listPublicRooms()
    await Promise.all(publicRooms.map(roomProfile =>
      addAgentToRoom(agent.id, agent.name, roomProfile.id, undefined, team, routeMessage, house),
    ))
  }

  return agent
}

export const spawnHumanAgent = async (
  agent: Agent,
  house: House,
  team: Team,
  routeMessage: RouteMessage,
  roomsToJoin?: ReadonlyArray<Room>,
): Promise<Agent> => {
  team.addAgent(agent)

  const rooms = roomsToJoin ?? house.listPublicRooms().map(
    profile => house.getRoom(profile.id),
  ).filter((r): r is Room => r !== undefined)

  await Promise.all(rooms.map(room =>
    addAgentToRoom(agent.id, agent.name, room.profile.id, undefined, team, routeMessage, house),
  ))

  return agent
}
