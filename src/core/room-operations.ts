// System-level room/membership operations — extracted from main.ts to keep
// createSystem focused on factory wiring. Pure dependency injection: the
// factory closes over team/house/routeMessage and the late-bound callbacks
// it needs, and returns four functions with the original signatures.
//
// Internal cross-reference: systemRemoveAgentFromRoom calls systemRemoveRoom
// when the last member leaves, so the four ops share a closure rather than
// being free functions.

import type { RouteMessage, Team } from './types/agent.ts'
import type { House, OnMembershipChanged } from './types/room.ts'
import type { TriggerScheduler } from './triggers/scheduler.ts'
import { addAgentToRoom, removeAgentFromRoom } from '../agents/actions.ts'
import { asAIAgent } from '../agents/shared.ts'

export interface RoomOperationsDeps {
  readonly team: Team
  readonly house: House
  readonly routeMessage: RouteMessage
  readonly onMembershipChanged: OnMembershipChanged
  readonly triggerScheduler: TriggerScheduler
}

export interface RoomOperations {
  readonly addAgentToRoom: (agentId: string, roomId: string, invitedBy?: string) => Promise<void>
  readonly removeAgentFromRoom: (agentId: string, roomId: string, removedBy?: string) => void
  readonly removeRoom: (roomId: string) => boolean
  readonly cancelGenerationsInRoom: (roomId: string) => void
}

export const createRoomOperations = (deps: RoomOperationsDeps): RoomOperations => {
  const { team, house, routeMessage, onMembershipChanged, triggerScheduler } = deps

  const systemAddAgentToRoom = async (agentId: string, roomId: string, invitedBy?: string): Promise<void> => {
    const agent = team.getAgent(agentId)
    const room = house.getRoom(roomId)
    if (!agent || !room) return
    await addAgentToRoom(agentId, agent.name, roomId, invitedBy, team, routeMessage, house)
    onMembershipChanged(roomId, room.profile.name, agentId, agent.name, 'added')
  }

  const systemRemoveAgentFromRoom = (agentId: string, roomId: string, removedBy?: string): void => {
    const agent = team.getAgent(agentId)
    const room = house.getRoom(roomId)
    if (!agent || !room) return
    removeAgentFromRoom(agentId, agent.name, roomId, removedBy, team, routeMessage, house)
    onMembershipChanged(roomId, room.profile.name, agentId, agent.name, 'removed')
    if (room.getParticipantIds().length === 0) {
      systemRemoveRoom(roomId)
    }
  }

  const systemRemoveRoom = (roomId: string): boolean => {
    const room = house.getRoom(roomId)
    if (!room) return false
    for (const agentId of room.getParticipantIds()) {
      team.getAgent(agentId)?.leave(roomId)
    }
    const removed = house.removeRoom(roomId)
    if (removed) {
      // Clean up artifacts exclusively scoped to the deleted room
      for (const artifact of house.artifacts.list({ scope: roomId })) {
        if (artifact.scope.length === 1 && artifact.scope[0] === roomId) {
          house.artifacts.remove(artifact.id)
        }
      }
      // Cascade-clean triggers pinned to the deleted room. Without this,
      // triggers become orphans — the scheduler skips them silently
      // (room.getRoom returns undefined) but they pile up in storage and
      // confuse the UI.
      for (const agent of team.listAgents()) {
        const triggers = agent.getTriggers?.() ?? []
        for (const t of triggers) {
          if (t.roomId === roomId) agent.deleteTrigger?.(t.id)
        }
      }
      triggerScheduler.invalidate()
    }
    return removed
  }

  // Cancel in-flight AI generation only for agents whose current generation
  // context is this room. Called by the room's onManualModeEntered hook.
  const cancelGenerationsInRoom = (roomId: string): void => {
    const room = house.getRoom(roomId)
    if (!room) return
    for (const id of room.getParticipantIds()) {
      const agent = team.getAgent(id)
      if (!agent || agent.kind !== 'ai') continue
      if (agent.state.getContext() !== roomId) continue
      const ai = asAIAgent(agent)
      ai?.cancelGeneration()
    }
  }

  return {
    addAgentToRoom: systemAddAgentToRoom,
    removeAgentFromRoom: systemRemoveAgentFromRoom,
    removeRoom: systemRemoveRoom,
    cancelGenerationsInRoom,
  }
}
