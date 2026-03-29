import type { WSInbound } from '../../core/types.ts'
import { requireRoom, sendError, type CommandContext } from './types.ts'

export const handleTodoCommand = (msg: WSInbound, ctx: CommandContext): boolean => {
  const { ws, session, system } = ctx

  switch (msg.type) {
    case 'add_todo': {
      const room = requireRoom(ws, system, msg.roomName)
      if (!room) return true
      const todo = room.addTodo({
        content: msg.content,
        assignee: msg.assignee,
        assigneeId: msg.assigneeId,
        dependencies: msg.dependencies,
        createdBy: session.agent.name,
      })
      ctx.wsManager.broadcast({ type: 'todo_changed', roomName: room.profile.name, action: 'added', todo })
      return true
    }
    case 'update_todo': {
      const room = requireRoom(ws, system, msg.roomName)
      if (!room) return true
      const updates: Record<string, unknown> = {}
      if (msg.status) updates.status = msg.status
      if (msg.assignee) updates.assignee = msg.assignee
      if (msg.assigneeId) updates.assigneeId = msg.assigneeId
      if (msg.content) updates.content = msg.content
      if (msg.result) updates.result = msg.result
      if (Object.keys(updates).length === 0) {
        sendError(ws, 'No fields to update')
        return true
      }
      const updated = room.updateTodo(msg.todoId, updates as Parameters<typeof room.updateTodo>[1])
      if (updated) {
        ctx.wsManager.broadcast({ type: 'todo_changed', roomName: room.profile.name, action: 'updated', todo: updated })
      } else {
        sendError(ws, `Todo "${msg.todoId}" not found`)
      }
      return true
    }
    case 'remove_todo': {
      const room = requireRoom(ws, system, msg.roomName)
      if (!room) return true
      const existingTodos = room.getTodos()
      const todoToRemove = existingTodos.find(t => t.id === msg.todoId)
      const removed = room.removeTodo(msg.todoId)
      if (removed && todoToRemove) {
        ctx.wsManager.broadcast({ type: 'todo_changed', roomName: room.profile.name, action: 'removed', todo: todoToRemove })
      } else {
        sendError(ws, `Todo "${msg.todoId}" not found`)
      }
      return true
    }
    default:
      return false
  }
}
