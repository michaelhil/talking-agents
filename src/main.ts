// ============================================================================
// samsinn — System Factory + Entry Point
//
// createSystem() builds the full system. Can be imported without side effects.
// When run directly (bun run src/main.ts), starts up and prints diagnostics.
// ============================================================================

import type { Agent, AIAgent, AIAgentConfig, RouteMessage, Team } from './core/types/agent.ts'
import type { DeliverFn, ResolveAgentName, ResolveTagFn } from './core/types/messaging.ts'
import type {
  House, HouseCallbacks, OnBookmarksChanged, OnDeliveryModeChanged, OnMacroEvent,
  OnMacroSelectionChanged, OnMembershipChanged, OnMessagePosted, OnModeAutoSwitched,
  OnRoomCreated, OnRoomDeleted, OnSummaryConfigChanged, OnSummaryUpdated,
  OnTurnChanged,
} from './core/types/room.ts'
import type { SummaryScheduler, SummaryTarget } from './core/summary-scheduler.ts'
import { createSummaryEngine } from './core/summary-engine.ts'
import { createSummaryScheduler } from './core/summary-scheduler.ts'
import type { OnArtifactChanged } from './core/types/artifact.ts'
import type { OnEvalEvent } from './core/types/agent-eval.ts'
import type { ToolRegistry } from './core/types/tool.ts'
import type { OnProviderBound, OnProviderAllFailed, OnProviderStreamFailed } from './core/types/llm.ts'
import type { ProviderRoutingEvent } from './llm/router.ts'
import { createHouse } from './core/house.ts'
import { asAIAgent } from './agents/shared.ts'
import { createTeam } from './agents/team.ts'
import { createMessageRouter } from './core/delivery.ts'
import type { LLMGateway } from './llm/gateway.ts'
import type { ProviderRouter } from './llm/router.ts'
import { buildProvidersFromConfig, type ProviderSetupResult } from './llm/providers-setup.ts'
import { parseProviderConfig, type ProviderConfig } from './llm/providers-config.ts'
import { createProviderKeys, type ProviderKeys } from './llm/provider-keys.ts'
import { mergeWithEnv } from './llm/providers-store.ts'
import type { ProviderGateway } from './llm/provider-gateway.ts'
import { createToolRegistry } from './core/tool-registry.ts'
import { spawnAIAgent, spawnHumanAgent, buildToolSupport, type SpawnOptions } from './agents/spawn.ts'
import { callLLM } from './agents/evaluation.ts'
import { createHumanAgent } from './agents/human-agent.ts'
import type { HumanAgentConfig, TransportSend } from './agents/human-agent.ts'
import type { HumanAgent } from './agents/human-agent.ts'
import { addAgentToRoom, removeAgentFromRoom } from './agents/actions.ts'
import {
  createListRoomsTool, createGetTimeTool,
  createCreateRoomTool, createDeleteRoomTool, createAddToRoomTool, createRemoveFromRoomTool,
  createPassTool, createListAgentsTool, createGetMyContextTool, createSetDeliveryModeTool,
  createPauseRoomTool, createMuteAgentTool, createSetRoomPromptTool,
  createPostToRoomTool, createGetRoomHistoryTool,
  createListArtifactTypesTool, createListArtifactsTool, createAddArtifactTool,
  createUpdateArtifactTool, createRemoveArtifactTool, createCastVoteTool,
  createWebTools, createWriteDocumentSectionTool,
  createWriteSkillTool, createWriteToolTool, createTestToolTool, createListSkillsTool,
} from './tools/built-in/index.ts'
import { createTaskListArtifactType } from './core/artifact-types/task-list.ts'
import { pollArtifactType } from './core/artifact-types/poll.ts'
import { createMacroArtifactType } from './core/artifact-types/macro.ts'
import { documentArtifactType } from './core/artifact-types/document.ts'
import { mermaidArtifactType } from './core/artifact-types/mermaid.ts'
// Native-only tool calling — no capability probing needed
import { createSkillStore, type SkillStore } from './skills/loader.ts'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createOllamaUrlRegistry, type OllamaUrlRegistry } from './core/ollama-urls.ts'
export type { OllamaUrlRegistry }

