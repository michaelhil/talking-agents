// ============================================================================
// Spawn — Wiring functions that create agents and connect them to the system.
// Creates agent → adds to team → joins rooms → posts join messages.
// Wires the onDecision callback to bridge agent decisions to routeMessage.
//
// resolveTarget translates LLM names → internal UUIDs using findByName.
// toolExecutor bridges agent tool calls to the global tool registry.
// ============================================================================

import type { Agent, AIAgent, AIAgentConfig, RouteMessage, Team } from '../core/types/agent.ts'
import type { House, Room } from '../core/types/room.ts'
import type { LLMProvider } from '../core/types/llm.ts'
import type { MessageTarget } from '../core/types/messaging.ts'
import type { Tool, ToolCall, ToolContext, ToolDefinition, ToolExecutor, ToolRegistry, ToolResult } from '../core/types/tool.ts'
import { createAIAgent } from './ai-agent.ts'
import type { Decision } from './ai-agent.ts'
import { callLLM, streamLLM } from './evaluation.ts'
import { addAgentToRoom } from './actions.ts'
import { toolsToDefinitions } from '../llm/tool-capability.ts'

// --- Tool executor ---

// Optional per-room whitelist resolver. Returns the set of tool names that
// active skills permit in `roomId`, or null when no skill in scope declares
// a whitelist (= unrestricted, today's behavior). When non-null, the
// executor intersects this with the agent's spawn-time `allowedTools`.
//
// Why per-room and per-call: skills are room-scoped (skillStore.forScope)
// but agents can be members of multiple rooms. A spawn-time intersection
// would freeze the whitelist to whichever room the agent first joined.
export type GetAllowedToolsForRoom = (roomId: string) => ReadonlySet<string> | null

