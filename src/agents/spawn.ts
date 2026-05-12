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
import type { LLMService } from '../llm/llm-service.ts'
import type { MessageTarget } from '../core/types/messaging.ts'
import type { Tool, ToolCall, ToolContext, ToolDefinition, ToolExecutor, ToolRegistry, ToolResult } from '../core/types/tool.ts'
import { packNameFor } from '../core/types/tool-pack.ts'
import { createAIAgent } from './ai-agent.ts'
import type { Decision } from './ai-agent.ts'
import { callLLM, streamLLM } from './evaluation.ts'
import { addAgentToRoom } from './actions.ts'
import { createToolSurface, inferProviderFromModelRef, FAMILY_DISPATCHER_NAMES } from '../tool-surface/index.ts'
import { CURATED_MODELS } from '../llm/models/catalog.ts'

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

// Maps a registered tool to the pack that owns it. The mapping is the source
// of truth for "is this tool in the active surface for room X":
//
//   built-in        → 'core'   (immutable, always active)
//   external        → 'local'  (drop-in dir, default-active)
//   skill-bundled   → 'core' if no pack, else the pack the skill came from
//   pack-bundled    → the pack namespace (e.g. 'aviation')
//
// Per-room pack-activation filter moved into src/tool-surface/index.ts in
// the v0.13.0 tool-surface refactor — see project() there. spawn.ts now
// delegates to the surface for projection + family compression. The
// earlier 2000-token budget cap was removed (user-intent-authoritative —
// no silent trimming).

