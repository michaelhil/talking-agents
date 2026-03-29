import type { WSInbound } from '../../core/types.ts'
import { requireRoom, requireAgent, type CommandContext } from './types.ts'

export const handleRoomCommand = async (msg: WSInbound, ctx: CommandContext): Promise<boolean> => {
  const { ws, session, system, broadcast } = ctx

  switch (msg.type) {
    case 'create_room': {
      const result = system.house.createRoomSafe({
        name: msg.name,
        roomPrompt: msg.roomPrompt,
        createdBy: session.agent.id,
      })
      // Add the creator; system.addAgentToRoom fires membership_changed + join message
      // room_created fired via onRoomCreated callback
      await system.addAgentToRoom(session.agent.id, result.value.profile.id)
      return true
    }
    case 'add_to_room': {
      const room = requireRoom(ws, system, msg.roomName)
      const agent = requireAgent(ws, system, msg.agentName)
      if (room && agent) await system.addAgentToRoom(agent.id, room.profile.id, session.agent.name)
      return true
    }
    case 'remove_from_room': {
      const room = requireRoom(ws, system, msg.roomName)
      const agent = requireAgent(ws, system, msg.agentName)
      if (room && agent) system.removeAgentFromRoom(agent.id, room.profile.id, session.agent.name)
      return true
    }
    case 'set_delivery_mode': {
      const room = requireRoom(ws, system, msg.roomName)
      if (!room) return true
      room.setDeliveryMode(msg.mode)
      return true
    }
    case 'set_paused': {
      const room = requireRoom(ws, system, msg.roomName)
      if (!room) return true
      room.setPaused(msg.paused)
      broadcast({ type: 'delivery_mode_changed', roomName: room.profile.name, mode: room.deliveryMode, paused: room.paused })
      return true
    }
    case 'set_muted': {
      const room = requireRoom(ws, system, msg.roomName)
      const agent = requireAgent(ws, system, msg.agentName)
      if (!room || !agent) return true
      room.setMuted(agent.id, msg.muted)
      broadcast({ type: 'mute_changed', roomName: room.profile.name, agentName: agent.name, muted: msg.muted })
      return true
    }
    default:
      return false
  }
}
