// ============================================================================
// Human Agent — Agent backed by a human via WebSocket (or other transport).
//
// Same Agent interface as AI agents. The difference:
// - receive() pushes message over transport instead of LLM evaluation
// - join() snapshots profiles and sends recent history (no LLM summary)
//
// ID is auto-generated UUID, same as AI agents.
// ============================================================================

import type { Agent, AgentProfile, Message, Room, RoomProfile } from '../core/types.ts'
import { DEFAULTS } from '../core/types.ts'
import {
  addMessageWithEviction,
  getMessagesAll,
  getMessagesForPeer as getMessagesForPeerHelper,
  getMessagesForRoom as getMessagesForRoomHelper,
  getRoomIdsFromMessages,
} from '../core/messages.ts'
import { extractAgentProfile as extractProfile } from './shared.ts'

export interface HumanAgentConfig {
  readonly name: string
  readonly description: string
  readonly metadata?: Record<string, unknown>
}

export type TransportSend = (message: Message) => void

export const createHumanAgent = (
  config: HumanAgentConfig,
  send: TransportSend,
): Agent => {
  const agentId = crypto.randomUUID()
  const messages: Message[] = []
  const roomProfiles = new Map<string, RoomProfile>()
  const agentProfiles = new Map<string, AgentProfile>()
  const historyLimit = DEFAULTS.historyLimit

  const extractAgentProfileFromMessage = (message: Message): void => {
    extractProfile(message, agentId, agentProfiles)
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
    extractAgentProfileFromMessage(message)

    // Don't echo own messages back over transport
    if (message.senderId === agentId) return

    try {
      send(message)
    } catch (err) {
      console.error(`[${config.name}] Transport send failed:`, err)
    }
  }

  const join = async (room: Room): Promise<void> => {
    roomProfiles.set(room.profile.id, room.profile)

    const recent = room.getRecent(historyLimit)
    const existingIds = new Set(messages.map(m => m.id))
    for (const msg of recent) {
      extractAgentProfileFromMessage(msg)
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
    getMessages,
    receive,
    join,
    getRoomIds,
    getMessagesForRoom,
    getMessagesForPeer,
  }
}
