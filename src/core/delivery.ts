// ============================================================================
// Delivery — Creates the postAndDeliver function.
// This is the single coordination point: posts messages to rooms and/or
// delivers DMs, using the team for recipient lookup.
// ============================================================================

import type { House, Message, MessageTarget, PostAndDeliver, Team } from './types.ts'

export const createPostAndDeliver = (house: House, team: Team): PostAndDeliver => {
  const deliver = (id: string, message: Message): void => {
    try {
      team.get(id)?.receive(message)
    } catch (err) {
      console.error(`[deliver] Failed for ${id}:`, err)
    }
  }

  return (target: MessageTarget, params) => {
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
}
