import type { House, Tool, ToolContext, TodoStatus } from '../../core/types.ts'
import { resolveRoom } from './resolve.ts'

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
