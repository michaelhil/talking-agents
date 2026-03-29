import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { System } from '../../../main.ts'
import { textResult, errorResult, resolveRoom } from './helpers.ts'

export const registerMessageTools = (mcpServer: McpServer, system: System): void => {
  mcpServer.tool(
    'post_message',
    'Post a message to a room or send a DM to agents. Use this to inject messages into conversations.',
    {
      content: z.string().describe('Message content'),
      senderId: z.string().default('mcp-client').describe('Sender ID'),
      senderName: z.string().optional().describe('Sender display name'),
      roomNames: z.array(z.string()).optional().describe('Room names to post to'),
      agentNames: z.array(z.string()).optional().describe('Agent names for DMs'),
    },
    async ({ content, senderId, senderName, roomNames, agentNames }) => {
      try {
        const target: Record<string, unknown> = {}
        if (roomNames?.length) target.rooms = roomNames
        if (agentNames?.length) target.agents = agentNames
        const messages = system.routeMessage(target, {
          senderId,
          senderName: senderName ?? senderId,
          content,
          type: 'chat',
        })
        return textResult({ delivered: messages.length, messages })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to post message')
      }
    },
  )

  mcpServer.tool(
    'get_room_messages',
    'Get recent messages from a room',
    {
      roomName: z.string().describe('Room name'),
      limit: z.number().default(50).describe('Max messages to return'),
    },
    async ({ roomName, limit }) => {
      try {
        const room = resolveRoom(system, roomName)
        return textResult(room.getRecent(limit))
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Room not found')
      }
    },
  )

  mcpServer.tool(
    'add_flow',
    'Create a predefined agent sequence (flow) for orchestrated conversations',
    {
      roomName: z.string().describe('Room name'),
      name: z.string().describe('Flow name'),
      steps: z.array(z.object({
        agentName: z.string().describe('Agent name for this step'),
        stepPrompt: z.string().optional().describe('Per-step instructions for this agent'),
      })).describe('Ordered sequence of agent steps'),
      loop: z.boolean().default(false).describe('Whether the flow repeats continuously'),
    },
    async ({ roomName, name, steps, loop }) => {
      try {
        const room = resolveRoom(system, roomName)
        const flow = room.addFlow({ name, steps, loop })
        return textResult(flow)
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to add flow')
      }
    },
  )

  mcpServer.tool(
    'list_flows',
    'List all flows registered in a room',
    { roomName: z.string().describe('Room name') },
    async ({ roomName }) => {
      try {
        const room = resolveRoom(system, roomName)
        return textResult(room.getFlows())
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Room not found')
      }
    },
  )

  mcpServer.tool(
    'start_flow',
    'Start a flow execution. Optionally post a trigger message first.',
    {
      roomName: z.string().describe('Room name'),
      flowId: z.string().describe('Flow ID'),
      content: z.string().optional().describe('Optional trigger message to post before starting'),
      senderId: z.string().default('mcp-client').describe('Sender ID for the trigger message'),
      senderName: z.string().optional().describe('Sender display name for the trigger message'),
    },
    async ({ roomName, flowId, content, senderId, senderName }) => {
      try {
        const room = resolveRoom(system, roomName)
        if (content) {
          room.post({ senderId, senderName: senderName ?? senderId, content, type: 'chat' })
        }
        room.startFlow(flowId)
        return textResult({ started: true, mode: room.deliveryMode })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to start flow')
      }
    },
  )

  mcpServer.tool(
    'cancel_flow',
    'Cancel the currently active flow in a room',
    { roomName: z.string().describe('Room name') },
    async ({ roomName }) => {
      try {
        const room = resolveRoom(system, roomName)
        room.cancelFlow()
        return textResult({ cancelled: true, mode: room.deliveryMode })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to cancel flow')
      }
    },
  )
}
