// ============================================================================
// Built-in Tools — shipped with the system for validation and basic utility.
// ============================================================================

import type { AIAgent, House, Team, Tool, ToolContext, TodoStatus } from '../core/types.ts'

export const createListRoomsTool = (house: House): Tool => ({
  name: 'list_rooms',
  description: 'Lists all available rooms with their names and visibility.',
  parameters: {},
  execute: async () => ({
    success: true,
    data: house.listAllRooms().map(r => ({ name: r.name, visibility: r.visibility })),
  }),
})

export const createGetTimeTool = (): Tool => ({
  name: 'get_time',
  description: 'Returns the current date and time in ISO format.',
  parameters: {},
  execute: async () => ({
    success: true,
    data: { time: new Date().toISOString() },
  }),
})

export const createQueryAgentTool = (team: Team): Tool => ({
  name: 'query_agent',
  description: 'Ask another AI agent a question and get their response. Use this to consult with specialists.',
  parameters: {
    agent: 'string — name of the agent to query',
    question: 'string — the question to ask',
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

export const createListTodosTool = (house: House): Tool => ({
  name: 'list_todos',
  description: 'Lists all todo items in a room with their status, assignee, and results.',
  parameters: {
    type: 'object',
    properties: {
      roomName: { type: 'string', description: 'Name of the room' },
    },
    required: ['roomName'],
  },
  execute: async (params: Record<string, unknown>) => {
    const room = house.getRoom(params.roomName as string)
    if (!room) return { success: false, error: `Room "${params.roomName}" not found` }
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
  description: 'Adds a new todo item to a room.',
  parameters: {
    type: 'object',
    properties: {
      roomName: { type: 'string', description: 'Name of the room' },
      content: { type: 'string', description: 'What needs to be done' },
      assignee: { type: 'string', description: 'Agent name to assign to (optional)' },
    },
    required: ['roomName', 'content'],
  },
  execute: async (params: Record<string, unknown>, context: ToolContext) => {
    const room = house.getRoom(params.roomName as string)
    if (!room) return { success: false, error: `Room "${params.roomName}" not found` }
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
  description: 'Updates a todo item status, assignee, or adds a result.',
  parameters: {
    type: 'object',
    properties: {
      roomName: { type: 'string', description: 'Name of the room' },
      todoId: { type: 'string', description: 'ID of the todo to update' },
      status: { type: 'string', description: 'New status: pending, in_progress, completed, blocked' },
      assignee: { type: 'string', description: 'Reassign to agent name' },
      result: { type: 'string', description: 'Result/outcome (typically set when completing)' },
    },
    required: ['roomName', 'todoId'],
  },
  execute: async (params: Record<string, unknown>) => {
    const room = house.getRoom(params.roomName as string)
    if (!room) return { success: false, error: `Room "${params.roomName}" not found` }
    const updates: { status?: TodoStatus; assignee?: string; result?: string } = {}
    if (params.status) updates.status = params.status as TodoStatus
    if (params.assignee) updates.assignee = params.assignee as string
    if (params.result) updates.result = params.result as string
    const updated = room.updateTodo(params.todoId as string, updates)
    if (!updated) return { success: false, error: `Todo "${params.todoId}" not found` }
    return { success: true, data: { id: updated.id, content: updated.content, status: updated.status, result: updated.result } }
  },
})
