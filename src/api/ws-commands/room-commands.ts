import { SETTABLE_DELIVERY_MODES } from '../../core/types/messaging.ts'
import type { SettableDeliveryMode } from '../../core/types/messaging.ts'
import type { WSInbound } from '../../core/types/ws-protocol.ts'
import { resolveMacroArtifact, isMacroError } from '../../core/macro-artifact.ts'
import { requireRoom, requireAgent, sendError, type CommandContext } from './types.ts'

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
      if (!SETTABLE_DELIVERY_MODES.includes(msg.mode as SettableDeliveryMode)) {
        sendError(ws, `Invalid mode: ${msg.mode}`)
        return true
      }
      room.setDeliveryMode(msg.mode as SettableDeliveryMode)
      broadcast({ type: 'delivery_mode_changed', roomName: room.profile.name, mode: room.deliveryMode, paused: room.paused })
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
    case 'delete_room': {
      const room = requireRoom(ws, system, msg.roomName)
      if (!room) return true
      system.removeRoom(room.profile.id)
      return true
    }
    case 'delete_message': {
      const room = requireRoom(ws, system, msg.roomName)
      if (!room) return true
      const deleted = room.deleteMessage(msg.messageId)
      if (deleted) broadcast({ type: 'message_deleted', roomName: room.profile.name, messageId: msg.messageId })
      return true
    }
    case 'clear_messages': {
      const room = requireRoom(ws, system, msg.roomName)
      if (!room) return true
      room.clearMessages()
      broadcast({ type: 'messages_cleared', roomName: room.profile.name })
      return true
    }
    case 'room_next': {
      const room = requireRoom(ws, system, msg.roomName)
      if (!room) return true

      // Running macro: advance the step.
      if (room.activeMacroRun) {
        const advanced = room.advanceMacroStep()
        ws.send(JSON.stringify({
          type: 'next_result',
          roomName: room.profile.name,
          advanced,
          reason: advanced ? undefined : 'macro-step-had-no-eligible-agent',
        }))
        return true
      }

      // Start a run using the sticky selection.
      const sel = room.selectedMacroId
      if (!sel) {
        sendError(ws, 'Next: no macro selected for this room')
        return true
      }
      const artifact = system.house.artifacts.get(sel)
      if (!artifact || artifact.type !== 'macro') {
        // Defensive: selection stale. Clear it.
        room.setSelectedMacroId(undefined)
        sendError(ws, 'Next: selected macro no longer exists')
        return true
      }
      const macro = resolveMacroArtifact(artifact, system.team, room.profile.roomPrompt)
      if (isMacroError(macro)) {
        sendError(ws, macro.error)
        return true
      }
      room.runMacro(macro)
      ws.send(JSON.stringify({
        type: 'next_result',
        roomName: room.profile.name,
        advanced: true,
      }))
      return true
    }
    case 'select_macro': {
      const room = requireRoom(ws, system, msg.roomName)
      if (!room) return true
      const artifact = system.house.artifacts.get(msg.macroArtifactId)
      if (!artifact) {
        sendError(ws, `Macro artifact "${msg.macroArtifactId}" not found`)
        return true
      }
      if (artifact.type !== 'macro') {
        sendError(ws, `Artifact "${msg.macroArtifactId}" is not a macro`)
        return true
      }
      // Scope check: the artifact must be system-wide or scoped to this room.
      if (artifact.scope.length > 0 && !artifact.scope.includes(room.profile.id)) {
        sendError(ws, `Macro "${artifact.title}" is not available in this room`)
        return true
      }
      room.setSelectedMacroId(artifact.id)
      broadcast({ type: 'macro_selection_changed', roomName: room.profile.name, macroArtifactId: artifact.id })
      return true
    }
    case 'activate_agent': {
      const room = requireRoom(ws, system, msg.roomName)
      const agent = requireAgent(ws, system, msg.agentName)
      if (!room || !agent) return true
      const result = system.activateAgentInRoom(agent.id, room.profile.id)
      ws.send(JSON.stringify({
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
      const room = requireRoom(ws, system, msg.roomName)
      if (!room) return true
      room.setSummaryConfig(msg.config)
      // The onSummaryConfigChanged callback broadcasts summary_config_changed.
      return true
    }
    case 'regenerate_summary': {
      const room = requireRoom(ws, system, msg.roomName)
      if (!room) return true
      void system.summaryScheduler.triggerNow(room.profile.id, msg.target)
      return true
    }
    default:
      return false
  }
}
