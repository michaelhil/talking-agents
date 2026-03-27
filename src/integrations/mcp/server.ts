// ============================================================================
// MCP Server — Exposes the Samsinn System as MCP tools and resources.
//
// Symmetric with client.ts: the client consumes external MCP tools, the server
// exposes Samsinn as MCP tools for external LLMs/agents to orchestrate.
//
// 23 tools mirror the REST API surface. 3 resources provide read-only access.
// Event notifications via logging messages for real-time updates.
//
// Usage:
//   const mcpServer = createMCPServer(system)
//   await startMCPServerStdio(mcpServer)
// ============================================================================

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import type { System } from '../../main.ts'
import type { AIAgent, OnDeliveryModeChanged, OnFlowEvent, OnTodoChanged, OnTurnChanged, TodoStatus } from '../../core/types.ts'

// === Helpers ===

const textResult = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
})

const errorResult = (message: string) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
  isError: true as const,
})

const resolveRoom = (system: System, roomName: string) => {
  const room = system.house.getRoom(roomName)
  if (!room) throw new Error(`Room "${roomName}" not found`)
  return room
}

const resolveAgent = (system: System, agentName: string) => {
  const agent = system.team.getAgent(agentName)
  if (!agent) throw new Error(`Agent "${agentName}" not found`)
  return agent
}

// === Factory ===

export const createMCPServer = (system: System): McpServer => {
  const mcpServer = new McpServer(
    { name: 'samsinn', version: '0.5.5' },
    { capabilities: { resources: {}, tools: {}, logging: {} } },
  )

  // --- Room management tools ---

  mcpServer.tool(
    'create_room',
    'Create a new room for agent communication',
    {
      name: z.string().describe('Room name'),
      roomPrompt: z.string().optional().describe('Instructions for agents in this room'),
      visibility: z.enum(['public', 'private']).default('public').describe('Room visibility'),
    },
    async ({ name, roomPrompt, visibility }) => {
      try {
        const result = system.house.createRoomSafe({ name, roomPrompt, visibility, createdBy: 'mcp-client' })
        return textResult(result.value.profile)
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to create room')
      }
    },
  )

  mcpServer.tool(
    'list_rooms',
    'List all rooms in the system',
    { visibility: z.enum(['public', 'all']).default('all').describe('Filter by visibility') },
    async ({ visibility }) => {
      const rooms = visibility === 'public' ? system.house.listPublicRooms() : system.house.listAllRooms()
      return textResult(rooms)
    },
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
        system.house.removeRoom(room.profile.id)
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

  // --- Agent management tools ---

  mcpServer.tool(
    'create_agent',
    'Create a new AI agent and join it to public rooms',
    {
      name: z.string().describe('Agent name'),
      model: z.string().describe('Ollama model name (e.g. llama3.2, qwen2.5:14b)'),
      systemPrompt: z.string().describe('System prompt defining the agent personality and behavior'),
      temperature: z.number().optional().describe('LLM temperature (0-1)'),
    },
    async ({ name, model, systemPrompt, temperature }) => {
      try {
        const agent = await system.spawnAIAgent({ name, model, systemPrompt, temperature })
        return textResult({ id: agent.id, name: agent.name })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to create agent')
      }
    },
  )

  mcpServer.tool(
    'list_agents',
    'List all agents in the system',
    {},
    async () => {
      const agents = system.team.listAgents().map(a => ({
        id: a.id, name: a.name, kind: a.kind, state: a.state.get(),
      }))
      return textResult(agents)
    },
  )

  mcpServer.tool(
    'get_agent',
    'Get detailed information about a specific agent',
    { name: z.string().describe('Agent name') },
    async ({ name }) => {
      try {
        const agent = resolveAgent(system, name)
        const detail: Record<string, unknown> = {
          id: agent.id, name: agent.name,
          kind: agent.kind, state: agent.state.get(),
          rooms: system.house.getRoomsForAgent(agent.id).map(r => r.profile.name),
        }
        if (agent.kind === 'ai' && 'getSystemPrompt' in agent) {
          detail.systemPrompt = (agent as AIAgent).getSystemPrompt()
        }
        return textResult(detail)
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Agent not found')
      }
    },
  )

  mcpServer.tool(
    'remove_agent',
    'Remove an agent from the system',
    { name: z.string().describe('Agent name') },
    async ({ name }) => {
      try {
        const agent = resolveAgent(system, name)
        system.removeAgent(agent.id)
        return textResult({ removed: true })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to remove agent')
      }
    },
  )

  mcpServer.tool(
    'update_agent_prompt',
    'Update an AI agent system prompt',
    {
      name: z.string().describe('Agent name'),
      systemPrompt: z.string().describe('New system prompt'),
    },
    async ({ name, systemPrompt }) => {
      try {
        const agent = resolveAgent(system, name)
        if (agent.kind !== 'ai' || !('updateSystemPrompt' in agent)) {
          return errorResult('Only AI agents can be updated')
        }
        (agent as AIAgent).updateSystemPrompt(systemPrompt)
        return textResult({ updated: true, name: agent.name })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to update agent')
      }
    },
  )

  // --- Messaging tools ---

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

  // --- Delivery mode tools ---

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
    'Pause or resume a room. Paused rooms store messages but do not deliver them. Set after flow completion or to manually halt conversation.',
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

  // --- Flow management tools ---

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

  // --- Todo management tools ---

  mcpServer.tool(
    'list_todos',
    'List all todo items in a room with their status, assignee, and results',
    { roomName: z.string().describe('Room name') },
    async ({ roomName }) => {
      try {
        const room = resolveRoom(system, roomName)
        return textResult(room.getTodos())
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Room not found')
      }
    },
  )

  mcpServer.tool(
    'add_todo',
    'Add a new todo item to a room',
    {
      roomName: z.string().describe('Room name'),
      content: z.string().describe('What needs to be done'),
      assignee: z.string().optional().describe('Agent name to assign to'),
    },
    async ({ roomName, content, assignee }) => {
      try {
        const room = resolveRoom(system, roomName)
        const todo = room.addTodo({ content, assignee, createdBy: 'mcp-client' })
        return textResult(todo)
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to add todo')
      }
    },
  )

  mcpServer.tool(
    'update_todo',
    'Update a todo item status, assignee, or add a result',
    {
      roomName: z.string().describe('Room name'),
      todoId: z.string().describe('ID of the todo to update'),
      status: z.enum(['pending', 'in_progress', 'completed', 'blocked']).optional().describe('New status'),
      assignee: z.string().optional().describe('Reassign to agent name'),
      result: z.string().optional().describe('Result/outcome (typically set when completing)'),
    },
    async ({ roomName, todoId, status, assignee, result }) => {
      try {
        const room = resolveRoom(system, roomName)
        const updates: { status?: TodoStatus; assignee?: string; result?: string } = {}
        if (status) updates.status = status
        if (assignee) updates.assignee = assignee
        if (result) updates.result = result
        const updated = room.updateTodo(todoId, updates)
        if (!updated) return errorResult(`Todo "${todoId}" not found`)
        return textResult(updated)
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to update todo')
      }
    },
  )

  // --- House prompt tools ---

  mcpServer.tool(
    'get_house_prompts',
    'Get the global house prompt and response format that guide all agents',
    {},
    async () => {
      return textResult({
        housePrompt: system.house.getHousePrompt(),
        responseFormat: system.house.getResponseFormat(),
      })
    },
  )

  mcpServer.tool(
    'set_house_prompts',
    'Update the global house prompt and/or response format',
    {
      housePrompt: z.string().optional().describe('Global behavioral guidance for all agents'),
      responseFormat: z.string().optional().describe('Response format instructions for agents'),
    },
    async ({ housePrompt, responseFormat }) => {
      if (housePrompt !== undefined) system.house.setHousePrompt(housePrompt)
      if (responseFormat !== undefined) system.house.setResponseFormat(responseFormat)
      return textResult({
        housePrompt: system.house.getHousePrompt(),
        responseFormat: system.house.getResponseFormat(),
      })
    },
  )

  // --- Resources ---

  mcpServer.resource(
    'rooms',
    'samsinn://rooms',
    { description: 'List of all rooms in the system', mimeType: 'application/json' },
    async () => ({
      contents: [{
        uri: 'samsinn://rooms',
        mimeType: 'application/json',
        text: JSON.stringify(system.house.listAllRooms(), null, 2),
      }],
    }),
  )

  mcpServer.resource(
    'agents',
    'samsinn://agents',
    { description: 'List of all agents in the system', mimeType: 'application/json' },
    async () => ({
      contents: [{
        uri: 'samsinn://agents',
        mimeType: 'application/json',
        text: JSON.stringify(
          system.team.listAgents().map(a => ({
            id: a.id, name: a.name, kind: a.kind, state: a.state.get(),
          })),
          null, 2,
        ),
      }],
    }),
  )

  mcpServer.resource(
    'room-messages',
    new ResourceTemplate('samsinn://rooms/{name}/messages', { list: undefined }),
    { description: 'Recent messages in a specific room', mimeType: 'application/json' },
    async (uri, { name }) => {
      const room = system.house.getRoom(name as string)
      if (!room) return { contents: [] }
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(room.getRecent(50), null, 2),
        }],
      }
    },
  )

  return mcpServer
}

