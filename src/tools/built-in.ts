// ============================================================================
// Built-in Tools — shipped with the system for validation and basic utility.
// ============================================================================

import type { AIAgent, AgentProfile, House, RoomConfig, Team, Tool, ToolContext, TodoStatus, TodoItem } from '../core/types.ts'

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

export const createQueryAgentTool = (team: Team): Tool => ({
  name: 'query_agent',
  description: 'Ask another AI agent a direct question and receive their response.',
  usage: 'Use to consult specialists, delegate sub-questions, or get a second opinion. Do not use to query yourself. Prefer this over posting to a room when you need a focused, synchronous answer.',
  returns: 'Object with "agent" (name) and "response" (the agent\'s answer string).',
  parameters: {
    type: 'object',
    properties: {
      agent: { type: 'string', description: 'Name of the agent to query' },
      question: { type: 'string', description: 'The question to ask' },
    },
    required: ['agent', 'question'],
  },
  execute: async (params: Record<string, unknown>, context: ToolContext) => {
    const agentName = params.agent as string | undefined
    const question = params.question as string | undefined

    if (!agentName || !question) {
      return { success: false, error: 'Both "agent" and "question" are required' }
    }

    const target = team.getAgent(agentName)
    if (!target) return { success: false, error: `Agent "${agentName}" not found` }
    if (target.kind !== 'ai') return { success: false, error: `Agent "${agentName}" is not an AI agent` }
    if (target.id === context.callerId) return { success: false, error: 'Cannot query yourself' }

    try {
      const response = await (target as AIAgent).query(question, context.callerId, context.callerName)
      return { success: true, data: { agent: agentName, response } }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Query failed' }
    }
  },
})

const resolveRoom = (house: House, params: Record<string, unknown>, context: ToolContext) => {
  const name = params.roomName as string | undefined
  if (name) return house.getRoom(name)
  if (context.roomId) return house.getRoom(context.roomId)
  return undefined
}

export const createListTodosTool = (house: House): Tool => ({
  name: 'list_todos',
  description: 'Lists all todo items in the current room with their status, assignee, result, and dependencies.',
  usage: 'Use to check task status before starting work, find what is blocked, or review what others are assigned to. Omit roomName to use the current room.',
  returns: 'Array of todo objects: { id, content, status, assignee?, result?, dependencies? }.',
  parameters: {
    type: 'object',
    properties: {
      roomName: { type: 'string', description: 'Name of the room (omit to use current room)' },
    },
    required: [],
  },
  execute: async (params: Record<string, unknown>, context: ToolContext) => {
    const room = resolveRoom(house, params, context)
    if (!room) return { success: false, error: 'Room not found — provide roomName or call from a room context' }
    const todos = room.getTodos()
    return {
      success: true,
      data: todos.map(t => ({
        id: t.id,
        content: t.content,
        status: t.status,
        assignee: t.assignee,
        result: t.result,
        dependencies: t.dependencies,
      })),
    }
  },
})

export const createAddTodoTool = (house: House): Tool => ({
  name: 'add_todo',
  description: 'Adds a new todo item to the current room.',
  usage: 'Use to create tasks for yourself or others, decompose complex work into steps, or track action items that arise during conversation.',
  returns: 'The created todo item: { id, content, status: "pending" }.',
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'What needs to be done' },
      assignee: { type: 'string', description: 'Agent name to assign to (optional)' },
      roomName: { type: 'string', description: 'Name of the room (omit to use current room)' },
    },
    required: ['content'],
  },
  execute: async (params: Record<string, unknown>, context: ToolContext) => {
    const room = resolveRoom(house, params, context)
    if (!room) return { success: false, error: 'Room not found — provide roomName or call from a room context' }
    const todo = room.addTodo({
      content: params.content as string,
      assignee: params.assignee as string | undefined,
      createdBy: context.callerName,
    })
    return { success: true, data: { id: todo.id, content: todo.content, status: todo.status } }
  },
})

