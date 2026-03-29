// ============================================================================
// Message Router — Routes messages to rooms or agents.
//
// Room messages: Room.post() handles storage and member delivery internally.
// DMs: Constructed here, delivered via the shared DeliverFn to both parties.
//
// Uses the same DeliverFn that House injects into rooms — single delivery path.
// Team is used only for DM recipient resolution (name → ID) and self-DM prevention.
// ============================================================================

import type { RouterDeps, Message, MessageTarget, RouteMessage } from './types.ts'

export const createMessageRouter = ({ house, team, deliver }: RouterDeps): RouteMessage => {
  return (target: MessageTarget, params) => {
    const correlationId = crypto.randomUUID()
    const delivered: Message[] = []

    // Room messages — Room.post() handles member delivery internally
    if (target.rooms) {
      for (const roomId of target.rooms) {
        const room = house.getRoom(roomId)
        if (!room) continue
        const message = room.post({ ...params, correlationId })
        delivered.push(message)
      }
    }

    // DMs — no Room involved, deliver via shared DeliverFn to both parties
    if (target.agents) {
      for (const agentRef of target.agents) {
        const recipient = team.getAgent(agentRef)
        if (!recipient || recipient.id === params.senderId) continue

        const dmMessage: Message = {
          id: crypto.randomUUID(),
          recipientId: recipient.id,
          senderId: params.senderId,
          senderName: params.senderName,
          content: params.content,
          timestamp: Date.now(),
          type: params.type,
          correlationId,
          generationMs: params.generationMs,
          metadata: params.metadata,
        }
        delivered.push(dmMessage)
        deliver(recipient.id, dmMessage)
        deliver(params.senderId, dmMessage)  // sender also needs the DM in their context
      }
    }

    return delivered
  }
}