const createToolExecutor = (
  registry: ToolRegistry,
  allowedTools: ReadonlyArray<string>,
  context: ToolContext,
  getAllowedToolsForRoom?: GetAllowedToolsForRoom,
  getRoomActivation?: GetRoomActivation,
): ToolExecutor => {
  const allowed = new Set(allowedTools)

  // Pack-active tools must be callable even if they weren't in the
  // agent's spawn-time `allowedTools`. The surface's UNION semantics
  // shows pack tools to the LLM dynamically; the executor must mirror
  // that, otherwise the LLM sees the tool but the executor rejects
  // with "not available" — exactly the bug the diagnostic API caught
  // post-PR-1. Resolved per-call (cheap; same getRoomActivation the
  // surface uses).
  const allowedByActivation = (toolName: string, roomId: string | undefined): boolean => {
    if (!roomId || !getRoomActivation) return false
    const room = getRoomActivation(roomId)
    if (!room) return false
    const entry = registry.getEntry(toolName)
    if (!entry) return false
    const pack = packNameFor(entry)
    return new Set(['core', 'local', 'welcome', 'demos', ...room.getActivePacks()]).has(pack)
  }

  return async (calls: ReadonlyArray<ToolCall>, roomId?: string): Promise<ReadonlyArray<ToolResult>> => {
    const results: ToolResult[] = []
    const callContext: ToolContext = roomId ? { ...context, roomId } : context

    // Resolve the per-room skill whitelist once per executor invocation.
    // Null = unrestricted (no skill in this room declared allowed-tools).
    const skillWhitelist = roomId && getAllowedToolsForRoom ? getAllowedToolsForRoom(roomId) : null

    for (const call of calls) {
      if (!allowed.has(call.tool) && !allowedByActivation(call.tool, roomId)) {
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
  // Static tool definitions — the maximal set across all rooms. Used as a
  // fallback when no resolver is wired (tests, MCP-only mode, room not
  // found). Pack-aware spawns also set resolveToolDefinitions, which the
  // agent prefers per eval.
  readonly toolDefinitions?: ReadonlyArray<ToolDefinition>
  // Per-eval tool surface resolver. Filters definitions + executor allow-set
  // by the active packs in `roomId`. Returns null when the room is unknown
  // (caller falls back to the static toolDefinitions).
  //
  // This is the structural fix for tool-context bloat: the LLM only sees
  // tools from packs the operator has activated in the current room, plus
  // the implicit-active core + local packs.
  readonly resolveToolDefinitions?: (roomId: string) => ReadonlyArray<ToolDefinition> | null
}

const warnMissingTools = (agentName: string, requested: ReadonlyArray<string>, registry: ToolRegistry): void => {
  // Skip dispatcher names — they're expected to be absent from the
  // registry as atomic entries. The surface synthesises them at
  // projection time, the trampoline gets registered later in
  // buildToolSupport, and expandFamilyAliases in tool-surface/index.ts
  // turns stored dispatcher names into member names before they reach
  // the candidate set. Treating them as "missing" was misleading and
  // sent prod debugging down a rabbit hole (2026-05-12).
  const missing = requested.filter(n => !registry.has(n) && !FAMILY_DISPATCHER_NAMES.has(n))
  if (missing.length > 0)
    console.warn(`[spawn] Agent "${agentName}": tools not found in registry: ${missing.join(', ')}`)
}

// Resolves a room → pack-activation view. Used by the per-eval tool surface
// resolver to filter the static tool list down to tools whose owning pack is
// active in the current room. Returns undefined when the room is unknown
// (caller falls through to the static toolDefinitions).
export type GetRoomActivation = (roomId: string) =>
  | { readonly getActivePacks: () => ReadonlyArray<string> }
  | undefined

// Build tool support — always uses native tool calling.
// The pass tool is auto-injected so all agents can decline to respond.
// `seed`, when provided, is threaded into every tool-initiated LLM sub-call
// so reproducibility extends past the agent's main turn.
//
// `getRoomActivation`, when provided, enables the per-room tool-surface
// filter (the bloat fix): the resolver reads the room's active packs and
// the LLM only sees definitions owned by those packs. Without it, the
// behavior is unchanged from pre-pack days.
export const buildToolSupport = async (
  toolNames: ReadonlyArray<string>,
  registry: ToolRegistry,
  agentRef: { readonly id: string; readonly name: string; readonly currentModel?: () => string },
  llmProvider: LLMProvider,
  maxResultChars?: number,
  seed?: number,
  getAllowedToolsForRoom?: GetAllowedToolsForRoom,
  getRoomActivation?: GetRoomActivation,
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
  // Family dispatcher trampolines registered into the global registry
  // once. Each trampoline re-resolves its family's members at execute
  // time, so packs installed AFTER this spawn become routable without
  // re-registering. Idempotent across spawns via the has-name guard.
  const surface = createToolSurface({
    registry,
    requestedTools: allToolNames,
    getRoomActivation,
  })
  for (const dispatcher of surface.getRegistryDispatchers()) {
    if (!registry.has(dispatcher.name)) registry.register(dispatcher)
  }

  // The executor must accept family-dispatcher names too — they aren't in
  // allToolNames, but they're real tools in the registry. Inject them.
  const dispatcherNames = surface.getRegistryDispatchers().map(d => d.name)
  const executorAllowedNames = [...allToolNames, ...dispatcherNames.filter(n => !allToolNames.includes(n))]
  const executor = createToolExecutor(registry, executorAllowedNames, lazyContext, getAllowedToolsForRoom, getRoomActivation)

  // Initial projection — no room context yet, no provider known. project()
  // is cheap; the per-eval resolveToolDefinitions below overrides this
  // with the room + provider-aware projection.
  const support: { -readonly [K in keyof AgentToolSupport]: AgentToolSupport[K] } = {
    toolExecutor: executor,
    toolDefinitions: surface.project(undefined, undefined),
  }

  if (getRoomActivation) {
    // Per-eval resolver: the surface owns the per-room activation filter
    // and family compression, gated on provider strictness. Returns null
    // when the room is unknown so the caller falls back to the static
    // toolDefinitions (which the surface also computed with no room
    // filter — functionally equivalent, but the null contract is preserved
    // for legacy test compatibility + clarity).
    support.resolveToolDefinitions = (roomId: string): ReadonlyArray<ToolDefinition> | null => {
      if (!getRoomActivation(roomId)) return null
      const model = agentRef.currentModel?.() ?? ''
      const provider = inferProviderFromModelRef(model, CURATED_MODELS)
      return surface.project(roomId, provider)
    }
  }

  return support
}

// Default requestedTools when an agent is spawned without an explicit
// `tools:` list. The per-room pack-activation filter further narrows
// this to whichever packs are active in the trigger room, so the
// effective surface at eval time is:
//
//   defaultRequestedTools  ∩  active-packs(roomId)
//
// We default to tools owned by implicit-active packs (core/local/welcome/
// demos) only. Explicit pack activation is the only way to add more.
// This replaces the prior "give the agent everything in the registry"
// default, which combined with the now-deleted budget cap produced
// silent tool drops in production.
//
// Scenarios that want a specific breadth (e.g. the Cafe AI in the
// welcome scenario) declare `tools:` explicitly in the scenario yaml.
// Snapshot-restored agents whose persisted config has tools === undefined
// are backfilled at load time to preserve their pre-redesign behavior
// (see src/core/storage/snapshot.ts).
const IMPLICIT_ACTIVE_PACKS: ReadonlySet<string> = new Set(['core', 'local', 'welcome', 'demos'])

const deriveDefaultRequestedTools = (registry: ToolRegistry): ReadonlyArray<string> => {
  const out: string[] = []
  for (const entry of registry.listEntries()) {
    const pack =
      entry.source.kind === 'built-in' ? 'core' :
      entry.source.kind === 'external' ? 'local' :
      entry.source.pack ?? 'local'
    if (IMPLICIT_ACTIVE_PACKS.has(pack)) out.push(entry.tool.name)
  }
  return out
}

const resolveAgentTools = async (
  config: AIAgentConfig,
  llmProvider: LLMProvider,
  toolRegistry: ToolRegistry | undefined,
  agentRef: { id: string; name: string },
  getAllowedToolsForRoom?: GetAllowedToolsForRoom,
  getRoomActivation?: GetRoomActivation,
): Promise<AgentToolSupport> => {
  if (!toolRegistry) return {}
  const requestedTools = config.tools ?? deriveDefaultRequestedTools(toolRegistry)

  if (requestedTools.length > 0) {
    warnMissingTools(config.name, requestedTools, toolRegistry)
  }

  return buildToolSupport(
    requestedTools,
    toolRegistry,
    agentRef,
    llmProvider,
    config.maxToolResultChars,
    config.seed,
    getAllowedToolsForRoom,
    getRoomActivation,
  )
}

// --- Spawn AI Agent ---

export interface SpawnOptions {
  readonly overrideId?: string
  readonly getSkills?: (roomName: string) => string
  readonly getActiveSkillsDeclarations?: (roomId: string) => ReadonlyArray<{
    readonly name: string
    readonly declaredTools: ReadonlyArray<string>
  }>
  readonly getScriptContext?: (roomId: string, agentName: string) =>
    | { systemDoc: string; dialogue: ReadonlyArray<{ speaker: string; content: string }> }
    | undefined
  readonly onEvalEvent?: (agentName: string, event: import('../core/types/agent-eval.ts').EvalEvent) => void
  // Per-room allowed-tools resolver. When provided, the tool executor
  // intersects the agent's spawn-time toolset with this room's skill
  // whitelist on every call. See createToolExecutor for semantics.
  readonly getAllowedToolsForRoom?: GetAllowedToolsForRoom
  // Per-room pack-activation resolver. When provided, the LLM tool surface
  // is filtered per eval to tools owned by packs active in the trigger
  // room (plus implicit-active 'core' + 'local'). This is the structural
  // fix for tool-context bloat — without it, every agent sees every tool
  // the registry has registered.
  readonly getRoomActivation?: GetRoomActivation
  // Per-call effective-model resolver (Phase 4 / commit-pending). Forwarded
  // verbatim into createAIAgent's options so each eval picks an effective
  // model from the user's preferred + currently-available providers, without
  // ever mutating the agent's stored model.
  readonly resolveEffectiveModel?: (preferred: string) => {
    readonly model: string
    readonly fallback: boolean
    readonly reason: string
  }
}

export const spawnAIAgent = async (
  config: AIAgentConfig,
  llmService: LLMService,
  house: House,
  team: Team,
  routeMessage: RouteMessage,
  toolRegistry?: ToolRegistry,
  spawnOptions?: SpawnOptions,
): Promise<AIAgent> => {
  // Bind once per agent: source='agent', agentId baked in, chain-switch
  // events surface via onEvalEvent as the existing model_fallback kind.
  // agentId is fixed up-front so the bound provider can carry it before
  // createAIAgent is called (resolveAgentTools needs the provider too).
  const agentId = spawnOptions?.overrideId ?? crypto.randomUUID()
  // Per-agent one-shot dedup: emit model_fallback only when the effective
  // target CHANGES (or after recovery — preferred served successfully). A
  // primary stuck in backoff would otherwise emit a notice on every eval.
  // The per-(agentId, provider) WS dedup window is 5s; this layer is
  // additionally per-target so a long outage produces ONE notice, not one
  // per call.
  let lastFallbackTarget: string | null = null
  const onChainSwitch = spawnOptions?.onEvalEvent
    ? (preferred: string, effective: string, reason: string) => {
        if (lastFallbackTarget === effective) return
        lastFallbackTarget = effective
        spawnOptions.onEvalEvent!(config.name, { kind: 'model_fallback', preferred, effective, reason })
      }
    : undefined
  const llmProvider: LLMProvider = llmService.bound({
    source: 'agent',
    agentId,
    ...(onChainSwitch ? { onChainSwitch } : {}),
  })
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
      ...(m.cacheCreation !== undefined ? { cacheCreation: m.cacheCreation } : {}),
      ...(m.cacheRead !== undefined ? { cacheRead: m.cacheRead } : {}),
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
  const toolSupport = await resolveAgentTools(
    config,
    llmProvider,
    toolRegistry,
    agentRef,
    spawnOptions?.getAllowedToolsForRoom,
    spawnOptions?.getRoomActivation,
  )

  const agent = createAIAgent(config, llmProvider, onDecision, {
    ...toolSupport,
    getHousePrompt: () => house.getHousePrompt(),
    getResponseFormat: () => house.getResponseFormat(),
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
    ...(spawnOptions?.getActiveSkillsDeclarations ? { getActiveSkillsDeclarations: spawnOptions.getActiveSkillsDeclarations } : {}),
    getScriptContext: spawnOptions?.getScriptContext,
    onEvalEvent: spawnOptions?.onEvalEvent,
    ...(spawnOptions?.resolveEffectiveModel ? { resolveEffectiveModel: spawnOptions.resolveEffectiveModel } : {}),
  }, agentId)

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
