// ============================================================================
// samsinn — System Factory + Entry Point
//
// createSystem() builds the full system. Can be imported without side effects.
// When run directly (bun run src/main.ts), starts up and prints diagnostics.
// ============================================================================

import type { Agent, AIAgentConfig, DeliverFn, House, LLMProvider, Message, OnDeliveryModeChanged, OnFlowEvent, OnMembershipChanged, OnMessagePosted, OnRoomCreated, OnRoomDeleted, OnTodoChanged, OnTurnChanged, ResolveAgentName, RouteMessage, Room, Team, ToolRegistry } from './core/types.ts'
import { DEFAULTS } from './core/types.ts'
import { createHouse } from './core/house.ts'
import { createTeam } from './agents/team.ts'
import { createMessageRouter } from './core/delivery.ts'
import { createOllamaProvider } from './llm/ollama.ts'
import { createToolRegistry } from './core/tool-registry.ts'
import { spawnAIAgent, spawnHumanAgent, type SpawnOptions } from './agents/spawn.ts'
import { createHumanAgent } from './agents/human-agent.ts'
import type { HumanAgentConfig, TransportSend } from './agents/human-agent.ts'
import type { HumanAgent } from './agents/human-agent.ts'
import { addAgentToRoom, removeAgentFromRoom } from './agents/actions.ts'
import { createListRoomsTool, createGetTimeTool, createQueryAgentTool, createListTodosTool, createAddTodoTool, createUpdateTodoTool, createCreateRoomTool, createDeleteRoomTool, createAddToRoomTool, createRemoveFromRoomTool, createListAgentsTool, createGetMyContextTool, createSetDeliveryModeTool, createPauseRoomTool, createMuteAgentTool, createSetRoomPromptTool, createPostToRoomTool, createGetRoomHistoryTool, createDelegateTool } from './tools/built-in.ts'
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
  readonly setOnTodoChanged: (callback: OnTodoChanged) => void
  readonly setOnRoomCreated: (callback: OnRoomCreated) => void
  readonly setOnRoomDeleted: (callback: OnRoomDeleted) => void
  readonly setOnMembershipChanged: (callback: OnMembershipChanged) => void
}

export const createSystem = (ollamaUrl?: string): System => {
  const team = createTeam()

  // Single deliver function — used by both Room (via House) and DMs (via message router)
  const deliver: DeliverFn = (agentId, message, history) => {
    team.getAgent(agentId)?.receive(message, history)
  }

  // Late-binding callbacks — set by server after wsManager is created.
  // Generic wrapper: creates a proxy function and a setter for the real callback.
  const lateBinding = <T extends (...args: never[]) => void>(): { proxy: T; set: (cb: T) => void } => {
    let real: T | undefined
    const proxy = ((...args: Parameters<T>) => real?.(...args)) as T
    return { proxy, set: (cb: T) => { real = cb } }
  }

  const messagePosted = lateBinding<OnMessagePosted>()
  const turnChanged = lateBinding<OnTurnChanged>()
  const deliveryModeChanged = lateBinding<OnDeliveryModeChanged>()
  const flowEvent = lateBinding<OnFlowEvent>()
  const todoChanged = lateBinding<OnTodoChanged>()
  const roomCreated = lateBinding<OnRoomCreated>()
  const roomDeleted = lateBinding<OnRoomDeleted>()
  const membershipChanged = lateBinding<OnMembershipChanged>()

  // Agent name → ID resolver for [[AgentName]] addressing in rooms
  const resolveAgentName: ResolveAgentName = (name) => team.getAgent(name)?.id

  const house = createHouse(deliver, resolveAgentName, messagePosted.proxy, turnChanged.proxy, deliveryModeChanged.proxy, flowEvent.proxy, todoChanged.proxy, roomCreated.proxy, roomDeleted.proxy)
  const routeMessage = createMessageRouter(house, team, deliver)
  const resolvedOllamaUrl = ollamaUrl ?? DEFAULTS.ollamaBaseUrl
  const ollama = createOllamaProvider(resolvedOllamaUrl)
  const toolCapabilityCache = createToolCapabilityCache(resolvedOllamaUrl)
  const toolRegistry = createToolRegistry()

  // System-level membership operations — single implementation used by WS, HTTP, tools
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

  // Remove room: cascade agent.leave for all current members, then delete
  const systemRemoveRoom = (roomId: string): boolean => {
    const room = house.getRoom(roomId)
    if (!room) return false
    for (const agentId of room.getParticipantIds()) {
      team.getAgent(agentId)?.leave(roomId)
    }
    return house.removeRoom(roomId)
    // onRoomDeleted is fired inside house.removeRoom
  }

  // Remove agent from team AND all rooms (prevents ghost member delivery)
  const removeAgent = (id: string): boolean => {
    const agent = team.getAgent(id)
    if (!agent) return false
    for (const profile of house.listAllRooms()) {
      const room = house.getRoom(profile.id)
      if (room?.hasMember(id)) {
        room.removeMember(id)
        agent.leave(profile.id)
      }
    }
    return team.removeAgent(id)
  }

  // Register built-in tools — pass system methods so tools use the single implementation
  toolRegistry.register(createListRoomsTool(house))
  toolRegistry.register(createGetTimeTool())
  toolRegistry.register(createQueryAgentTool(team))
  toolRegistry.register(createListTodosTool(house))
  toolRegistry.register(createAddTodoTool(house))
  toolRegistry.register(createUpdateTodoTool(house))
  toolRegistry.register(createCreateRoomTool(house, systemAddAgentToRoom))
  toolRegistry.register(createDeleteRoomTool(systemRemoveRoom, house))
  toolRegistry.register(createAddToRoomTool(team, house, systemAddAgentToRoom))
  toolRegistry.register(createRemoveFromRoomTool(team, house, systemRemoveAgentFromRoom))
  toolRegistry.register(createListAgentsTool(team))
  toolRegistry.register(createGetMyContextTool(team, house))
  toolRegistry.register(createSetDeliveryModeTool(house))
  toolRegistry.register(createPauseRoomTool(house))
  toolRegistry.register(createMuteAgentTool(team, house))
  toolRegistry.register(createSetRoomPromptTool(house))
  toolRegistry.register(createPostToRoomTool(house))
  toolRegistry.register(createGetRoomHistoryTool(house))
  toolRegistry.register(createDelegateTool(team, house))

  // Bound spawn methods — close over system dependencies
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
    setOnTodoChanged: todoChanged.set,
    setOnRoomCreated: roomCreated.set,
    setOnRoomDeleted: roomDeleted.set,
    setOnMembershipChanged: membershipChanged.set,
  }
}

