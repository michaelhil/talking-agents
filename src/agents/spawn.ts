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
import { formatToolDescriptions } from '../tools/format.ts'

// --- Tool executor ---

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

// --- Tool support resolution ---
// Extracted so it is independently named and testable.
// Uses an agentRef (filled after agent creation) so the lazy ToolContext
// captures the agent's id/name without a circular dependency.

interface AgentToolSupport {
  readonly toolExecutor?: ToolExecutor
  readonly toolDescriptions?: string
  readonly toolDefinitions?: ReadonlyArray<ToolDefinition>
}

const warnMissingTools = (agentName: string, requested: ReadonlyArray<string>, registry: ToolRegistry): void => {
  const missing = requested.filter(n => !registry.has(n))
  if (missing.length > 0)
    console.warn(`[spawn] Agent "${agentName}": tools not found in registry: ${missing.join(', ')}`)
}

// Chooses between native tool calling (definitions) and text-injected descriptions.
// Native: model supports tool_use API — structured JSON calls.
// Text: model does not — tools described in system prompt, parsed from response.
const selectProtocol = async (
  availableTools: ReadonlyArray<Tool>,
  executor: ToolExecutor,
  model: string,
  capabilityCache: ToolCapabilityCache | undefined,
): Promise<AgentToolSupport> => {
  const useNativeTools = capabilityCache ? await capabilityCache.probe(model) : false
  if (useNativeTools) {
    return { toolExecutor: executor, toolDefinitions: toolsToDefinitions(availableTools) }
  }
  return { toolExecutor: executor, toolDescriptions: formatToolDescriptions(availableTools) }
}

const resolveAgentTools = async (
  config: AIAgentConfig,
  toolRegistry: ToolRegistry | undefined,
  capabilityCache: ToolCapabilityCache | undefined,
  agentRef: { id: string; name: string },
): Promise<AgentToolSupport> => {
  const requestedTools = config.tools ?? toolRegistry?.list().map(t => t.name) ?? []
  if (!toolRegistry || requestedTools.length === 0) return {}

  const availableTools = requestedTools
    .map(name => toolRegistry.get(name))
    .filter((t): t is Tool => t !== undefined)

  if (availableTools.length < requestedTools.length) {
    warnMissingTools(config.name, requestedTools, toolRegistry)
  }

  if (availableTools.length === 0) return {}

  // Late-binding context: agentRef is filled after createAIAgent returns
  const lazyContext: ToolContext = {
    get callerId() { return agentRef.id },
    get callerName() { return agentRef.name },
  }
  const toolExecutor = createToolExecutor(toolRegistry, requestedTools, lazyContext)

  return selectProtocol(availableTools, toolExecutor, config.model, capabilityCache)
}

// --- Spawn AI Agent ---

export interface SpawnOptions {
  readonly overrideId?: string
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

  // Resolve tool support — agentRef filled after agent creation (lazy context)
  const agentRef = { id: '', name: '' }
  const toolSupport = await resolveAgentTools(config, toolRegistry, spawnOptions?.toolCapabilityCache, agentRef)

  const agent = createAIAgent(config, llmProvider, onDecision, {
    ...toolSupport,
    getHousePrompt: () => house.getHousePrompt(),
    getResponseFormat: () => house.getResponseFormat(),
    getRoomTodos: (roomId: string) => {
      const room = house.getRoom(roomId)
      return room ? room.getTodos() : []
    },
  }, spawnOptions?.overrideId)

  // Fill agentRef so the lazy ToolContext in resolveAgentTools resolves correctly
  agentRef.id = agent.id
  agentRef.name = agent.name

  team.addAgent(agent)

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

  const rooms = roomsToJoin ?? house.listAllRooms().map(
    profile => house.getRoom(profile.id),
  ).filter((r): r is Room => r !== undefined)

  await Promise.all(rooms.map(room =>
    addAgentToRoom(agent.id, agent.name, room.profile.id, undefined, team, routeMessage, house),
  ))

  return agent
}
