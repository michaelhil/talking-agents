// ============================================================================
// samsinn — System Factory + Entry Point
//
// createSystem() builds the full system. Can be imported without side effects.
// When run directly (bun run src/main.ts), starts up and prints diagnostics.
// ============================================================================

import type { Agent, AIAgent, AIAgentConfig, RouteMessage, Team } from './core/types/agent.ts'
import type { DeliverFn, ResolveAgentName, ResolveTagFn } from './core/types/messaging.ts'
import type {
  House, HouseCallbacks, OnDeliveryModeChanged, OnFlowEvent,
  OnMembershipChanged, OnMessagePosted, OnRoomCreated, OnRoomDeleted, OnTurnChanged,
} from './core/types/room.ts'
import type { OnArtifactChanged } from './core/types/artifact.ts'
import type { OnEvalEvent } from './core/types/agent-eval.ts'
import type { ToolRegistry } from './core/types/tool.ts'
import type { OnProviderBound, OnProviderAllFailed, OnProviderStreamFailed } from './core/types/llm.ts'
import type { ProviderRoutingEvent } from './llm/router.ts'
import { createHouse } from './core/house.ts'
import { createTeam } from './agents/team.ts'
import { createMessageRouter } from './core/delivery.ts'
import type { LLMGateway } from './llm/gateway.ts'
import type { ProviderRouter } from './llm/router.ts'
import { buildProvidersFromConfig, type ProviderSetupResult } from './llm/providers-setup.ts'
import { parseProviderConfig, type ProviderConfig } from './llm/providers-config.ts'
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
import { createFlowArtifactType } from './core/artifact-types/flow.ts'
import { documentArtifactType } from './core/artifact-types/document.ts'
import { mermaidArtifactType } from './core/artifact-types/mermaid.ts'
// Native-only tool calling — no capability probing needed
import { createSkillStore, type SkillStore } from './skills/loader.ts'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface OllamaUrlRegistry {
  readonly list: () => string[]
  readonly add: (url: string) => void
  readonly remove: (url: string) => void
  readonly getCurrent: () => string
  readonly setCurrent: (url: string) => void
}

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
  readonly toolRegistry: ToolRegistry
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
  readonly setOnMessagePosted: (callback: OnMessagePosted) => void
  readonly setOnTurnChanged: (callback: OnTurnChanged) => void
  readonly setOnDeliveryModeChanged: (callback: OnDeliveryModeChanged) => void
  readonly setOnFlowEvent: (callback: OnFlowEvent) => void
  readonly setOnArtifactChanged: (callback: OnArtifactChanged) => void
  readonly setOnRoomCreated: (callback: OnRoomCreated) => void
  readonly setOnRoomDeleted: (callback: OnRoomDeleted) => void
  readonly setOnMembershipChanged: (callback: OnMembershipChanged) => void
  readonly setOnEvalEvent: (callback: OnEvalEvent) => void
  readonly setOnProviderBound: (callback: OnProviderBound) => void
  readonly setOnProviderAllFailed: (callback: OnProviderAllFailed) => void
  readonly setOnProviderStreamFailed: (callback: OnProviderStreamFailed) => void
  // Dispatch entry point for the provider router (wired in Phase 4 via
  // router.onRoutingEvent(system.dispatchProviderEvent)).
  readonly dispatchProviderEvent: (event: ProviderRoutingEvent) => void
}

export interface CreateSystemOptions {
  readonly providerConfig?: ProviderConfig
  readonly providerSetup?: ProviderSetupResult
}