export const createUpdateTodoTool = (house: House): Tool => ({
  name: 'update_todo',
  description: 'Updates a todo item\'s status, assignee, content, or result.',
  usage: 'Use to mark a task complete (set status to "completed" and include a result), set it "in_progress" when starting, reassign it, or record a result. Always include a result when completing — it provides context to dependent tasks.',
  returns: 'The updated todo item: { id, content, status, result? }.',
  parameters: {
    type: 'object',
    properties: {
      todoId: { type: 'string', description: 'ID of the todo to update' },
      status: { type: 'string', description: 'New status: pending, in_progress, completed, blocked' },
      assignee: { type: 'string', description: 'Reassign to agent name' },
      result: { type: 'string', description: 'Result/outcome (typically set when completing)' },
      roomName: { type: 'string', description: 'Name of the room (omit to use current room)' },
    },
    required: ['todoId'],
  },
  execute: async (params: Record<string, unknown>, context: ToolContext) => {
    const room = resolveRoom(house, params, context)
    if (!room) return { success: false, error: 'Room not found — provide roomName or call from a room context' }
    const updates: { status?: TodoStatus; assignee?: string; result?: string } = {}
    if (params.status) updates.status = params.status as TodoStatus
    if (params.assignee) updates.assignee = params.assignee as string
    if (params.result) updates.result = params.result as string
    const updated = room.updateTodo(params.todoId as string, updates)
    if (!updated) return { success: false, error: `Todo "${params.todoId}" not found` }
    return { success: true, data: { id: updated.id, content: updated.content, status: updated.status, result: updated.result } }
  },
})

// --- Room management tools ---

type AddToRoomFn = (agentId: string, roomId: string, invitedBy?: string) => Promise<void>
type RemoveFromRoomFn = (agentId: string, roomId: string, removedBy?: string) => void
type RemoveRoomFn = (roomId: string) => boolean

