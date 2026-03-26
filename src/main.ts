// ============================================================================
// samsinn — System Factory + Entry Point
//
// createSystem() builds the full system. Can be imported without side effects.
// When run directly (bun run src/main.ts), starts up and prints diagnostics.
// ============================================================================

import type { Agent, AIAgentConfig, DeliverFn, House, LLMProvider, Message, OnDeliveryModeChanged, OnFlowEvent, OnMessagePosted, OnTurnChanged, RouteMessage, Room, Team, ToolRegistry } from './core/types.ts'
import { DEFAULTS, SYSTEM_SENDER_ID } from './core/types.ts'
import { createHouse } from './core/house.ts'
import { createTeam } from './agents/team.ts'
import { createMessageRouter } from './core/delivery.ts'
import { createOllamaProvider } from './llm/ollama.ts'
import { createToolRegistry } from './core/tool-registry.ts'
import { spawnAIAgent, spawnHumanAgent } from './agents/spawn.ts'
import { createHumanAgent } from './agents/human-agent.ts'
import type { HumanAgentConfig, TransportSend } from './agents/human-agent.ts'
import type { HumanAgent } from './agents/human-agent.ts'
import { createListRoomsTool, createGetTimeTool, createQueryAgentTool } from './tools/built-in.ts'

export interface System {
  readonly house: House
  readonly team: Team
  readonly routeMessage: RouteMessage
  readonly ollama: LLMProvider
  readonly toolRegistry: ToolRegistry
  readonly introRoom: Room
  readonly removeAgent: (id: string) => boolean
  readonly spawnAIAgent: (config: AIAgentConfig) => Promise<Agent>
  readonly spawnHumanAgent: (config: HumanAgentConfig, send: TransportSend) => Promise<HumanAgent>
  readonly setOnMessagePosted: (callback: OnMessagePosted) => void
  readonly setOnTurnChanged: (callback: OnTurnChanged) => void
  readonly setOnDeliveryModeChanged: (callback: OnDeliveryModeChanged) => void
  readonly setOnFlowEvent: (callback: OnFlowEvent) => void
}

export const createSystem = (ollamaUrl?: string): System => {
  const team = createTeam()

  // Single deliver function — used by both Room (via House) and DMs (via message router)
  const deliver: DeliverFn = (agentId, message, history) => {
    team.getAgent(agentId)?.receive(message, history)
  }

  // Late-binding callbacks — set by server after wsManager is created
  let messagePostedCallback: OnMessagePosted | undefined
  let turnChangedCallback: OnTurnChanged | undefined
  let deliveryModeChangedCallback: OnDeliveryModeChanged | undefined
  let flowEventCallback: OnFlowEvent | undefined

  const onMessagePosted: OnMessagePosted = (roomId, message) => {
    messagePostedCallback?.(roomId, message)
  }
  const onTurnChanged: OnTurnChanged = (roomId, agentId, waitingForHuman) => {
    turnChangedCallback?.(roomId, agentId, waitingForHuman)
  }
  const onDeliveryModeChanged: OnDeliveryModeChanged = (roomId, mode) => {
    deliveryModeChangedCallback?.(roomId, mode)
  }
  const onFlowEvent: OnFlowEvent = (roomId, event, detail) => {
    flowEventCallback?.(roomId, event, detail)
  }

  const house = createHouse(deliver, onMessagePosted, onTurnChanged, onDeliveryModeChanged, onFlowEvent)
  const routeMessage = createMessageRouter(house, team, deliver)
  const ollama = createOllamaProvider(ollamaUrl ?? DEFAULTS.ollamaBaseUrl)
  const toolRegistry = createToolRegistry()

  // Register built-in tools
  toolRegistry.register(createListRoomsTool(house))
  toolRegistry.register(createGetTimeTool())
  toolRegistry.register(createQueryAgentTool(team))

  const introRoom = house.createRoom({
    name: 'Introductions',
    visibility: 'public',
    createdBy: SYSTEM_SENDER_ID,
  })

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
  const boundSpawnAIAgent = (config: AIAgentConfig) =>
    spawnAIAgent(config, ollama, house, team, routeMessage, toolRegistry)

  const boundSpawnHumanAgent = async (config: HumanAgentConfig, send: TransportSend): Promise<HumanAgent> => {
    const agent = createHumanAgent(config, send)
    await spawnHumanAgent(agent, house, team, routeMessage)
    return agent
  }

  return {
    house, team, routeMessage, ollama, toolRegistry, introRoom, removeAgent,
    spawnAIAgent: boundSpawnAIAgent,
    spawnHumanAgent: boundSpawnHumanAgent,
    setOnMessagePosted: (callback: OnMessagePosted) => { messagePostedCallback = callback },
    setOnTurnChanged: (callback: OnTurnChanged) => { turnChangedCallback = callback },
    setOnDeliveryModeChanged: (callback: OnDeliveryModeChanged) => { deliveryModeChangedCallback = callback },
    setOnFlowEvent: (callback: OnFlowEvent) => { flowEventCallback = callback },
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

  const ollamaUrl = process.env.OLLAMA_URL ?? DEFAULTS.ollamaBaseUrl
  const system = createSystem(ollamaUrl)

  const pkg = await Bun.file(`${import.meta.dir}/../package.json`).json() as { version: string }
  console.log(`Samsinn v${pkg.version}${headless ? ' (headless)' : ''}`)
  console.log(`Ollama: ${ollamaUrl}`)

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

  console.log(`Default room ready: ${system.introRoom.profile.name}`)

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
    createServer(system, { port: parseInt(process.env.PORT ?? String(DEFAULTS.port), 10) })
  }
}