export interface System {
  readonly house: House
  readonly team: Team
  readonly routeMessage: RouteMessage
  // Provider-neutral LLM access. All agents and callSystemLLM go through here.
  readonly llm: ProviderRouter
  // Direct Ollama gateway (present iff Ollama is a configured provider).
  // Used by the Ollama dashboard UI for ps/loadModel; not for routing.
  readonly ollama: LLMGateway | undefined
  readonly providerConfig: ProviderConfig
  // Mutable registry of current API keys, read by gateways at request time.
  // Used by the providers admin endpoints to apply key changes without restart.
  readonly providerKeys: ProviderKeys
  // Per-provider gateways — exposed so admin endpoints can refresh model
  // caches when keys change.
  readonly gateways: Record<string, ProviderGateway>
  readonly toolRegistry: ToolRegistry
  // Refresh every AI agent's ToolExecutor / ToolDefinitions to reflect the
  // current registry. Called by the tool-rescan endpoint and by write_tool.
  readonly refreshAllAgentTools: () => Promise<void>
  readonly skillStore: SkillStore
  readonly skillsDir: string
  readonly knowledgeDir: string
  readonly providersStorePath: string
  // OllamaUrls editor — no-op when Ollama isn't configured.
  readonly ollamaUrls: OllamaUrlRegistry
  readonly removeAgent: (id: string) => boolean
  readonly removeRoom: (roomId: string) => boolean
  readonly addAgentToRoom: (agentId: string, roomId: string, invitedBy?: string) => Promise<void>
  readonly removeAgentFromRoom: (agentId: string, roomId: string, removedBy?: string) => void
  readonly spawnAIAgent: (config: AIAgentConfig, options?: SpawnOptions) => Promise<Agent>
  readonly spawnHumanAgent: (config: HumanAgentConfig, send: TransportSend) => Promise<HumanAgent>
  // Manual-mode activation: catch the agent up and force one eval.
  readonly activateAgentInRoom: (agentId: string, roomId: string) => { ok: boolean; queued: boolean; reason?: string }
  readonly setOnMessagePosted: (callback: OnMessagePosted) => void
  readonly setOnTurnChanged: (callback: OnTurnChanged) => void
  readonly setOnDeliveryModeChanged: (callback: OnDeliveryModeChanged) => void
  readonly setOnMacroEvent: (callback: OnMacroEvent) => void
  readonly setOnModeAutoSwitched: (callback: OnModeAutoSwitched) => void
  readonly setOnMacroSelectionChanged: (callback: OnMacroSelectionChanged) => void
  readonly setOnArtifactChanged: (callback: OnArtifactChanged) => void
  readonly setOnRoomCreated: (callback: OnRoomCreated) => void
  readonly setOnRoomDeleted: (callback: OnRoomDeleted) => void
  readonly setOnMembershipChanged: (callback: OnMembershipChanged) => void
  readonly setOnBookmarksChanged: (callback: OnBookmarksChanged) => void
  readonly setOnEvalEvent: (callback: OnEvalEvent) => void
  readonly setOnProviderBound: (callback: OnProviderBound) => void
  readonly setOnProviderAllFailed: (callback: OnProviderAllFailed) => void
  readonly setOnProviderStreamFailed: (callback: OnProviderStreamFailed) => void
  // Dispatch entry point for the provider router (wired in Phase 4 via
  // router.onRoutingEvent(system.dispatchProviderEvent)).
  readonly dispatchProviderEvent: (event: ProviderRoutingEvent) => void
  // Summary + compression scheduler (per-room). Exposed so REST/WS can call
  // triggerNow() for manual regenerate.
  readonly summaryScheduler: SummaryScheduler
  readonly setOnSummaryRunStarted: (cb: (roomId: string, target: SummaryTarget) => void) => void
  readonly setOnSummaryRunDelta: (cb: (roomId: string, target: SummaryTarget, delta: string) => void) => void
  readonly setOnSummaryRunCompleted: (cb: (roomId: string, target: SummaryTarget, text: string) => void) => void
  readonly setOnSummaryRunFailed: (cb: (roomId: string, target: SummaryTarget, reason: string) => void) => void
  readonly setOnSummaryConfigChanged: (cb: OnSummaryConfigChanged) => void
}

export interface CreateSystemOptions {
  readonly providerConfig?: ProviderConfig
  readonly providerSetup?: ProviderSetupResult
}

