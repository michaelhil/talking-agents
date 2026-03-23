// ============================================================================
// Room — Pure data structure. Array of messages + profile + member tracking.
// Zero external dependencies. Does NOT handle delivery.
// post() appends and returns recipient IDs. Caller handles delivery.
// Room stamps its own roomId on messages — caller never passes roomId.
//
// Members are tracked via addMember/hasMember for access control.
// post() implicitly adds the sender as a member.
// Messages are capped at maxMessages to prevent unbounded growth.
// ============================================================================

import type { Message, PostParams, PostResult, Room, RoomProfile } from './types.ts'
import { DEFAULTS, SYSTEM_SENDER_ID } from './types.ts'

export const createRoom = (profile: RoomProfile, maxMessages?: number): Room => {
  const messages: Message[] = []
  const members = new Set<string>()
  const messageLimit = maxMessages ?? DEFAULTS.roomMessageLimit

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

    // Sender becomes a member implicitly
    if (params.senderId !== SYSTEM_SENDER_ID) {
      members.add(params.senderId)
    }

    // Evict oldest messages if over limit
    if (messages.length > messageLimit) {
      messages.splice(0, messages.length - messageLimit)
    }

    const recipientIds = [...members].filter(id => id !== message.senderId)
    return { message, recipientIds }
  }

  const getRecent = (n: number): ReadonlyArray<Message> => {
    if (n <= 0) return []
    if (messages.length <= n) return [...messages]
    return messages.slice(-n)
  }

  const getParticipantIds = (): ReadonlyArray<string> => [...members]

  const addMember = (id: string): void => {
    members.add(id)
  }

  const hasMember = (id: string): boolean => members.has(id)

  const getMessageCount = (): number => messages.length

  return {
    profile,
    post,
    getRecent,
    getParticipantIds,
    addMember,
    hasMember,
    getMessageCount,
  }
}