export const createCreateRoomTool = (house: House, addAgentToRoom: AddToRoomFn): Tool => ({
  name: 'create_room',
  description: 'Creates a new room and automatically adds the calling agent to it.',
  usage: 'Use to set up a new workspace for a project, topic, or collaboration. The calling agent is added automatically. Choose a clear, unique name. Optionally provide a roomPrompt to give the room a purpose or constraints.',
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

// --- System visibility and control tools ---

export const createListAgentsTool = (team: Team): Tool => ({
  name: 'list_agents',
  description: 'Lists all agents in the system with their name, kind (ai/human), and model.',
  usage: 'Use to discover who is available before querying, assigning todos, or adding to rooms. Check here before using query_agent or add_to_room.',
  returns: 'Array of agent profiles: { name, kind, model? }.',
  parameters: {},
  execute: async () => ({
    success: true,
    data: team.listAgents().map((a): Pick<AgentProfile, 'name' | 'kind' | 'model'> => ({
      name: a.name,
      kind: a.kind,
      model: 'model' in a ? (a as AgentProfile).model : undefined,
    })),
  }),
})

export const createGetMyContextTool = (team: Team, house: House): Tool => ({
  name: 'get_my_context',
  description: 'Returns your own name, id, kind, and the rooms you are currently in.',
  usage: 'Use to identify yourself, confirm your current room membership, or orient before taking structural actions.',
  returns: '{ name, id, kind, rooms: string[] }.',
  parameters: {},
  execute: async (_params: Record<string, unknown>, context: ToolContext) => {
    const agent = team.getAgent(context.callerId)
    const rooms = house.getRoomsForAgent(context.callerId).map(r => r.profile.name)
    return {
      success: true,
      data: {
        name: context.callerName,
        id: context.callerId,
        kind: agent?.kind ?? 'ai',
        rooms,
      },
    }
  },
})

export const createSetDeliveryModeTool = (house: House): Tool => ({
  name: 'set_delivery_mode',
  description: 'Sets the delivery mode of a room to broadcast.',
  usage: 'Use to switch a room back to broadcast mode after a flow completes, or to ensure all members receive every message.',
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

export const createMuteAgentTool = (team: Team, house: House): Tool => ({
  name: 'mute_agent',
  description: 'Mutes or unmutes an agent in a room, preventing their responses from being delivered.',
  usage: 'Use to silence an agent that is responding inappropriately or too verbosely in a specific room, without removing them. Use sparingly.',
  returns: '{ roomName, agentName, muted }.',
  parameters: {
    type: 'object',
    properties: {
      roomName: { type: 'string', description: 'Name of the room' },
      agentName: { type: 'string', description: 'Name of the agent to mute or unmute' },
      muted: { type: 'boolean', description: 'true to mute, false to unmute' },
    },
    required: ['roomName', 'agentName', 'muted'],
  },
  execute: async (params: Record<string, unknown>) => {
    const roomName = params.roomName as string | undefined
    const agentName = params.agentName as string | undefined
    if (!roomName || !agentName) return { success: false, error: 'roomName and agentName are required' }
    if (typeof params.muted !== 'boolean') return { success: false, error: 'muted must be a boolean' }
    const room = house.getRoom(roomName)
    if (!room) return { success: false, error: `Room "${roomName}" not found` }
    const agent = team.getAgent(agentName)
    if (!agent) return { success: false, error: `Agent "${agentName}" not found` }
    room.setMuted(agent.id, params.muted)
    return { success: true, data: { roomName: room.profile.name, agentName: agent.name, muted: params.muted } }
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


// --- Orchestration tools ---

export const createDelegateTool = (team: Team, house: House): Tool => ({
  name: 'delegate',
  description: 'Assign a task to another AI agent, optionally tracking it as a todo. Waits for the result.',
  usage: 'Use when you need another agent to perform a specific task and you need their result. Creates a visible todo if called from a room context. Prefer this over query_agent for named task assignments — it ties the work to the todo list.',
  returns: '{ agentName, result, todoId? } — todoId is present when a room context was available.',
  parameters: {
    type: 'object',
    properties: {
      agentName: { type: 'string', description: 'Name of the AI agent to assign the task to' },
      task: { type: 'string', description: 'The task description to send to the agent' },
    },
    required: ['agentName', 'task'],
  },
  execute: async (params: Record<string, unknown>, context: ToolContext) => {
    const agentName = params.agentName as string | undefined
    const task = params.task as string | undefined
    if (!agentName || !task) return { success: false, error: 'agentName and task are required' }

    const target = team.getAgent(agentName)
    if (!target) return { success: false, error: `Agent "${agentName}" not found` }
    if (target.kind !== 'ai') return { success: false, error: `Agent "${agentName}" is not an AI agent` }
    if (target.id === context.callerId) return { success: false, error: 'Cannot delegate to yourself' }

    // Create a tracking todo if we have a room context
    let todo: TodoItem | undefined
    if (context.roomId) {
      const room = house.getRoom(context.roomId)
      if (room) {
        todo = room.addTodo({
          content: task,
          assignee: agentName,
          assigneeId: target.id,
          createdBy: context.callerName,
        })
        room.updateTodo(todo.id, { status: 'in_progress' })
      }
    }

    try {
      const result = await (target as AIAgent).query(task, context.callerId, context.callerName)

      // Mark todo complete with the result
      if (todo && context.roomId) {
        const room = house.getRoom(context.roomId)
        room?.updateTodo(todo.id, { status: 'completed', result })
      }

      return {
        success: true,
        data: {
          agentName,
          result,
          ...(todo ? { todoId: todo.id } : {}),
        },
      }
    } catch (err) {
      // Mark todo blocked on failure
      if (todo && context.roomId) {
        const room = house.getRoom(context.roomId)
        room?.updateTodo(todo.id, { status: 'blocked' })
      }
      return { success: false, error: err instanceof Error ? err.message : 'Delegation failed' }
    }
  },
})
