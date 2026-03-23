// ============================================================================
// Human Agent — Agent backed by a human via WebSocket (or other transport).
//
// Same Agent interface as AI agents. The difference:
// - receive() pushes message over transport instead of LLM evaluation
// - join() sends recent history over transport (no LLM summary)
//
// ID is auto-generated UUID, same as AI agents.
// ============================================================================

import type { Agent, AgentState, Message, Room } from '../core/types.ts'
import { DEFAULTS } from '../core/types.ts'
import {
  addMessageWithEviction,
  getMessagesAll,
  getMessagesForPeer as getMessagesForPeerHelper,
  getMessagesForRoom as getMessagesForRoomHelper,
  getRoomIdsFromMessages,
} from '../core/messages.ts'

export interface HumanAgentConfig {
  readonly name: string
  readonly description: string
  readonly metadata?: Record<string, unknown>
}

export type TransportSend = (message: Message) => void

export interface HumanAgent extends Agent {
  readonly setTransport: (newSend: TransportSend) => void
}

export const createHumanAgent = (
  config: HumanAgentConfig,
  initialSend: TransportSend,
): HumanAgent => {
  const agentId = crypto.randomUUID()
  let send = initialSend
  const messages: Message[] = []
  const historyLimit = DEFAULTS.historyLimit

  // Human agents are always 'idle' — state changes come from UI interaction, not LLM
  const state: AgentState = {
    get: () => 'idle',
    subscribe: () => () => {},
  }

  const addMessage = (message: Message): void => {
    addMessageWithEviction(messages, message, agentId, historyLimit)
  }

  const getMessages = (): ReadonlyArray<Message> => getMessagesAll(messages)
  const getRoomIds = (): ReadonlyArray<string> => getRoomIdsFromMessages(messages)
  const getMessagesForRoom = (roomId: string, limit?: number): ReadonlyArray<Message> =>
    getMessagesForRoomHelper(messages, roomId, limit ?? historyLimit)
  const getMessagesForPeer = (peerId: string, limit?: number): ReadonlyArray<Message> =>
    getMessagesForPeerHelper(messages, agentId, peerId, limit ?? historyLimit)

  const receive = (message: Message): void => {
    addMessage(message)

    // Don't echo own messages back over transport
    if (message.senderId === agentId) return

    try {
      send(message)
    } catch (err) {
      console.error(`[${config.name}] Transport send failed:`, err)
    }
  }

  const join = async (room: Room): Promise<void> => {
    const recent = room.getRecent(historyLimit)
    const existingIds = new Set(messages.map(m => m.id))
    for (const msg of recent) {
      if (existingIds.has(msg.id)) continue

      addMessage(msg)
      try {
        send(msg)
      } catch (err) {
        console.error(`[${config.name}] Failed to send history for ${room.profile.name}:`, err)
        break
      }
    }
  }

  return {
    id: agentId,
    name: config.name,
    description: config.description,
    kind: 'human',
    metadata: config.metadata ?? {},
    state,
    getMessages,
    receive,
    join,
    getRoomIds,
    getMessagesForRoom,
    getMessagesForPeer,
    setTransport: (newSend: TransportSend) => { send = newSend },
  }
}
