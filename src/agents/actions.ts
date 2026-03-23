// ============================================================================
// Action Executor — Runs self-management actions from agent responses.
// Each action is validated before execution. Failures are logged, not thrown.
// All joins are awaited to ensure room profiles are ready before messages flow.
// ============================================================================

import type {
  AgentAction,
  House,
  PostAndDeliver,
  Team,
} from '../core/types.ts'
import { DEFAULTS } from '../core/types.ts'
import { makeJoinMetadata } from './shared.ts'

export const executeActions = async (
  actions: ReadonlyArray<AgentAction>,
  agentId: string,
  agentName: string,
  house: House,
  team: Team,
  postAndDeliver: PostAndDeliver,
): Promise<void> => {
  const limit = DEFAULTS.maxAgentActionsPerResponse
  const toExecute = actions.slice(0, limit)

  for (const action of toExecute) {
    try {
      await executeAction(action, agentId, agentName, house, team, postAndDeliver)
    } catch (err) {
      console.error(`[${agentName}] Action ${action.type} failed:`, err)
    }
  }
}

const executeAction = async (
  action: AgentAction,
  agentId: string,
  agentName: string,
  house: House,
  team: Team,
  postAndDeliver: PostAndDeliver,
): Promise<void> => {
  switch (action.type) {
    case 'create_room': {
      const room = house.createRoom({
        name: action.name,
        description: action.description,
        roomPrompt: action.roomPrompt,
        visibility: action.visibility,
        createdBy: agentId,
      })

      const agent = team.get(agentId)
      if (agent) {
        await agent.join(room)
        postAndDeliver(
          { rooms: [room.profile.id] },
          { senderId: agentId, content: `[${agentName}] created this room`, type: 'join', metadata: makeJoinMetadata(agent) },
        )
      }

      if (action.inviteIds) {
        for (const inviteId of action.inviteIds) {
          const invitee = team.get(inviteId)
          if (invitee) {
            await invitee.join(room)
            postAndDeliver(
              { rooms: [room.profile.id] },
              { senderId: inviteId, content: `[${invitee.name}] has joined (invited by [${agentName}])`, type: 'join', metadata: makeJoinMetadata(invitee) },
            )
          }
        }
      }
      break
    }

    case 'join_room': {
      const room = house.getRoom(action.roomId)
      if (!room) {
        console.error(`[${agentName}] Cannot join room ${action.roomId}: not found`)
        return
      }
      if (room.profile.visibility === 'private') {
        const participants = room.getParticipantIds()
        if (!participants.includes(agentId)) {
          console.error(`[${agentName}] Cannot join private room ${room.profile.name}: not invited`)
          return
        }
      }

      const agent = team.get(agentId)
      if (agent) {
        await agent.join(room)
        postAndDeliver(
          { rooms: [room.profile.id] },
          { senderId: agentId, content: `[${agentName}] has joined`, type: 'join', metadata: makeJoinMetadata(agent) },
        )
      }
      break
    }

    case 'invite_to_room': {
      const room = house.getRoom(action.roomId)
      if (!room) {
        console.error(`[${agentName}] Cannot invite to room ${action.roomId}: not found`)
        return
      }

      const participants = room.getParticipantIds()
      if (!participants.includes(agentId)) {
        console.error(`[${agentName}] Cannot invite to room ${room.profile.name}: not a participant`)
        return
      }

      const invitee = team.get(action.participantId)
      if (!invitee) {
        console.error(`[${agentName}] Cannot invite ${action.participantId}: not found`)
        return
      }

      await invitee.join(room)
      postAndDeliver(
        { rooms: [room.profile.id] },
        { senderId: action.participantId, content: `[${invitee.name}] has joined (invited by [${agentName}])`, type: 'join', metadata: makeJoinMetadata(invitee) },
      )
      break
    }
  }
}
