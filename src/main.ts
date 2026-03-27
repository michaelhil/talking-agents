// ============================================================================
// samsinn — System Factory + Entry Point
//
// createSystem() builds the full system. Can be imported without side effects.
// When run directly (bun run src/main.ts), starts up and prints diagnostics.
// ============================================================================

import type { Agent, AIAgentConfig, DeliverFn, House, LLMProvider, Message, OnDeliveryModeChanged, OnFlowEvent, OnMessagePosted, OnTodoChanged, OnTurnChanged, ResolveAgentName, RouteMessage, Room, Team, ToolRegistry } from './core/types.ts'
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
import { createListRoomsTool, createGetTimeTool, createQueryAgentTool, createListTodosTool, createAddTodoTool, createUpdateTodoTool } from './tools/built-in.ts'

export interface System {
  readonly house: House
  readonly team: Team
  readonly routeMessage: RouteMessage
  readonly ollama: LLMProvider
  readonly toolRegistry: ToolRegistry
  readonly removeAgent: (id: string) => boolean
  readonly spawnAIAgent: (config: AIAgentConfig, options?: SpawnOptions) => Promise<Agent>
  readonly spawnHumanAgent: (config: HumanAgentConfig, send: TransportSend) => Promise<HumanAgent>
  readonly setOnMessagePosted: (callback: OnMessagePosted) => void
  readonly setOnTurnChanged: (callback: OnTurnChanged) => void
  readonly setOnDeliveryModeChanged: (callback: OnDeliveryModeChanged) => void
  readonly setOnFlowEvent: (callback: OnFlowEvent) => void
  readonly setOnTodoChanged: (callback: OnTodoChanged) => void
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

  // Agent name → ID resolver for [[AgentName]] addressing in rooms
  const resolveAgentName: ResolveAgentName = (name) => team.getAgent(name)?.id

  const house = createHouse(deliver, resolveAgentName, messagePosted.proxy, turnChanged.proxy, deliveryModeChanged.proxy, flowEvent.proxy, todoChanged.proxy)
  const routeMessage = createMessageRouter(house, team, deliver)
  const ollama = createOllamaProvider(ollamaUrl ?? DEFAULTS.ollamaBaseUrl)
  const toolRegistry = createToolRegistry()

  // Register built-in tools
  toolRegistry.register(createListRoomsTool(house))
  toolRegistry.register(createGetTimeTool())
  toolRegistry.register(createQueryAgentTool(team))
  toolRegistry.register(createListTodosTool(house))
  toolRegistry.register(createAddTodoTool(house))
  toolRegistry.register(createUpdateTodoTool(house))

  // Default intro room — created only when no snapshot is being restored.
  // Callers that restore from snapshot should NOT rely on this field.
  // No default room — start empty or restore from snapshot

  // Remove agent from team AND all rooms (prevents ghost member delivery)
  const removeAgent = (id: string): boolean => {
    const removed = team.removeAgent(id)
    if (removed) {
      for (const profile of house.listAllRooms()) {
        house.getRoom(profile.id)?.removeMember(id)
      }
    }
    return removed
  }

  // Bound spawn methods — close over system dependencies
  const boundSpawnAIAgent = (config: AIAgentConfig, options?: SpawnOptions) =>
    spawnAIAgent(config, ollama, house, team, routeMessage, toolRegistry, options)

  const boundSpawnHumanAgent = async (config: HumanAgentConfig, send: TransportSend): Promise<HumanAgent> => {
    const agent = createHumanAgent(config, send)
    await spawnHumanAgent(agent, house, team, routeMessage)
    return agent
  }

  return {
    house, team, routeMessage, ollama, toolRegistry,
    removeAgent,
    spawnAIAgent: boundSpawnAIAgent,
    spawnHumanAgent: boundSpawnHumanAgent,
    setOnMessagePosted: messagePosted.set,
    setOnTurnChanged: turnChanged.set,
    setOnDeliveryModeChanged: deliveryModeChanged.set,
    setOnFlowEvent: flowEvent.set,
    setOnTodoChanged: todoChanged.set,
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

  // Restore from snapshot if available
  const snapshotPath = resolve(import.meta.dir, '../data/snapshot.json')
  const snapshot = await loadSnapshot(snapshotPath)
  if (snapshot) {
    await restoreFromSnapshot(system, snapshot)
    console.log(`Restored from snapshot: ${snapshot.rooms.length} rooms, ${snapshot.agents.length} agents (all rooms paused)`)
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
