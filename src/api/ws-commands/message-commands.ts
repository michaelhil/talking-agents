import type { WSInbound, WSOutbound } from '../../core/types/ws-protocol.ts'
import type { CommandContext } from './types.ts'

export const handleMessageCommand = (msg: WSInbound, ctx: CommandContext): boolean => {
  const { ws, system, wsManager } = ctx

  switch (msg.type) {
    case 'post_message': {
      // v15+: senderId is REQUIRED on post_message. The WS session no longer
      // owns a default human agent; clients must name the actor explicitly.
      // Validates: present, exists in this instance, is a human (AI agents
      // post via the eval path, not WS).
      if (!msg.senderId) {
        wsManager.safeSend(ws, JSON.stringify({ type: 'error', message: 'senderId required for post_message' } satisfies WSOutbound))
        return true
      }
      const sender = system.team.getAgent(msg.senderId)
      if (!sender) {
        wsManager.safeSend(ws, JSON.stringify({ type: 'error', message: `unknown senderId: ${msg.senderId}` } satisfies WSOutbound))
        return true
      }
      if (sender.kind !== 'human') {
        wsManager.safeSend(ws, JSON.stringify({ type: 'error', message: `senderId must be a human agent` } satisfies WSOutbound))
        return true
      }
      const resolved = msg.target ?? {}
      const delivered = system.routeMessage(resolved, {
        senderId: sender.id,
        senderName: sender.name,
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
