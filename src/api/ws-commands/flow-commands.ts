import type { WSInbound } from '../../core/types.ts'
import { requireRoom, type CommandContext } from './types.ts'

export const handleFlowCommand = (msg: WSInbound, ctx: CommandContext): boolean => {
  const { ws, session, system } = ctx

  switch (msg.type) {
    case 'add_flow': {
      const room = requireRoom(ws, system, msg.roomName)
      if (!room) return true
      const flow = room.addFlow({ name: msg.name, steps: msg.steps, loop: msg.loop ?? false })
      ws.send(JSON.stringify({ type: 'flow_event', roomName: room.profile.name, event: 'started', detail: { flowId: flow.id, flowName: flow.name } }))
      return true
    }
    case 'remove_flow': {
      const room = requireRoom(ws, system, msg.roomName)
      if (!room) return true
      room.removeFlow(msg.flowId)
      return true
    }
    case 'start_flow': {
      const room = requireRoom(ws, system, msg.roomName)
      if (!room) return true
      // Post the trigger message while paused so broadcast doesn't fire —
      // startFlow() will deliver it to the first step agent and unpause.
      room.setPaused(true)
      room.post({ senderId: session.agent.id, senderName: session.agent.name, content: msg.content, type: 'chat' })
      room.startFlow(msg.flowId)
      return true
    }
    case 'cancel_flow': {
      const room = requireRoom(ws, system, msg.roomName)
      if (!room) return true
      room.cancelFlow()
      return true
    }
    default:
      return false
  }
}
