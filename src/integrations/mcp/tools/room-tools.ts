import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { System } from '../../../main.ts'
import { textResult, errorResult, resolveRoom, resolveAgent } from './helpers.ts'

export const registerRoomTools = (mcpServer: McpServer, system: System): void => {
  mcpServer.tool(
    'create_room',
    'Create a new room for agent communication',
    {
      name: z.string().describe('Room name'),
      roomPrompt: z.string().optional().describe('Instructions for agents in this room'),
    },
    async ({ name, roomPrompt }) => {
      try {
        const result = system.house.createRoomSafe({ name, roomPrompt, createdBy: 'mcp-client' })
        return textResult(result.value.profile)
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to create room')
      }
    },
  )

  mcpServer.tool(
    'list_rooms',
    'List all rooms in the system',
    {},
    async () => textResult(system.house.listAllRooms()),
  )

  mcpServer.tool(
    'get_room',
    'Get room details and recent messages',
    {
      name: z.string().describe('Room name'),
      messageLimit: z.number().default(50).describe('Max messages to return'),
    },
    async ({ name, messageLimit }) => {
      try {
        const room = resolveRoom(system, name)
        return textResult({ profile: room.profile, messages: room.getRecent(messageLimit), deliveryMode: room.deliveryMode })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Room not found')
      }
    },
  )

  mcpServer.tool(
    'delete_room',
    'Delete a room',
    { name: z.string().describe('Room name') },
    async ({ name }) => {
      try {
        const room = resolveRoom(system, name)
        system.removeRoom(room.profile.id)
        return textResult({ removed: true })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to delete room')
      }
    },
  )

  mcpServer.tool(
    'set_room_prompt',
    'Set the room prompt (instructions for agents in this room)',
    {
      roomName: z.string().describe('Room name'),
      roomPrompt: z.string().describe('New room prompt'),
    },
    async ({ roomName, roomPrompt }) => {
      try {
        const room = resolveRoom(system, roomName)
        room.setRoomPrompt(roomPrompt)
        return textResult({ roomPrompt: room.profile.roomPrompt })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to set room prompt')
      }
    },
  )

  mcpServer.tool(
    'add_to_room',
    'Add an agent to a room',
    {
      agentName: z.string().describe('Name of the agent to add'),
      roomName: z.string().describe('Name of the room'),
    },
    async ({ agentName, roomName }) => {
      try {
        const agent = system.team.getAgent(agentName)
        if (!agent) return errorResult(`Agent "${agentName}" not found`)
        const room = system.house.getRoom(roomName)
        if (!room) return errorResult(`Room "${roomName}" not found`)
        await system.addAgentToRoom(agent.id, room.profile.id)
        return textResult({ agentName: agent.name, roomName: room.profile.name })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to add to room')
      }
    },
  )

  mcpServer.tool(
    'remove_from_room',
    'Remove an agent from a room',
    {
      agentName: z.string().describe('Name of the agent to remove'),
      roomName: z.string().describe('Name of the room'),
    },
    async ({ agentName, roomName }) => {
      try {
        const agent = system.team.getAgent(agentName)
        if (!agent) return errorResult(`Agent "${agentName}" not found`)
        const room = system.house.getRoom(roomName)
        if (!room) return errorResult(`Room "${roomName}" not found`)
        system.removeAgentFromRoom(agent.id, room.profile.id)
        return textResult({ agentName: agent.name, roomName: room.profile.name })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to remove from room')
      }
    },
  )

  mcpServer.tool(
    'set_delivery_mode',
    'Set the delivery mode for a room: broadcast (all agents). Use muting to control which agents respond.',
    {
      roomName: z.string().describe('Room name'),
      mode: z.enum(['broadcast']).describe('Delivery mode'),
    },
    async ({ roomName, mode }) => {
      try {
        const room = resolveRoom(system, roomName)
        room.setDeliveryMode(mode)
        return textResult({ mode: room.deliveryMode })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to set delivery mode')
      }
    },
  )

  mcpServer.tool(
    'set_paused',
    'Pause or resume a room. Paused rooms store messages but do not deliver them.',
    {
      roomName: z.string().describe('Room name'),
      paused: z.boolean().describe('True to pause, false to resume'),
    },
    async ({ roomName, paused }) => {
      try {
        const room = resolveRoom(system, roomName)
        room.setPaused(paused)
        return textResult({ paused: room.paused })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to set paused')
      }
    },
  )

  mcpServer.tool(
    'set_muted',
    'Mute or unmute an agent in a room. Muted agents are excluded from all delivery.',
    {
      roomName: z.string().describe('Room name'),
      agentName: z.string().describe('Agent name'),
      muted: z.boolean().describe('True to mute, false to unmute'),
    },
    async ({ roomName, agentName, muted }) => {
      try {
        const room = resolveRoom(system, roomName)
        const agent = resolveAgent(system, agentName)
        room.setMuted(agent.id, muted)
        return textResult({ muted: room.isMuted(agent.id) })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to set mute')
      }
    },
  )
}
