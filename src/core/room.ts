// ============================================================================
// Room — Pure data structure. Array of messages + profile.
// Zero external dependencies. Does NOT handle delivery.
// post() appends and returns recipient IDs. Caller handles delivery.
// Room stamps its own roomId on messages — caller never passes roomId.
// ============================================================================

import type { Message, PostParams, PostResult, Room, RoomProfile } from './types.ts'
import { SYSTEM_SENDER_ID } from './types.ts'

export const createRoom = (profile: RoomProfile): Room => {
  const messages: Message[] = []

  const post = (params: PostParams): PostResult => {
    const message: Message = {
      id: crypto.randomUUID(),
      roomId: profile.id,
      senderId: params.senderId,
      content: params.content,
      timestamp: Date.now(),
      type: params.type,
      correlationId: params.correlationId,
      generationMs: params.generationMs,
      metadata: params.metadata,
    }
    messages.push(message)

    const recipientIds = getParticipantIds().filter(id => id !== message.senderId)

    return { message, recipientIds }
  }

  const getRecent = (n: number): ReadonlyArray<Message> => {
    if (n <= 0) return []
    if (messages.length <= n) return [...messages]
    return messages.slice(-n)
  }

  const getParticipantIds = (): ReadonlyArray<string> => {
    const ids = new Set<string>()
    for (const msg of messages) {
      if (msg.senderId !== SYSTEM_SENDER_ID) {
        ids.add(msg.senderId)
      }
    }
    return [...ids]
  }

  const getMessageCount = (): number => messages.length

  return {
    profile,
    post,
    getRecent,
    getParticipantIds,
    getMessageCount,
  }
}
