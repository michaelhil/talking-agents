// ============================================================================
// Human Agent — Agent backed by a human via WebSocket (or other transport).
//
// Same Agent interface as AI agents. The difference:
// - receive() pushes message over transport instead of LLM evaluation
// - join() snapshots profiles and sends recent history (no LLM summary)
// ============================================================================

import type { Agent, AgentProfile, Message, Room, RoomProfile } from '../core/types.ts'
import { DEFAULTS } from '../core/types.ts'
import { extractAgentProfile as extractProfile } from './shared.ts'

export interface HumanAgentConfig {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly metadata?: Record<string, unknown>
}

export type TransportSend = (message: Message) => void

export const createHumanAgent = (
  config: HumanAgentConfig,
  send: TransportSend,
): Agent => {
  const messages: Message[] = []
  const roomProfiles = new Map<string, RoomProfile>()
  const agentProfiles = new Map<string, AgentProfile>()

  const extractAgentProfileFromMessage = (message: Message): void => {
    extractProfile(message, config.id, agentProfiles)
  }

  const addMessage = (message: Message): void => {
    messages.push(message)
  }

  const getMessages = (): ReadonlyArray<Message> => [...messages]

  const getRoomIds = (): ReadonlyArray<string> =>
    [...new Set(
      messages
        .filter(m => m.roomId !== undefined)
        .map(m => m.roomId!),
    )]

  const getMessagesForRoom = (roomId: string, limit?: number): ReadonlyArray<Message> => {
    const roomMsgs = messages.filter(m => m.roomId === roomId)
    const effectiveLimit = limit ?? DEFAULTS.historyLimit
    if (roomMsgs.length <= effectiveLimit) return roomMsgs
    return roomMsgs.slice(-effectiveLimit)
  }

  const getMessagesForPeer = (peerId: string, limit?: number): ReadonlyArray<Message> => {
    const peerMsgs = messages.filter(m =>
      m.roomId === undefined && (
        (m.senderId === peerId && m.recipientId === config.id) ||
        (m.senderId === config.id && m.recipientId === peerId)
      ),
    )
    const effectiveLimit = limit ?? DEFAULTS.historyLimit
    if (peerMsgs.length <= effectiveLimit) return peerMsgs
    return peerMsgs.slice(-effectiveLimit)
  }

  const receive = (message: Message): void => {
    addMessage(message)
    extractAgentProfileFromMessage(message)
    try {
      send(message)
    } catch (err) {
      console.error(`[${config.name}] Transport send failed:`, err)
    }
  }

  const join = async (room: Room): Promise<void> => {
    roomProfiles.set(room.profile.id, room.profile)

    const recent = room.getRecent(DEFAULTS.historyLimit)
    const existingIds = new Set(messages.map(m => m.id))
    for (const msg of recent) {
      if (!existingIds.has(msg.id)) {
        addMessage(msg)
      }
      extractAgentProfileFromMessage(msg)
      try {
        send(msg)
      } catch (err) {
        console.error(`[${config.name}] Failed to send history for ${room.profile.name}:`, err)
        break
      }
    }
  }

  return {
    id: config.id,
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
