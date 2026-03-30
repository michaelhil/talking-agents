// ============================================================================
// samsinn — System Factory + Entry Point
//
// createSystem() builds the full system. Can be imported without side effects.
// When run directly (bun run src/main.ts), starts up and prints diagnostics.
// ============================================================================

import type {
  Agent, AIAgentConfig, DeliverFn, House, HouseCallbacks, LLMProvider,
  OnArtifactChanged, OnDeliveryModeChanged, OnFlowEvent,
  OnMembershipChanged, OnMessagePosted, OnRoomCreated, OnRoomDeleted,
  OnTurnChanged, ResolveAgentName, ResolveTagFn, RouteMessage, Team, ToolRegistry,
} from './core/types.ts'
import { DEFAULTS } from './core/types.ts'
import { createHouse } from './core/house.ts'
import { createTeam } from './agents/team.ts'
import { createMessageRouter } from './core/delivery.ts'
import { createOllamaProvider } from './llm/ollama.ts'
import { createToolRegistry } from './core/tool-registry.ts'
import { spawnAIAgent, spawnHumanAgent, type SpawnOptions } from './agents/spawn.ts'
import { callLLM } from './agents/evaluation.ts'
import { createHumanAgent } from './agents/human-agent.ts'
import type { HumanAgentConfig, TransportSend } from './agents/human-agent.ts'
import type { HumanAgent } from './agents/human-agent.ts'
import { addAgentToRoom, removeAgentFromRoom } from './agents/actions.ts'
import {
  createListRoomsTool, createGetTimeTool,
  createCreateRoomTool, createDeleteRoomTool, createAddToRoomTool, createRemoveFromRoomTool,
  createListAgentsTool, createGetMyContextTool, createSetDeliveryModeTool,
  createPauseRoomTool, createMuteAgentTool, createSetRoomPromptTool,
  createPostToRoomTool, createGetRoomHistoryTool,
  createListArtifactTypesTool, createListArtifactsTool, createAddArtifactTool,
  createUpdateArtifactTool, createRemoveArtifactTool, createCastVoteTool,
  createWebTools, createWriteDocumentSectionTool,
} from './tools/built-in/index.ts'
import { createTaskListArtifactType } from './core/artifact-types/task-list.ts'
import { pollArtifactType } from './core/artifact-types/poll.ts'
import { createFlowArtifactType } from './core/artifact-types/flow.ts'
import { documentArtifactType } from './core/artifact-types/document.ts'
import { createToolCapabilityCache } from './llm/tool-capability.ts'

export interface System {
  readonly house: House
  readonly team: Team
  readonly routeMessage: RouteMessage
  readonly ollama: LLMProvider
  readonly toolRegistry: ToolRegistry
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
}

export const createSystem = (ollamaUrl?: string): System => {
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

  const resolveAgentName: ResolveAgentName = (name) => team.getAgent(name)?.id
  const resolveTag: ResolveTagFn = (tag) => team.listByTag(tag).map(a => a.id)

  const resolvedOllamaUrl = ollamaUrl ?? DEFAULTS.ollamaBaseUrl
  const ollama = createOllamaProvider(resolvedOllamaUrl)
  const toolCapabilityCache = createToolCapabilityCache(resolvedOllamaUrl)

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
    callSystemLLM: (options) => callLLM(ollama, options),
  }
  const house = createHouse(houseCallbacks)
  const routeMessage = createMessageRouter({ house })
  const toolRegistry = createToolRegistry()

  // Register built-in artifact types — task_list needs store reference for checkAutoResolve
  house.artifactTypes.register(createTaskListArtifactType(house.artifacts))
  house.artifactTypes.register(pollArtifactType)
  house.artifactTypes.register(createFlowArtifactType(team))
  house.artifactTypes.register(documentArtifactType)

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
  }

  const systemRemoveRoom = (roomId: string): boolean => {
    const room = house.getRoom(roomId)
    if (!room) return false
    for (const agentId of room.getParticipantIds()) {
      team.getAgent(agentId)?.leave(roomId)
    }
    return house.removeRoom(roomId)
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

  const boundSpawnAIAgent = (config: AIAgentConfig, options?: SpawnOptions) =>
    spawnAIAgent(config, ollama, house, team, routeMessage, toolRegistry, {
      ...options,
      toolCapabilityCache,
    })

  const boundSpawnHumanAgent = async (config: HumanAgentConfig, send: TransportSend): Promise<HumanAgent> => {
    const agent = createHumanAgent(config, send)
    await spawnHumanAgent(agent, house, team, routeMessage)
    return agent
  }

  return {
    house, team, routeMessage, ollama, toolRegistry,
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
  }
}

// --- Startup (only when run directly) ---

if (import.meta.main) {
  const { bootstrap } = await import('./bootstrap.ts')
  await bootstrap()
}
