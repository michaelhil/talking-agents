// ============================================================================
// Talking Agents — Entry Point
// Creates the system via factory function, then starts up.
// Phase 3 will add HTTP server + WebSocket here.
// ============================================================================

import type { House, LLMProvider, PostAndDeliver, Room, Team } from './core/types.ts'
import { DEFAULTS, SYSTEM_SENDER_ID } from './core/types.ts'
import { createHouse } from './core/house.ts'
import { createTeam } from './agents/team.ts'
import { createPostAndDeliver } from './core/delivery.ts'
import { createOllamaProvider } from './llm/ollama.ts'

export interface System {
  readonly house: House
  readonly team: Team
  readonly postAndDeliver: PostAndDeliver
  readonly ollama: LLMProvider
  readonly introRoom: Room
}

export const createSystem = (ollamaUrl?: string): System => {
  const house = createHouse()
  const team = createTeam()
  const postAndDeliver = createPostAndDeliver(house, team)
  const ollama = createOllamaProvider(ollamaUrl ?? DEFAULTS.ollamaBaseUrl)

  const introRoom = house.createRoom({
    name: 'Introductions',
    description: 'All participants introduce themselves here',
    visibility: 'public',
    createdBy: SYSTEM_SENDER_ID,
  })

  return { house, team, postAndDeliver, ollama, introRoom }
}

// --- Startup ---

const ollamaUrl = process.env.OLLAMA_URL ?? DEFAULTS.ollamaBaseUrl
const system = createSystem(ollamaUrl)

console.log('Talking Agents v0.1.0')
console.log(`Ollama: ${ollamaUrl}`)

try {
  const models = await system.ollama.models()
  console.log(`Models available: ${models.join(', ')}`)
} catch {
  console.warn('Warning: Could not connect to Ollama. AI agents will not function.')
}

console.log(`Default room ready: ${system.introRoom.profile.name}`)
console.log('System ready. Phase 3 will add HTTP server + WebSocket UI.')

export default system
