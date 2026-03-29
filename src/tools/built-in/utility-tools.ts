import type { House, Tool, ToolContext } from '../../core/types.ts'
import { resolveRoom } from './resolve.ts'

export const createGetTimeTool = (): Tool => ({
  name: 'get_time',
  description: 'Returns the current date and time in ISO 8601 format.',
  usage: 'Use whenever you need the current date or time. Never guess or estimate the time — always call this tool. Required any time temporal accuracy matters.',
  returns: 'Object with a "time" field containing the ISO 8601 timestamp, e.g. { "time": "2024-01-15T12:30:00.000Z" }.',
  parameters: {},
  execute: async () => ({
    success: true,
    data: { time: new Date().toISOString() },
  }),
})

export const createPostToRoomTool = (house: House): Tool => ({
  name: 'post_to_room',
  description: 'Posts a message to a specific room on behalf of the calling agent.',
  usage: 'Use to send a message to a room you are not currently responding from, such as reporting results back to a coordinator room. Do not use to replace normal response — just write your response instead.',
  returns: '{ messageId, roomName }.',
  parameters: {
    type: 'object',
    properties: {
      roomName: { type: 'string', description: 'Name of the room to post into' },
      content: { type: 'string', description: 'The message content to post' },
    },
    required: ['roomName', 'content'],
  },
  execute: async (params: Record<string, unknown>, context: ToolContext) => {
    const roomName = params.roomName as string | undefined
    const content = params.content as string | undefined
    if (!roomName || !content) return { success: false, error: 'roomName and content are required' }
    const room = house.getRoom(roomName)
    if (!room) return { success: false, error: `Room "${roomName}" not found` }
    const message = room.post({
      senderId: context.callerId,
      senderName: context.callerName,
      content,
      type: 'chat',
    })
    return { success: true, data: { messageId: message.id, roomName: room.profile.name } }
  },
})

export const createGetRoomHistoryTool = (house: House): Tool => ({
  name: 'get_room_history',
  description: 'Returns recent messages from a room.',
  usage: 'Use to catch up on a room you just joined, review past decisions, or give another agent context about a conversation. Omit roomName to use the current room.',
  returns: 'Array of { senderName, content, type, timestamp }.',
  parameters: {
    type: 'object',
    properties: {
      roomName: { type: 'string', description: 'Name of the room (omit to use current room)' },
      limit: { type: 'number', description: 'Number of recent messages to return (default 20, max 100)' },
    },
    required: [],
  },
  execute: async (params: Record<string, unknown>, context: ToolContext) => {
    const room = resolveRoom(house, params, context)
    if (!room) return { success: false, error: 'Room not found — provide roomName or call from a room context' }
    const limit = Math.min(typeof params.limit === 'number' ? params.limit : 20, 100)
    const messages = room.getRecent(limit)
    return {
      success: true,
      data: messages.map(m => ({
        senderName: m.senderName ?? m.senderId,
        content: m.content,
        type: m.type,
        timestamp: m.timestamp,
      })),
    }
  },
})