export const createSystem = (options: CreateSystemOptions = {}): System => {
  const providerConfig = options.providerConfig ?? parseProviderConfig()
  // Build keys registry from the merged boot config so runtime key edits can
  // flow into the gateways without restart. Tests pass a pre-built
  // providerSetup and skip this by never mutating the keys object.
  const providerKeys = createProviderKeys(mergeWithEnv({ version: 1, providers: {} }, { env: {} as Record<string, string | undefined> }))
  // Seed from providerConfig.cloud so boot-time env/stored keys land in the
  // mutable registry. This loop handles both env and stored sources.
  for (const [name, cc] of Object.entries(providerConfig.cloud)) {
    if (cc?.apiKey) providerKeys.set(name, cc.apiKey)
  }
  const providerSetup = options.providerSetup ?? buildProvidersFromConfig(providerConfig, { providerKeys })
  const { router: llm, ollama, ollamaRaw, gateways } = providerSetup
  const team = createTeam()

  const deliver: DeliverFn = (agentId, message) => {
    team.getAgent(agentId)?.receive(message)
  }

  const lateBinding = <T extends (...args: never[]) => void>(): { proxy: T; set: (cb: T) => void } => {
    let real: T | undefined
    const proxy = ((...args: Parameters<T>) => real?.(...args)) as T
    return { proxy, set: (cb: T) => { real = cb } }
  }

  const messagePosted = lateBinding<OnMessagePosted>()
  const turnChanged = lateBinding<OnTurnChanged>()
  const deliveryModeChanged = lateBinding<OnDeliveryModeChanged>()
  const macroEvent = lateBinding<OnMacroEvent>()
  const artifactChanged = lateBinding<OnArtifactChanged>()
  const roomCreated = lateBinding<OnRoomCreated>()
  const roomDeleted = lateBinding<OnRoomDeleted>()
  const membershipChanged = lateBinding<OnMembershipChanged>()
  const bookmarksChanged = lateBinding<OnBookmarksChanged>()
  const modeAutoSwitched = lateBinding<OnModeAutoSwitched>()
  const macroSelectionChanged = lateBinding<OnMacroSelectionChanged>()
  const evalEvent = lateBinding<OnEvalEvent>()
  const providerBound = lateBinding<OnProviderBound>()
  const providerAllFailed = lateBinding<OnProviderAllFailed>()
  const providerStreamFailed = lateBinding<OnProviderStreamFailed>()
  const summaryConfigChanged = lateBinding<OnSummaryConfigChanged>()
  const summaryUpdated = lateBinding<OnSummaryUpdated>()
  const summaryRunStarted = lateBinding<(roomId: string, target: SummaryTarget) => void>()
  const summaryRunDelta = lateBinding<(roomId: string, target: SummaryTarget, delta: string) => void>()
  const summaryRunCompleted = lateBinding<(roomId: string, target: SummaryTarget, text: string) => void>()
  const summaryRunFailed = lateBinding<(roomId: string, target: SummaryTarget, reason: string) => void>()

  const resolveAgentName: ResolveAgentName = (name) => team.getAgent(name)?.id
  const resolveTag: ResolveTagFn = (tag) => team.listByTag(tag).map(a => a.id)
  const resolveKind = (id: string): 'ai' | 'human' | undefined => team.getAgent(id)?.kind

  const ollamaUrls: OllamaUrlRegistry = createOllamaUrlRegistry(ollamaRaw, ollama)

  // Forward-declared: the summary scheduler is built after `house`, but the
  // house's onMessagePosted callback needs to feed into it. We bridge with a
  // mutable slot that's set after construction.
  let schedulerRef: SummaryScheduler | undefined

  const houseCallbacks: HouseCallbacks = {
    deliver,
    resolveAgentName,
    resolveTag,
    resolveKind,
    onMessagePosted: (roomId, message) => {
      messagePosted.proxy(roomId, message)
      schedulerRef?.onMessagePosted(roomId, message)
    },
    onTurnChanged: turnChanged.proxy,
    onDeliveryModeChanged: deliveryModeChanged.proxy,
    onMacroEvent: macroEvent.proxy,
    onArtifactChanged: artifactChanged.proxy,
    onRoomCreated: roomCreated.proxy,
    onRoomDeleted: (roomId, roomName) => {
      roomDeleted.proxy(roomId, roomName)
      schedulerRef?.onRoomRemoved(roomId)
    },
    onBookmarksChanged: bookmarksChanged.proxy,
    onManualModeEntered: (roomId: string) => { cancelGenerationsInRoom(roomId) },
    onModeAutoSwitched: modeAutoSwitched.proxy,
    onMacroSelectionChanged: macroSelectionChanged.proxy,
    onSummaryConfigChanged: (roomId, config) => {
      summaryConfigChanged.proxy(roomId, config)
      schedulerRef?.onConfigChanged(roomId)
    },
    onSummaryUpdated: summaryUpdated.proxy,
    callSystemLLM: (options) => callLLM(llm, options),
  }
  const house = createHouse(houseCallbacks)
  const routeMessage = createMessageRouter({ house })
  const toolRegistry = createToolRegistry()

  // Summary engine + scheduler — default model is the first AI agent's model,
  // or a fallback when none exists yet.
  const defaultSummaryModel = (): string => {
    const firstAi = team.listByKind('ai')[0]
    const model = firstAi ? (firstAi as AIAgent).getModel?.() : undefined
    return model ?? 'llama3.2'
  }
  const summaryEngine = createSummaryEngine({ llm, defaultModel: defaultSummaryModel })
  const summaryScheduler = createSummaryScheduler({
    engine: summaryEngine,
    getRoom: (id) => house.getRoom(id),
    onRunStarted: (roomId, target) => summaryRunStarted.proxy(roomId, target),
    onRunDelta: (roomId, target, delta) => summaryRunDelta.proxy(roomId, target, delta),
    onRunCompleted: (roomId, target, text) => summaryRunCompleted.proxy(roomId, target, text),
    onRunFailed: (roomId, target, reason) => summaryRunFailed.proxy(roomId, target, reason),
  })
  schedulerRef = summaryScheduler

  // Register built-in artifact types — task_list needs store reference for checkAutoResolve
  house.artifactTypes.register(createTaskListArtifactType(house.artifacts))
  house.artifactTypes.register(pollArtifactType)
  house.artifactTypes.register(createMacroArtifactType(team))
  house.artifactTypes.register(documentArtifactType)
  house.artifactTypes.register(mermaidArtifactType)


  // System-level membership operations
  const systemAddAgentToRoom = async (agentId: string, roomId: string, invitedBy?: string): Promise<void> => {
    const agent = team.getAgent(agentId)
    const room = house.getRoom(roomId)
    if (!agent || !room) return
    await addAgentToRoom(agentId, agent.name, roomId, invitedBy, team, routeMessage, house)
    membershipChanged.proxy(roomId, room.profile.name, agentId, agent.name, 'added')
  }

  const systemRemoveAgentFromRoom = (agentId: string, roomId: string, removedBy?: string): void => {
    const agent = team.getAgent(agentId)
    const room = house.getRoom(roomId)
    if (!agent || !room) return
    removeAgentFromRoom(agentId, agent.name, roomId, removedBy, team, routeMessage, house)
    membershipChanged.proxy(roomId, room.profile.name, agentId, agent.name, 'removed')
    // Auto-delete room if last member left
    if (room.getParticipantIds().length === 0) {
      systemRemoveRoom(roomId)
    }
  }

  const systemRemoveRoom = (roomId: string): boolean => {
    const room = house.getRoom(roomId)
    if (!room) return false
    for (const agentId of room.getParticipantIds()) {
      team.getAgent(agentId)?.leave(roomId)
    }
    const removed = house.removeRoom(roomId)
    if (removed) {
      // Clean up artifacts exclusively scoped to the deleted room
      for (const artifact of house.artifacts.list({ scope: roomId })) {
        if (artifact.scope.length === 1 && artifact.scope[0] === roomId) {
          house.artifacts.remove(artifact.id)
        }
      }
    }
    return removed
  }

  // Cancel in-flight AI generation only for agents whose current generation
  // context is this room. Called by the room's onManualModeEntered hook.
  function cancelGenerationsInRoom(roomId: string): void {
    const room = house.getRoom(roomId)
    if (!room) return
    for (const id of room.getParticipantIds()) {
      const agent = team.getAgent(id)
      if (!agent || agent.kind !== 'ai') continue
      if (agent.state.getContext() !== roomId) continue
      const ai = asAIAgent(agent)
      ai?.cancelGeneration()
    }
  }

  // Explicit one-turn activation for manual mode. Catches the agent up on
  // messages it hasn't seen, then forces a single evaluation. If the agent
  // is busy generating elsewhere, `tryEvaluate` queues internally — callers
  // surface the `queued: true` result as a UI toast.
  const activateAgentInRoom = (
    agentId: string,
    roomId: string,
  ): { ok: boolean; queued: boolean; reason?: string } => {
    const room = house.getRoom(roomId)
    if (!room) return { ok: false, queued: false, reason: 'room not found' }
    if (room.deliveryMode !== 'manual') {
      return { ok: false, queued: false, reason: 'room is not in manual mode' }
    }
    const agent = team.getAgent(agentId)
    if (!agent || agent.kind !== 'ai') {
      return { ok: false, queued: false, reason: 'agent is not an AI agent in this room' }
    }
    if (!room.hasMember(agentId)) {
      return { ok: false, queued: false, reason: 'agent is not a member of this room' }
    }
    if (room.isMuted(agentId)) {
      return { ok: false, queued: false, reason: 'agent is muted' }
    }
    const ai = asAIAgent(agent)
    if (!ai || !ai.ingestHistory || !ai.forceEvaluate) {
      return { ok: false, queued: false, reason: 'agent does not support manual activation' }
    }
    const recent = room.getRecent((ai.getHistoryLimit() ?? 20) * 2)
    ai.ingestHistory(roomId, recent)
    const queued = agent.state.get() === 'generating' && agent.state.getContext() !== roomId
    ai.forceEvaluate(roomId)
    return { ok: true, queued }
  }

  const removeAgent = (id: string): boolean => {
    const agent = team.getAgent(id)
    if (!agent) return false
    for (const profile of house.listAllRooms()) {
      const room = house.getRoom(profile.id)
      if (room?.hasMember(id)) {
        systemRemoveAgentFromRoom(id, profile.id)
      }
    }
    const removed = team.removeAgent(id)
    // Prune this ID from every surviving AI agent's "known agents" cache so
    // it doesn't linger as a phantom entry after deletion.
    if (removed) {
      for (const other of team.listByKind('ai')) {
        const ai = asAIAgent(other)
        ai?.forgetAgent?.(id)
      }
    }
    return removed
  }

  // Register built-in tools
  toolRegistry.registerAll([
    // Room management
    createListRoomsTool(house),
    createCreateRoomTool(house, systemAddAgentToRoom),
    createDeleteRoomTool(systemRemoveRoom, house),
    createSetRoomPromptTool(house),
    createPauseRoomTool(house),
    createSetDeliveryModeTool(house),
    createAddToRoomTool(team, house, systemAddAgentToRoom),
    createRemoveFromRoomTool(team, house, systemRemoveAgentFromRoom),
    // Agent tools
    createPassTool(),
    createListAgentsTool(team),
    createMuteAgentTool(team, house),
    createGetMyContextTool(team, house),
    // Artifact tools
    createListArtifactTypesTool(house),
    createListArtifactsTool(house),
    createAddArtifactTool(house),
    createUpdateArtifactTool(house),
    createRemoveArtifactTool(house),
    createCastVoteTool(house),
    // Utility tools
    createGetTimeTool(),
    createGetRoomHistoryTool(house),
    createPostToRoomTool(house),
  ])

  // Web tools — web_fetch and web_extract_json always registered;
  // web_search registered when TAVILY_API_KEY (preferred), BRAVE_API_KEY, or
  // GOOGLE_CSE_API_KEY+GOOGLE_CSE_ID is set. Tavily is the default — it's
  // LLM-optimized (returns clean snippets + relevance scores) and has a
  // generous free tier (1000 searches/month, no card required).
  toolRegistry.registerAll(createWebTools({
    tavilyApiKey: process.env.TAVILY_API_KEY,
    braveApiKey: process.env.BRAVE_API_KEY,
    googleApiKey: process.env.GOOGLE_CSE_API_KEY,
    googleCseId: process.env.GOOGLE_CSE_ID,
  }))

  // Document tool — collaborative structured writing with streaming LLM output
  toolRegistry.register(createWriteDocumentSectionTool(house.artifacts))

  // Skill system — file-based behavioral templates with bundled tools
  const skillsDir = join(homedir(), '.samsinn', 'skills')
  const skillStore = createSkillStore()

  const getSkillsForRoom = (roomName: string): string => {
    const skills = skillStore.forScope(roomName)
    if (skills.length === 0) return ''
    return skills.map(s => `[${s.name}] ${s.description}\n${s.body}`).join('\n\n---\n\n')
  }

  const refreshAllAgentTools = async (): Promise<void> => {
    for (const agent of team.listByKind('ai')) {
      const ai = agent as AIAgent
      if (!ai.refreshTools) continue
      const toolNames = ai.getTools() ?? toolRegistry.list().map(t => t.name)
      const support = await buildToolSupport(
        toolNames, toolRegistry,
        { id: ai.id, name: ai.name, currentModel: () => ai.getModel() },
        llm,
      )
      ai.refreshTools(support)
    }
  }

  toolRegistry.register(createWriteSkillTool(skillStore, skillsDir))
  toolRegistry.register(createWriteToolTool(toolRegistry, skillStore, refreshAllAgentTools))
  toolRegistry.register(createTestToolTool(toolRegistry))
  toolRegistry.register(createListSkillsTool(skillStore))

  const boundSpawnAIAgent = (config: AIAgentConfig, options?: SpawnOptions) =>
    spawnAIAgent(config, llm, house, team, routeMessage, toolRegistry, {
      ...options,
      getSkills: getSkillsForRoom,
      onEvalEvent: evalEvent.proxy,
    })

  // Wire router routing events → late-bound dispatch (ws-handler broadcasts
  // the corresponding provider_* WS messages to UI clients).
  llm.onRoutingEvent((event) => {
    if (event.type === 'provider_bound') {
      providerBound.proxy(event.agentId, event.model, event.oldProvider, event.newProvider)
    } else if (event.type === 'provider_all_failed') {
      providerAllFailed.proxy(event.agentId, event.model, event.attempts)
    } else {
      providerStreamFailed.proxy(event.agentId, event.model, event.provider, event.reason)
    }
  })

  const boundSpawnHumanAgent = async (config: HumanAgentConfig, send: TransportSend): Promise<HumanAgent> => {
    const agent = createHumanAgent(config, send)
    await spawnHumanAgent(agent, house, team, routeMessage)
    return agent
  }

  return {
    house, team, routeMessage,
    llm, ollama, providerConfig, providerKeys, gateways,
    toolRegistry, refreshAllAgentTools, skillStore, skillsDir,
    knowledgeDir: join(homedir(), '.samsinn', 'knowledge'),
    providersStorePath: join(homedir(), '.samsinn', 'providers.json'),
    ollamaUrls,
    removeAgent,
    removeRoom: systemRemoveRoom,
    addAgentToRoom: systemAddAgentToRoom,
    removeAgentFromRoom: systemRemoveAgentFromRoom,
    spawnAIAgent: boundSpawnAIAgent,
    spawnHumanAgent: boundSpawnHumanAgent,
    activateAgentInRoom,
    setOnMessagePosted: messagePosted.set,
    setOnTurnChanged: turnChanged.set,
    setOnDeliveryModeChanged: deliveryModeChanged.set,
    setOnMacroEvent: macroEvent.set,
    setOnModeAutoSwitched: modeAutoSwitched.set,
    setOnMacroSelectionChanged: macroSelectionChanged.set,
    setOnArtifactChanged: artifactChanged.set,
    setOnRoomCreated: roomCreated.set,
    setOnRoomDeleted: roomDeleted.set,
    setOnMembershipChanged: membershipChanged.set,
    setOnBookmarksChanged: bookmarksChanged.set,
    setOnEvalEvent: evalEvent.set,
    setOnProviderBound: providerBound.set,
    setOnProviderAllFailed: providerAllFailed.set,
    setOnProviderStreamFailed: providerStreamFailed.set,
    dispatchProviderEvent: (event) => {
      if (event.type === 'provider_bound') {
        providerBound.proxy(event.agentId, event.model, event.oldProvider, event.newProvider)
      } else if (event.type === 'provider_all_failed') {
        providerAllFailed.proxy(event.agentId, event.model, event.attempts)
      } else {
        providerStreamFailed.proxy(event.agentId, event.model, event.provider, event.reason)
      }
    },
    summaryScheduler,
    setOnSummaryRunStarted: summaryRunStarted.set,
    setOnSummaryRunDelta: summaryRunDelta.set,
    setOnSummaryRunCompleted: summaryRunCompleted.set,
    setOnSummaryRunFailed: summaryRunFailed.set,
    setOnSummaryConfigChanged: summaryConfigChanged.set,
  }
}

// --- Startup (only when run directly) ---

if (import.meta.main) {
  const { bootstrap } = await import('./bootstrap.ts')
  await bootstrap()
}
