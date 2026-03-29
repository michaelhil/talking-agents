import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { System } from '../../../main.ts'
import type { TodoStatus } from '../../../core/types.ts'
import { textResult, errorResult, resolveRoom } from './helpers.ts'

export const registerTodoTools = (mcpServer: McpServer, system: System): void => {
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
}
