// ============================================================================
// Action Executor — Runs self-management actions from agent responses.
// Each action is validated before execution. Failures are logged, not thrown.
//
// Two action types:
//   create_room — creates a room, adds creator, optionally adds other agents
//   add_to_room — adds an agent to a room (self = join, other = invite)
//
// Authorization: private rooms require the requester to already be a member.
// Uses createRoomSafe for auto-rename on name collision.
// ============================================================================

import type {
  AgentAction,
  House,
  RouteMessage,
  Team,
} from '../core/types.ts'
import { DEFAULTS, SYSTEM_SENDER_ID } from '../core/types.ts'
import { makeJoinMetadata } from './shared.ts'

export const executeActions = async (
  actions: ReadonlyArray<AgentAction>,
  agentId: string,
  agentName: string,
  house: House,
  team: Team,
  routeMessage: RouteMessage,
): Promise<void> => {
  const limit = DEFAULTS.maxAgentActionsPerResponse
  const toExecute = actions.slice(0, limit)

  for (const action of toExecute) {
    try {
      await executeAction(action, agentId, agentName, house, team, routeMessage)
    } catch (err) {
      console.error(`[${agentName}] Action ${action.type} failed:`, err)
    }
  }
}

// Add an agent to a room: addMember, join, post join message.
// Shared by create_room, add_to_room, and spawn.ts.
export const addAgentToRoom = async (
  targetId: string,
  targetName: string,
  roomId: string,
  invitedBy: string | undefined,
  team: Team,
  routeMessage: RouteMessage,
  house: House,
): Promise<void> => {
  const target = team.getAgent(targetId)
  if (!target) return

  const room = house.getRoom(roomId)
  if (!room) return

  room.addMember(targetId)
  await target.join(room)

  const content = invitedBy
    ? `[${targetName}] has joined (added by [${invitedBy}])`
    : `[${targetName}] has joined`

  routeMessage(
    { rooms: [roomId] },
    { senderId: targetId, content, type: 'join', metadata: makeJoinMetadata(target) },
  )
}

const executeAction = async (
  action: AgentAction,
  agentId: string,
  agentName: string,
  house: House,
  team: Team,
  routeMessage: RouteMessage,
): Promise<void> => {
  switch (action.type) {
    case 'create_room': {
      const result = house.createRoomSafe({
        name: action.name,
        description: action.description,
        roomPrompt: action.roomPrompt,
        visibility: action.visibility,
        createdBy: agentId,
      })

      const room = result.value

      // Inform agent if name was auto-renamed
      if (result.assignedName !== result.requestedName) {
        const agent = team.getAgent(agentId)
        if (agent) {
          agent.receive({
            id: crypto.randomUUID(),
            senderId: SYSTEM_SENDER_ID,
            content: `Room created as "${result.assignedName}" because "${result.requestedName}" was already taken.`,
            timestamp: Date.now(),
            type: 'system',
            roomId: room.profile.id,
          })
        }
      }

      // Add creator
      await addAgentToRoom(agentId, agentName, room.profile.id, undefined, team, routeMessage, house)

      // Add invited agents
      for (const inviteeName of action.add ?? []) {
        const invitee = team.getAgent(inviteeName)
        if (invitee) {
          await addAgentToRoom(invitee.id, invitee.name, room.profile.id, agentName, team, routeMessage, house)
        } else {
          console.error(`[${agentName}] Cannot add "${inviteeName}" to room: not found`)
        }
      }
      break
    }

    case 'add_to_room': {
      const room = house.getRoom(action.roomName)
      if (!room) {
        console.error(`[${agentName}] Cannot add to room "${action.roomName}": room not found`)
        return
      }

      const target = team.getAgent(action.agentName)
      if (!target) {
        console.error(`[${agentName}] Cannot add "${action.agentName}" to room: agent not found`)
        return
      }

      // Authorization: private rooms require requester to be a member
      if (room.profile.visibility === 'private' && !room.hasMember(agentId)) {
        console.error(`[${agentName}] Cannot add to private room "${action.roomName}": not a member`)
        return
      }

      const isSelf = target.id === agentId
      const invitedBy = isSelf ? undefined : agentName

      await addAgentToRoom(target.id, target.name, room.profile.id, invitedBy, team, routeMessage, house)
      break
    }
  }
}
