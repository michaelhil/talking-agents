import type { House, RoomConfig } from '../../core/types/room.ts'
import type { Team } from '../../core/types/agent.ts'
import type { Tool, ToolContext } from '../../core/types/tool.ts'

type AddToRoomFn = (agentId: string, roomId: string, invitedBy?: string) => Promise<void>
type RemoveFromRoomFn = (agentId: string, roomId: string, removedBy?: string) => void
type RemoveRoomFn = (roomId: string) => boolean

export const createListRoomsTool = (house: House): Tool => ({
  name: 'list_rooms',
  description: 'Lists all rooms with their names.',
  usage: 'Use to discover available rooms before joining, posting to, or routing messages. Check here first when you need to know which rooms exist.',
  returns: 'Array of room name strings.',
  parameters: {},
  execute: async () => ({
    success: true,
    data: house.listAllRooms().map(r => ({ name: r.name })),
  }),
})

export const createCreateRoomTool = (house: House, addAgentToRoom: AddToRoomFn): Tool => ({
  name: 'create_room',
  description: 'Creates a new room and automatically adds the calling agent to it.',
  usage: 'Set up a workspace. The calling agent is added automatically. Optional roomPrompt sets purpose/constraints.',
  returns: 'Object with "name" (assigned, may differ if conflict), "id", and "renamed" (true if the name was adjusted).',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Name for the new room' },
      roomPrompt: { type: 'string', description: 'Optional system prompt for the room' },
    },
    required: ['name'],
  },
  execute: async (params: Record<string, unknown>, context: ToolContext) => {
    const name = params.name as string | undefined
    if (!name) return { success: false, error: 'name is required' }
    try {
      const config: RoomConfig = {
        name,
        roomPrompt: params.roomPrompt as string | undefined,
        createdBy: context.callerId,
      }
      const result = house.createRoomSafe(config)
      await addAgentToRoom(context.callerId, result.value.profile.id)
      return {
        success: true,
        data: { name: result.assignedName, id: result.value.profile.id, renamed: result.assignedName !== result.requestedName },
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Failed to create room' }
    }
  },
})

export const createDeleteRoomTool = (removeRoom: RemoveRoomFn, house: House): Tool => ({
  name: 'delete_room',
  description: 'Permanently deletes a room and all its messages.',
  usage: 'Use only to remove rooms that are fully finished and no longer needed. This is irreversible — all messages are lost. Prefer leaving a room over deleting it if unsure.',
  returns: 'Confirmation with the name of the removed room.',
  parameters: {
    type: 'object',
    properties: {
      roomName: { type: 'string', description: 'Name of the room to delete' },
    },
    required: ['roomName'],
  },
  execute: async (params: Record<string, unknown>) => {
    const roomName = params.roomName as string | undefined
    if (!roomName) return { success: false, error: 'roomName is required' }
    const room = house.getRoom(roomName)
    if (!room) return { success: false, error: `Room "${roomName}" not found` }
    removeRoom(room.profile.id)
    return { success: true, data: { removed: roomName } }
  },
})

export const createSetRoomPromptTool = (house: House): Tool => ({
  name: 'set_room_prompt',
  description: 'Sets or updates the system prompt for a room, which is injected into the context of all agents in that room.',
  usage: 'Use to define or update the purpose and rules for a room. All agents in the room will receive this in their context.',
  returns: '{ roomName, prompt }.',
  parameters: {
    type: 'object',
    properties: {
      roomName: { type: 'string', description: 'Name of the room to update' },
      prompt: { type: 'string', description: 'The new room prompt text' },
    },
    required: ['roomName', 'prompt'],
  },
  execute: async (params: Record<string, unknown>) => {
    const roomName = params.roomName as string | undefined
    const prompt = params.prompt as string | undefined
    if (!roomName || !prompt) return { success: false, error: 'roomName and prompt are required' }
    const room = house.getRoom(roomName)
    if (!room) return { success: false, error: `Room "${roomName}" not found` }
    room.setRoomPrompt(prompt)
    return { success: true, data: { roomName: room.profile.name, prompt } }
  },
})

