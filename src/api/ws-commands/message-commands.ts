import type { WSInbound, WSOutbound } from '../../core/types/ws-protocol.ts'
import type { CommandContext } from './types.ts'

export const handleMessageCommand = (msg: WSInbound, ctx: CommandContext): boolean => {
  const { ws, session, system, wsManager } = ctx

  switch (msg.type) {
    case 'post_message': {
      // senderId override: client picks which human to post as. Validates
      // the agent is a human in this instance. Falls back to session.agent
      // (legacy WS-bound human) when not provided.
      let senderId = session.agent.id
      let senderName = session.agent.name
      if (msg.senderId) {
        const sender = system.team.getAgent(msg.senderId)
        if (!sender) {
          wsManager.safeSend(ws, JSON.stringify({ type: 'error', message: `unknown senderId: ${msg.senderId}` } satisfies WSOutbound))
          return true
        }
        if (sender.kind !== 'human') {
          wsManager.safeSend(ws, JSON.stringify({ type: 'error', message: `senderId must be a human agent` } satisfies WSOutbound))
          return true
        }
        senderId = sender.id
        senderName = sender.name
      }
      const resolved = msg.target ?? {}
      const delivered = system.routeMessage(resolved, {
        senderId,
        senderName,
        content: msg.content,
        type: 'chat',
      })
      for (const m of delivered) {
        wsManager.safeSend(ws, JSON.stringify({ type: 'message', message: m } satisfies WSOutbound))
      }
      return true
    }
    default:
      return false
  }
}
