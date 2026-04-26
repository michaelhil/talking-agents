import type { WSInbound, WSOutbound } from '../../core/types/ws-protocol.ts'
import type { CommandContext } from './types.ts'

export const handleMessageCommand = (msg: WSInbound, ctx: CommandContext): boolean => {
  const { ws, session, system, wsManager } = ctx

  switch (msg.type) {
    case 'post_message': {
      const resolved = msg.target ?? {}
      const delivered = system.routeMessage(resolved, {
        senderId: session.agent.id,
        senderName: session.agent.name,
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