// --- Startup (only when run directly) ---

if (import.meta.main) {
  const headless = process.argv.includes('--headless')

  // In headless mode, redirect console.log to stderr (stdout is reserved for MCP protocol)
  if (headless) {
    const stderrLog = (...args: unknown[]) => console.error(...args)
    console.log = stderrLog
    console.info = stderrLog
  }

  const { registerAllMCPServers } = await import('./integrations/mcp/client.ts')
  const { existsSync } = await import('node:fs')
  const { loadSnapshot, restoreFromSnapshot, createAutoSaver } = await import('./core/snapshot.ts')
  const { resolve } = await import('node:path')

  const ollamaUrl = process.env.OLLAMA_URL ?? DEFAULTS.ollamaBaseUrl
  const system = createSystem(ollamaUrl)

  const pkg = await Bun.file(`${import.meta.dir}/../package.json`).json() as { version: string }
  console.log(`Samsinn v${pkg.version}${headless ? ' (headless)' : ''}`)
  console.log(`Ollama: ${ollamaUrl}`)

  // Load filesystem tools before snapshot restore so restored agents get them
  const { loadExternalTools } = await import('./tools/loader.ts')
  await loadExternalTools(system.toolRegistry)

  // Restore from snapshot if available
  const snapshotPath = resolve(import.meta.dir, '../data/snapshot.json')
  const snapshot = await loadSnapshot(snapshotPath)
  if (snapshot) {
    await restoreFromSnapshot(system, snapshot)
    console.log(`Restored from snapshot: ${snapshot.rooms.length} rooms, ${snapshot.agents.length} agents`)
  } else {
    console.log('Fresh start — no snapshot found. Create rooms and agents from the UI.')
  }

  // Register MCP client tools from config (external tool servers)
  const mcpConfigPath = `${import.meta.dir}/../mcp-servers.json`
  if (existsSync(mcpConfigPath)) {
    const mcpConfig = await Bun.file(mcpConfigPath).json()
    await registerAllMCPServers(system.toolRegistry, mcpConfig)
  }

  console.log(`Tools: ${system.toolRegistry.list().map(t => t.name).join(', ')}`)

  try {
    const models = await system.ollama.models()
    console.log(`Models available: ${models.join(', ')}`)
  } catch {
    console.warn('Warning: Could not connect to Ollama. AI agents will not function.')
  }

  // Auto-save: debounced save on state changes
  const autoSaver = createAutoSaver(system, snapshotPath)

  // Graceful shutdown: flush snapshot before exit
  const shutdown = async () => {
    console.log('Shutting down, saving snapshot...')
    try {
      await autoSaver.flush()
      console.log('Snapshot saved.')
    } catch (err) {
      console.error('Failed to save snapshot on shutdown:', err)
    }
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  if (headless) {
    // Headless mode: MCP server on stdio, no HTTP server
    const { createMCPServer, wireEventNotifications, startMCPServerStdio } = await import('./integrations/mcp/server.ts')
    const mcpServer = createMCPServer(system)
    wireEventNotifications(system, mcpServer)
    await startMCPServerStdio(mcpServer)
    console.log('MCP server running on stdio')
  } else {
    // Full mode: HTTP + WebSocket server with browser UI
    const { createServer } = await import('./api/server.ts')
    createServer(system, {
      port: parseInt(process.env.PORT ?? String(DEFAULTS.port), 10),
      onAutoSave: autoSaver.scheduleSave,
    })
  }
}
