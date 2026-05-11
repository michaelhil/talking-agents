import type { House } from '../../core/types/room.ts'
import type { Tool, ToolContext } from '../../core/types/tool.ts'
import { resolveRoom } from './resolve.ts'

export const createGetTimeTool = (): Tool => ({
  name: 'get_time',
  description: 'Current ISO-8601 timestamp.',
  usage: 'Call when temporal accuracy matters. Do not guess.',
  returns: 'Object with a "time" field containing the ISO 8601 timestamp, e.g. { "time": "2024-01-15T12:30:00.000Z" }.',
  parameters: {},
  execute: async () => ({
    success: true,
    data: { time: new Date().toISOString() },
  }),
})

export const createPostToRoomTool = (house: House): Tool => ({
  name: 'post_to_room',
  description: 'Post a message to a specific room. For replies in the current room, just write your response.',
  usage: 'Send to a room other than the current one (e.g. reporting back to a coordinator). For normal replies, just write your response.',
  returns: '{ messageId, roomName }.',
  parameters: {
    type: 'object',
    properties: {
      roomName: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['roomName', 'content'],
  },
  execute: async (params: Record<string, unknown>, context: ToolContext) => {
    const roomName = params.roomName as string | undefined
    const content = params.content as string | undefined
    if (!roomName || !content) return { success: false, error: 'roomName and content are required' }
    const room = house.getRoom(roomName)
    if (!room) return { success: false, error: `Room "${roomName}" not found` }
    // 'chat' type: agent speaks into the room as itself, visible to all members as a normal message.
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
  description: 'Return recent messages from a room. Omit roomName for the current room.',
  usage: 'Catch up on a room or review past decisions. Omit roomName for current room.',
  returns: 'Array of { senderName, content, type, timestamp }.',
  parameters: {
    type: 'object',
    properties: {
      roomName: { type: 'string' },
      limit: { type: 'number', default: 20, maximum: 100 },
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
