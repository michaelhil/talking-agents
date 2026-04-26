import { SETTABLE_DELIVERY_MODES } from '../../core/types/messaging.ts'
import type { SettableDeliveryMode } from '../../core/types/messaging.ts'
import type { WSInbound } from '../../core/types/ws-protocol.ts'
import { requireRoom, requireAgent, sendError, type CommandContext } from './types.ts'
import { asAIAgent } from '../../agents/shared.ts'

export const handleRoomCommand = async (msg: WSInbound, ctx: CommandContext): Promise<boolean> => {
  const { ws, session, system, broadcast, wsManager } = ctx

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
      const room = requireRoom(wsManager, ws, system, msg.roomName)
      const agent = requireAgent(wsManager, ws, system, msg.agentName)
      if (room && agent) await system.addAgentToRoom(agent.id, room.profile.id, session.agent.name)
      return true
    }
    case 'remove_from_room': {
      const room = requireRoom(wsManager, ws, system, msg.roomName)
      const agent = requireAgent(wsManager, ws, system, msg.agentName)
      if (room && agent) system.removeAgentFromRoom(agent.id, room.profile.id, session.agent.name)
      return true
    }
    case 'set_delivery_mode': {
      const room = requireRoom(wsManager, ws, system, msg.roomName)
      if (!room) return true
      if (!SETTABLE_DELIVERY_MODES.includes(msg.mode as SettableDeliveryMode)) {
        sendError(wsManager, ws, `Invalid mode: ${msg.mode}`)
        return true
      }
      room.setDeliveryMode(msg.mode as SettableDeliveryMode)
      broadcast({ type: 'delivery_mode_changed', roomName: room.profile.name, mode: room.deliveryMode, paused: room.paused })
      return true
    }
    case 'set_paused': {
      const room = requireRoom(wsManager, ws, system, msg.roomName)
      if (!room) return true
      room.setPaused(msg.paused)
      broadcast({ type: 'delivery_mode_changed', roomName: room.profile.name, mode: room.deliveryMode, paused: room.paused })
      return true
    }
    case 'set_muted': {
      const room = requireRoom(wsManager, ws, system, msg.roomName)
      const agent = requireAgent(wsManager, ws, system, msg.agentName)
      if (!room || !agent) return true
      room.setMuted(agent.id, msg.muted)
      broadcast({ type: 'mute_changed', roomName: room.profile.name, agentName: agent.name, muted: msg.muted })
      return true
    }
    case 'delete_room': {
      const room = requireRoom(wsManager, ws, system, msg.roomName)
      if (!room) return true
      system.removeRoom(room.profile.id)
      return true
    }
    case 'delete_message': {
      const room = requireRoom(wsManager, ws, system, msg.roomName)
      if (!room) return true
      const deleted = room.deleteMessage(msg.messageId)
      if (deleted) broadcast({ type: 'message_deleted', roomName: room.profile.name, messageId: msg.messageId })
      return true
    }
    case 'clear_messages': {
      const room = requireRoom(wsManager, ws, system, msg.roomName)
      if (!room) return true
      room.clearMessages()
      // Also wipe per-agent memory of this room so AI participants don't
      // retain phantom history of messages the user just cleared.
      for (const agentId of room.getParticipantIds()) {
        const agent = system.team.getAgent(agentId)
        const ai = agent ? asAIAgent(agent) : undefined
        ai?.clearHistory?.(room.profile.id)
      }
      broadcast({ type: 'messages_cleared', roomName: room.profile.name })
      return true
    }
    case 'activate_agent': {
      const room = requireRoom(wsManager, ws, system, msg.roomName)
      const agent = requireAgent(wsManager, ws, system, msg.agentName)
      if (!room || !agent) return true
      const result = system.activateAgentInRoom(agent.id, room.profile.id)
      wsManager.safeSend(ws, JSON.stringify({
        type: 'activation_result',
        roomName: room.profile.name,
        agentName: agent.name,
        ok: result.ok,
        queued: result.queued,
        reason: result.reason,
      }))
      return true
    }
    case 'set_summary_config': {
      const room = requireRoom(wsManager, ws, system, msg.roomName)
      if (!room) return true
      room.setSummaryConfig(msg.config)
      // The onSummaryConfigChanged callback broadcasts summary_config_changed.
      return true
    }
    case 'regenerate_summary': {
      const room = requireRoom(wsManager, ws, system, msg.roomName)
      if (!room) return true
      void system.summaryScheduler.triggerNow(room.profile.id, msg.target)
      return true
    }
    default:
      return false
  }
}