// === Wire system event callbacks to MCP logging notifications ===

export const wireEventNotifications = (system: System, mcpServer: McpServer): void => {
  const sendNotification = (data: Record<string, unknown>): void => {
    try {
      mcpServer.server.sendLoggingMessage({ level: 'info', data: JSON.stringify(data) })
    } catch { /* client may not support logging */ }
  }

  const onTurnChanged: OnTurnChanged = (roomId, agentId, waitingForHuman) => {
    const room = system.house.getRoom(roomId)
    const agent = agentId ? system.team.getAgent(agentId) : undefined
    sendNotification({ type: 'turn_changed', roomName: room?.profile.name, agentName: agent?.name, waitingForHuman })
  }

  const onDeliveryModeChanged: OnDeliveryModeChanged = (roomId, mode) => {
    const room = system.house.getRoom(roomId)
    sendNotification({ type: 'delivery_mode_changed', roomName: room?.profile.name, mode })
  }

  const onFlowEvent: OnFlowEvent = (roomId, event, detail) => {
    const room = system.house.getRoom(roomId)
    sendNotification({ type: 'flow_event', roomName: room?.profile.name, event, detail })
  }

  const onTodoChanged: OnTodoChanged = (roomId, action, todo) => {
    const room = system.house.getRoom(roomId)
    sendNotification({ type: 'todo_changed', roomName: room?.profile.name, action, todo })
  }

  system.setOnTurnChanged(onTurnChanged)
  system.setOnDeliveryModeChanged(onDeliveryModeChanged)
  system.setOnFlowEvent(onFlowEvent)
  system.setOnTodoChanged(onTodoChanged)
}

// === Start MCP server on stdio ===

export const startMCPServerStdio = async (mcpServer: McpServer): Promise<void> => {
  const transport = new StdioServerTransport()
  await mcpServer.connect(transport)
}