export const createSystem = (options: CreateSystemOptions = {}): System => {
  const providerConfig = options.providerConfig ?? parseProviderConfig()
  const providerSetup = options.providerSetup ?? buildProvidersFromConfig(providerConfig)
  const { router: llm, ollama, ollamaRaw } = providerSetup
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
  const flowEvent = lateBinding<OnFlowEvent>()
  const artifactChanged = lateBinding<OnArtifactChanged>()
  const roomCreated = lateBinding<OnRoomCreated>()
  const roomDeleted = lateBinding<OnRoomDeleted>()
  const membershipChanged = lateBinding<OnMembershipChanged>()
  const evalEvent = lateBinding<OnEvalEvent>()
  const providerBound = lateBinding<OnProviderBound>()
  const providerAllFailed = lateBinding<OnProviderAllFailed>()
  const providerStreamFailed = lateBinding<OnProviderStreamFailed>()

  const resolveAgentName: ResolveAgentName = (name) => team.getAgent(name)?.id
  const resolveTag: ResolveTagFn = (tag) => team.listByTag(tag).map(a => a.id)

  // Saved Ollama URLs — only meaningful when Ollama is in the router.
  // When absent, setters are no-ops and getCurrent returns empty.
  const savedOllamaUrls = new Set<string>(ollamaRaw ? [ollamaRaw.baseUrl] : [])
  const ollamaUrls: OllamaUrlRegistry = ollamaRaw && ollama
    ? {
        list: () => [...savedOllamaUrls],
        add: (url: string) => { savedOllamaUrls.add(url) },
        remove: (url: string) => { savedOllamaUrls.delete(url) },
        getCurrent: () => ollamaRaw.baseUrl,
        setCurrent: (url: string) => {
          ollamaRaw.setBaseUrl(url)
          savedOllamaUrls.add(url)
          ollama.resetCircuitBreaker()
          ollama.refreshHealth()
        },
      }
    : {
        list: () => [],
        add: () => {},
        remove: () => {},
        getCurrent: () => '',
        setCurrent: () => {},
      }

  const houseCallbacks: HouseCallbacks = {
    deliver,
    resolveAgentName,
    resolveTag,
    onMessagePosted: messagePosted.proxy,
    onTurnChanged: turnChanged.proxy,
    onDeliveryModeChanged: deliveryModeChanged.proxy,
    onFlowEvent: flowEvent.proxy,
    onArtifactChanged: artifactChanged.proxy,
    onRoomCreated: roomCreated.proxy,
    onRoomDeleted: roomDeleted.proxy,
    callSystemLLM: (options) => callLLM(llm, options),
  }
  const house = createHouse(houseCallbacks)
  const routeMessage = createMessageRouter({ house })
  const toolRegistry = createToolRegistry()

  // Register built-in artifact types — task_list needs store reference for checkAutoResolve
  house.artifactTypes.register(createTaskListArtifactType(house.artifacts))
  house.artifactTypes.register(pollArtifactType)
  house.artifactTypes.register(createFlowArtifactType(team))
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

  const removeAgent = (id: string): boolean => {
    const agent = team.getAgent(id)
    if (!agent) return false
    for (const profile of house.listAllRooms()) {
      const room = house.getRoom(profile.id)
      if (room?.hasMember(id)) {
        systemRemoveAgentFromRoom(id, profile.id)
      }
    }
    return team.removeAgent(id)
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
  // web_search registered only when BRAVE_API_KEY or GOOGLE_CSE_API_KEY+GOOGLE_CSE_ID is set.
  toolRegistry.registerAll(createWebTools({
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
    llm, ollama, providerConfig,
    toolRegistry, skillStore, skillsDir,
    knowledgeDir: join(homedir(), '.samsinn', 'knowledge'),
    providersStorePath: join(homedir(), '.samsinn', 'providers.json'),
    ollamaUrls,
    removeAgent,
    removeRoom: systemRemoveRoom,
    addAgentToRoom: systemAddAgentToRoom,
    removeAgentFromRoom: systemRemoveAgentFromRoom,
    spawnAIAgent: boundSpawnAIAgent,
    spawnHumanAgent: boundSpawnHumanAgent,
    setOnMessagePosted: messagePosted.set,
    setOnTurnChanged: turnChanged.set,
    setOnDeliveryModeChanged: deliveryModeChanged.set,
    setOnFlowEvent: flowEvent.set,
    setOnArtifactChanged: artifactChanged.set,
    setOnRoomCreated: roomCreated.set,
    setOnRoomDeleted: roomDeleted.set,
    setOnMembershipChanged: membershipChanged.set,
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
  }
}

// --- Startup (only when run directly) ---

if (import.meta.main) {
  const { bootstrap } = await import('./bootstrap.ts')
  await bootstrap()
}
