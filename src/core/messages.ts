// ============================================================================
// Message utilities — shared helpers for working with agent message arrays.
// Used by both ai-agent.ts and human-agent.ts to avoid duplication.
// ============================================================================

import type { Message } from './types.ts'

export const getMessagesAll = (messages: ReadonlyArray<Message>): ReadonlyArray<Message> =>
  [...messages]

export const getRoomIdsFromMessages = (messages: ReadonlyArray<Message>): ReadonlyArray<string> =>
  [...new Set(
    messages
      .filter(m => m.roomId !== undefined)
      .map(m => m.roomId!),
  )]

export const getMessagesForRoom = (
  messages: ReadonlyArray<Message>,
  roomId: string,
  limit: number,
): ReadonlyArray<Message> => {
  const roomMsgs = messages.filter(m => m.roomId === roomId)
  if (roomMsgs.length <= limit) return roomMsgs
  return roomMsgs.slice(-limit)
}

export const getMessagesForPeer = (
  messages: ReadonlyArray<Message>,
  agentId: string,
  peerId: string,
  limit: number,
): ReadonlyArray<Message> => {
  const peerMsgs = messages.filter(m =>
    m.roomId === undefined && (
      (m.senderId === peerId && m.recipientId === agentId) ||
      (m.senderId === agentId && m.recipientId === peerId)
    ),
  )
  if (peerMsgs.length <= limit) return peerMsgs
  return peerMsgs.slice(-limit)
}

// Evict oldest messages matching a filter, keeping at most `limit` matching messages.
// Only runs when total messages exceed limit (avoids scanning on every add).
// Mutates the array in place.
export const evictByFilter = (
  messages: Message[],
  filter: (m: Message) => boolean,
  limit: number,
): void => {
  // Skip scan if total messages are within limit (fast path)
  if (messages.length <= limit) return

  const matching = messages.filter(filter)
  if (matching.length <= limit) return

  const excess = matching.length - limit
  const toRemove = new Set(matching.slice(0, excess).map(m => m.id))
  const kept = messages.filter(m => !toRemove.has(m.id))
  messages.length = 0
  messages.push(...kept)
}

// Add a message and evict old messages from the same context.
export const addMessageWithEviction = (
  messages: Message[],
  message: Message,
  agentId: string,
  limit: number,
): void => {
  messages.push(message)

  if (message.roomId) {
    evictByFilter(messages, m => m.roomId === message.roomId, limit)
  } else if (message.recipientId || message.senderId !== agentId) {
    const peerId = message.senderId === agentId
      ? message.recipientId
      : message.senderId
    if (peerId) {
      evictByFilter(
        messages,
        m => m.roomId === undefined && (
          (m.senderId === peerId && m.recipientId === agentId) ||
          (m.senderId === agentId && m.recipientId === peerId)
        ),
        limit,
      )
    }
  }
}
