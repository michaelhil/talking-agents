// ============================================================================
// Talking Agents — Entry Point
// Creates house, team, and postAndDeliver, then starts the system.
// Phase 3 will add HTTP server + WebSocket here.
// ============================================================================

import type { Message, MessageTarget, PostAndDeliver } from './core/types.ts'
import { DEFAULTS } from './core/types.ts'
import { createHouse, initIntroductionsRoom } from './core/house.ts'
import { createTeam } from './agents/team.ts'
import { createOllamaProvider } from './llm/ollama.ts'

// --- Create the system ---

const house = createHouse()
const team = createTeam()
const intro = initIntroductionsRoom(house)
const ollamaUrl = process.env.OLLAMA_URL ?? DEFAULTS.ollamaBaseUrl
const ollama = createOllamaProvider(ollamaUrl)

// --- Delivery ---

const deliver = (id: string, message: Message): void => {
  try {
    team.get(id)?.receive(message)
  } catch (err) {
    console.error(`[deliver] Failed for ${id}:`, err)
  }
}

export const postAndDeliver: PostAndDeliver = (target: MessageTarget, params) => {
  const correlationId = crypto.randomUUID()
  const delivered: Message[] = []

  if (target.rooms) {
    for (const roomId of target.rooms) {
      const room = house.getRoom(roomId)
      if (!room) continue
      const { message, recipientIds } = room.post({ ...params, correlationId })
      delivered.push(message)
      for (const id of recipientIds) deliver(id, message)
    }
  }

  if (target.agents) {
    for (const agentId of target.agents) {
      if (agentId === params.senderId) continue
      const dmMessage: Message = {
        id: crypto.randomUUID(),
        recipientId: agentId,
        senderId: params.senderId,
        content: params.content,
        timestamp: Date.now(),
        type: params.type,
        correlationId,
        generationMs: params.generationMs,
        metadata: params.metadata,
      }
      delivered.push(dmMessage)
      deliver(agentId, dmMessage)
      deliver(params.senderId, dmMessage)
    }
  }

  return delivered
}

// --- Startup ---

console.log('Talking Agents v0.1.0')
console.log(`Ollama: ${ollamaUrl}`)

try {
  const models = await ollama.models()
  console.log(`Models available: ${models.join(', ')}`)
} catch {
  console.warn('Warning: Could not connect to Ollama. AI agents will not function.')
}

console.log(`Introductions room ready: ${intro.profile.name}`)
console.log('System ready. Phase 3 will add HTTP server + WebSocket UI.')

// Export for Phase 3 server integration
export { house, team, intro, ollama }