export const createPauseRoomTool = (house: House): Tool => ({
  name: 'pause_room',
  description: 'Pauses or unpauses message delivery in a room.',
  usage: 'Use to pause a room temporarily while re-configuring it (adding agents, changing mode), then unpause when ready. Does not affect join/leave messages.',
  returns: '{ roomName, paused }.',
  parameters: {
    type: 'object',
    properties: {
      roomName: { type: 'string', description: 'Name of the room' },
      paused: { type: 'boolean', description: 'true to pause, false to unpause' },
    },
    required: ['roomName', 'paused'],
  },
  execute: async (params: Record<string, unknown>) => {
    const roomName = params.roomName as string | undefined
    if (!roomName) return { success: false, error: 'roomName is required' }
    if (typeof params.paused !== 'boolean') return { success: false, error: 'paused must be a boolean' }
    const room = house.getRoom(roomName)
    if (!room) return { success: false, error: `Room "${roomName}" not found` }
    room.setPaused(params.paused)
    return { success: true, data: { roomName: room.profile.name, paused: params.paused } }
  },
})

export const createSetDeliveryModeTool = (house: House): Tool => ({
  name: 'set_delivery_mode',
  description: 'Sets the delivery mode of a room to broadcast.',
  usage: 'Use to switch a room to broadcast mode so all members receive every message.',
  returns: '{ roomName, mode }.',
  parameters: {
    type: 'object',
    properties: {
      roomName: { type: 'string', description: 'Name of the room to update' },
    },
    required: ['roomName'],
  },
  execute: async (params: Record<string, unknown>) => {
    const roomName = params.roomName as string | undefined
    if (!roomName) return { success: false, error: 'roomName is required' }
    const room = house.getRoom(roomName)
    if (!room) return { success: false, error: `Room "${roomName}" not found` }
    room.setDeliveryMode('broadcast')
    return { success: true, data: { roomName: room.profile.name, mode: 'broadcast' } }
  },
})

export const createAddToRoomTool = (team: Team, house: House, addAgentToRoom: AddToRoomFn): Tool => ({
  name: 'add_to_room',
  description: 'Adds an agent (yourself or another) to a room.',
  usage: 'Use to join a room yourself or invite another agent. Triggers a visible join notification. Use your own name to join a room you are not yet in.',
  returns: 'Confirmation with the agent name and room name.',
  parameters: {
    type: 'object',
    properties: {
      agentName: { type: 'string', description: 'Name of the agent to add (use own name to join)' },
      roomName: { type: 'string', description: 'Name of the room to join' },
    },
    required: ['agentName', 'roomName'],
  },
  execute: async (params: Record<string, unknown>, context: ToolContext) => {
    const agentName = params.agentName as string | undefined
    const roomName = params.roomName as string | undefined
    if (!agentName || !roomName) return { success: false, error: 'agentName and roomName are required' }
    const agent = team.getAgent(agentName)
    if (!agent) return { success: false, error: `Agent "${agentName}" not found` }
    const room = house.getRoom(roomName)
    if (!room) return { success: false, error: `Room "${roomName}" not found` }
    const isSelf = agent.id === context.callerId
    await addAgentToRoom(agent.id, room.profile.id, isSelf ? undefined : context.callerName)
    return { success: true, data: { agentName: agent.name, roomName: room.profile.name } }
  },
})

export const createRemoveFromRoomTool = (team: Team, house: House, removeAgentFromRoom: RemoveFromRoomFn): Tool => ({
  name: 'remove_from_room',
  description: 'Removes an agent (yourself or another) from a room.',
  usage: 'Use to leave a room when your participation is complete, or to remove another agent. Triggers a visible leave notification. You can still re-join later.',
  returns: 'Confirmation with the agent name and room name.',
  parameters: {
    type: 'object',
    properties: {
      agentName: { type: 'string', description: 'Name of the agent to remove (use own name to leave)' },
      roomName: { type: 'string', description: 'Name of the room' },
    },
    required: ['agentName', 'roomName'],
  },
  execute: async (params: Record<string, unknown>, context: ToolContext) => {
    const agentName = params.agentName as string | undefined
    const roomName = params.roomName as string | undefined
    if (!agentName || !roomName) return { success: false, error: 'agentName and roomName are required' }
    const agent = team.getAgent(agentName)
    if (!agent) return { success: false, error: `Agent "${agentName}" not found` }
    const room = house.getRoom(roomName)
    if (!room) return { success: false, error: `Room "${roomName}" not found` }
    const isSelf = agent.id === context.callerId
    removeAgentFromRoom(agent.id, room.profile.id, isSelf ? undefined : context.callerName)
    return { success: true, data: { agentName: agent.name, roomName: room.profile.name } }
  },
})
