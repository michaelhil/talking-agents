// ============================================================================
// Talking Agents — System Factory + Entry Point
//
// createSystem() builds the full system. Can be imported without side effects.
// When run directly (bun run src/main.ts), starts up and prints diagnostics.
// ============================================================================

import type { Agent, AIAgentConfig, House, LLMProvider, PostAndDeliver, Room, Team, ToolRegistry } from './core/types.ts'
import { DEFAULTS, SYSTEM_SENDER_ID } from './core/types.ts'
import { createHouse } from './core/house.ts'
import { createTeam } from './agents/team.ts'
import { createPostAndDeliver } from './core/delivery.ts'
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
  readonly postAndDeliver: PostAndDeliver
  readonly ollama: LLMProvider
  readonly toolRegistry: ToolRegistry
  readonly introRoom: Room
  readonly removeAgent: (id: string) => boolean
  readonly spawnAIAgent: (config: AIAgentConfig) => Promise<Agent>
  readonly spawnHumanAgent: (config: HumanAgentConfig, send: TransportSend) => Promise<HumanAgent>
}

export const createSystem = (ollamaUrl?: string): System => {
  const house = createHouse()
  const team = createTeam()
  const postAndDeliver = createPostAndDeliver(house, team)
  const ollama = createOllamaProvider(ollamaUrl ?? DEFAULTS.ollamaBaseUrl)
  const toolRegistry = createToolRegistry()

  // Register built-in tools
  toolRegistry.register(createListRoomsTool(house))
  toolRegistry.register(createGetTimeTool())
  toolRegistry.register(createQueryAgentTool(team))

  const introRoom = house.createRoom({
    name: 'Introductions',
    description: 'All participants introduce themselves here',
    visibility: 'public',
    createdBy: SYSTEM_SENDER_ID,
  })

  // Remove agent from team AND all rooms (prevents ghost member delivery)
  const removeAgent = (id: string): boolean => {
    const removed = team.remove(id)
    if (removed) {
      for (const profile of house.listAllRooms()) {
        house.getRoom(profile.id)?.removeMember(id)
      }
    }
    return removed
  }

  // Bound spawn methods — close over system dependencies
  const boundSpawnAIAgent = (config: AIAgentConfig) =>
    spawnAIAgent(config, ollama, house, team, postAndDeliver, toolRegistry)

  const boundSpawnHumanAgent = async (config: HumanAgentConfig, send: TransportSend): Promise<HumanAgent> => {
    const agent = createHumanAgent(config, send)
    await spawnHumanAgent(agent, house, team, postAndDeliver)
    return agent
  }

  return {
    house, team, postAndDeliver, ollama, toolRegistry, introRoom, removeAgent,
    spawnAIAgent: boundSpawnAIAgent,
    spawnHumanAgent: boundSpawnHumanAgent,
  }
}

// --- Startup (only when run directly) ---

if (import.meta.main) {
  const { createServer } = await import('./api/server.ts')

  const ollamaUrl = process.env.OLLAMA_URL ?? DEFAULTS.ollamaBaseUrl
  const system = createSystem(ollamaUrl)

  const pkg = await Bun.file(`${import.meta.dir}/../package.json`).json() as { version: string }
  console.log(`Talking Agents v${pkg.version}`)
  console.log(`Ollama: ${ollamaUrl}`)
  console.log(`Tools: ${system.toolRegistry.list().map(t => t.name).join(', ')}`)

  try {
    const models = await system.ollama.models()
    console.log(`Models available: ${models.join(', ')}`)
  } catch {
    console.warn('Warning: Could not connect to Ollama. AI agents will not function.')
  }

  console.log(`Default room ready: ${system.introRoom.profile.name}`)

  createServer(system, { port: parseInt(process.env.PORT ?? String(DEFAULTS.port), 10) })
}