const createToolExecutor = (
  registry: ToolRegistry,
  allowedTools: ReadonlyArray<string>,
  context: ToolContext,
  getAllowedToolsForRoom?: GetAllowedToolsForRoom,
): ToolExecutor => {
  const allowed = new Set(allowedTools)

  return async (calls: ReadonlyArray<ToolCall>, roomId?: string): Promise<ReadonlyArray<ToolResult>> => {
    const results: ToolResult[] = []
    const callContext: ToolContext = roomId ? { ...context, roomId } : context

    // Resolve the per-room skill whitelist once per executor invocation.
    // Null = unrestricted (no skill in this room declared allowed-tools).
    const skillWhitelist = roomId && getAllowedToolsForRoom ? getAllowedToolsForRoom(roomId) : null

    for (const call of calls) {
      if (!allowed.has(call.tool)) {
        results.push({ success: false, error: `Tool "${call.tool}" is not available` })
        continue
      }
      if (skillWhitelist && !skillWhitelist.has(call.tool)) {
        // Pass is always permitted — agents must be able to decline.
        if (call.tool !== 'pass') {
          const allowedList = [...skillWhitelist].sort().join(', ')
          results.push({
            success: false,
            error: `Tool "${call.tool}" not allowed by active skills in this room. Allowed: ${allowedList}.`,
          })
          continue
        }
      }

      const tool = registry.get(call.tool)
      if (!tool) {
        results.push({ success: false, error: `Tool "${call.tool}" not found` })
        continue
      }

      try {
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Tool "${call.tool}" timed out after 30s`)), 30_000),
        )
        const result = await Promise.race([tool.execute(call.arguments, callContext), timeout])
        results.push(result)
      } catch (err) {
        results.push({ success: false, error: err instanceof Error ? err.message : 'Tool execution failed' })
      }
    }

    return results
  }
}

// Test seam — executor isn't part of the public spawn API but is the
// load-bearing piece for per-room allowed-tools enforcement. Exported so
// tests can construct an executor directly without standing up an agent.
export const __testSeam = { createToolExecutor }

// --- Tool support resolution ---
// Extracted so it is independently named and testable.
// Uses an agentRef (filled after agent creation) so the lazy ToolContext
// captures the agent's id/name without a circular dependency.

export interface AgentToolSupport {
  readonly toolExecutor?: ToolExecutor
  readonly toolDefinitions?: ReadonlyArray<ToolDefinition>
}

const warnMissingTools = (agentName: string, requested: ReadonlyArray<string>, registry: ToolRegistry): void => {
  const missing = requested.filter(n => !registry.has(n))
  if (missing.length > 0)
    console.warn(`[spawn] Agent "${agentName}": tools not found in registry: ${missing.join(', ')}`)
}

// Build tool support — always uses native tool calling.
// The pass tool is auto-injected so all agents can decline to respond.
// `seed`, when provided, is threaded into every tool-initiated LLM sub-call
// so reproducibility extends past the agent's main turn.
export const buildToolSupport = async (
  toolNames: ReadonlyArray<string>,
  registry: ToolRegistry,
  agentRef: { readonly id: string; readonly name: string; readonly currentModel?: () => string },
  llmProvider: LLMProvider,
  maxResultChars?: number,
  seed?: number,
  getAllowedToolsForRoom?: GetAllowedToolsForRoom,
): Promise<AgentToolSupport> => {
  // Always include the pass tool (auto-injected for all agents)
  const allToolNames = toolNames.includes('pass') ? toolNames : [...toolNames, 'pass']

  const availableTools = allToolNames
    .map(name => registry.get(name))
    .filter((t): t is Tool => t !== undefined)

  if (availableTools.length === 0) return {}

  const lazyContext: ToolContext = {
    get callerId() { return agentRef.id },
    get callerName() { return agentRef.name },
    llm: (request) => callLLM(llmProvider, {
      ...request,
      model: agentRef.currentModel?.() ?? '',
      ...(seed !== undefined ? { seed } : {}),
    }),
    llmStream: (request) => streamLLM(llmProvider, {
      ...request,
      model: agentRef.currentModel?.() ?? '',
      ...(seed !== undefined ? { seed } : {}),
    }),
    maxResultChars,
  }
  const executor = createToolExecutor(registry, allToolNames, lazyContext, getAllowedToolsForRoom)
  return { toolExecutor: executor, toolDefinitions: toolsToDefinitions(availableTools) }
}

const resolveAgentTools = async (
  config: AIAgentConfig,
  llmProvider: LLMProvider,
  toolRegistry: ToolRegistry | undefined,
  agentRef: { id: string; name: string },
  getAllowedToolsForRoom?: GetAllowedToolsForRoom,
): Promise<AgentToolSupport> => {
  const requestedTools = config.tools ?? toolRegistry?.list().map(t => t.name) ?? []
  if (!toolRegistry) return {}

  if (requestedTools.length > 0) {
    warnMissingTools(config.name, requestedTools, toolRegistry)
  }

  return buildToolSupport(requestedTools, toolRegistry, agentRef, llmProvider, config.maxToolResultChars, config.seed, getAllowedToolsForRoom)
}

// --- Spawn AI Agent ---

export interface SpawnOptions {
  readonly overrideId?: string
  readonly getSkills?: (roomName: string) => string
  // Resolves the per-room+per-agent wikis catalog text. The agent's effective
  // wiki bindings are room.wikiBindings ∪ agent.wikiBindings; this resolver
  // applies the union and returns the rendered catalog.
  readonly getWikisCatalog?: (roomId: string, agentId: string) => string
  readonly getScriptContext?: (roomId: string, agentName: string) =>
    | { systemDoc: string; dialogue: ReadonlyArray<{ speaker: string; content: string }> }
    | undefined
  readonly onEvalEvent?: (agentName: string, event: import('../core/types/agent-eval.ts').EvalEvent) => void
  // Per-room allowed-tools resolver. When provided, the tool executor
  // intersects the agent's spawn-time toolset with this room's skill
  // whitelist on every call. See createToolExecutor for semantics.
  readonly getAllowedToolsForRoom?: GetAllowedToolsForRoom
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
  // Validate name before any expensive work — prevents orphaned agent creation on collision
  if (team.getAgent(config.name)) {
    throw new Error(`Agent name "${config.name}" is already taken`)
  }

  const onDecision = (decision: Decision): void => {
    const target: MessageTarget = { rooms: [decision.triggerRoomId] }
    // Metrics — tokens, contextMax, provider — flow as typed optional fields
    // on the posted message. Undefined fields are omitted to keep snapshots
    // compact and to satisfy the exactOptionalPropertyTypes tsconfig.
    const m = decision.metrics ?? {}
    const telemetry = {
      ...(m.promptTokens !== undefined ? { promptTokens: m.promptTokens } : {}),
      ...(m.completionTokens !== undefined ? { completionTokens: m.completionTokens } : {}),
      ...(m.contextMax !== undefined && m.contextMax > 0 ? { contextMax: m.contextMax } : {}),
      ...(m.provider ? { provider: m.provider } : {}),
      ...(m.model ? { model: m.model } : {}),
    }

    if (decision.response.action === 'respond') {
      routeMessage(target, {
        senderId: agent.id,
        senderName: agent.name,
        content: decision.response.content,
        type: 'chat',
        generationMs: decision.generationMs,
        inReplyTo: decision.inReplyTo,
        ...telemetry,
        ...(decision.toolTrace && decision.toolTrace.length > 0 ? { toolTrace: decision.toolTrace } : {}),
      })
    } else if (decision.response.action === 'pass') {
      // Post pass as a visible message so humans can see agent decisions
      const reason = decision.response.reason ?? 'nothing to add'
      routeMessage(target, {
        senderId: agent.id,
        senderName: agent.name,
        content: `[pass] ${reason}`,
        type: 'pass',
        generationMs: decision.generationMs,
        inReplyTo: decision.inReplyTo,
        ...telemetry,
      })
    } else {
      // action: 'error' — LLM/transport failure, distinct from a pass decision.
      // Renders as a red chip in the UI; the errorCode drives any "Change model"
      // affordance. NEVER conflate with `pass` — pass is an agent decision,
      // error is a system failure the user should see and act on.
      const err = decision.response
      routeMessage(target, {
        senderId: agent.id,
        senderName: agent.name,
        content: `[error: ${err.code}] ${err.message}`,
        type: 'error',
        errorCode: err.code,
        ...(err.providerHint ? { errorProvider: err.providerHint } : {}),
        generationMs: decision.generationMs,
        inReplyTo: decision.inReplyTo,
        ...telemetry,
      })
    }
  }

  // Resolve tool support — agentRef filled after agent creation (lazy context)
  const agentRef = { id: '', name: '' }
  const toolSupport = await resolveAgentTools(config, llmProvider, toolRegistry, agentRef, spawnOptions?.getAllowedToolsForRoom)

  const agent = createAIAgent(config, llmProvider, onDecision, {
    ...toolSupport,
    getHousePrompt: () => house.getHousePrompt(),
    getResponseFormat: () => house.getResponseFormat(),
    getArtifactsForScope: (roomId: string) => house.artifacts.getForScope(roomId),
    getArtifactTypeDef: (type: string) => house.artifactTypes.get(type),
    getCompressedIds: (roomId: string) => house.getRoom(roomId)?.getCompressedIds() ?? new Set(),
    getRoomMembers: (roomId: string) => {
      const room = house.getRoom(roomId)
      if (!room) return []
      const profiles: Array<import('../core/types/messaging.ts').AgentProfile> = []
      for (const id of room.getParticipantIds()) {
        const a = team.getAgent(id)
        if (a) profiles.push({ id: a.id, name: a.name, kind: a.kind, ...(a.metadata?.tags ? { tags: a.metadata.tags as ReadonlyArray<string> } : {}) })
      }
      return profiles
    },
    getSkills: spawnOptions?.getSkills,
    getWikisCatalog: spawnOptions?.getWikisCatalog,
    getScriptContext: spawnOptions?.getScriptContext,
    onEvalEvent: spawnOptions?.onEvalEvent,
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
