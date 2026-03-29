import { json, errorResponse, parseBody } from '../http-routes.ts'
import { SYSTEM_SENDER_ID } from '../../core/types.ts'
import type { RouteEntry, RouteContext } from './types.ts'

export const todoRoutes: RouteEntry[] = [
  {
    method: 'GET',
    pattern: /^\/api\/rooms\/([^/]+)\/todos$/,
    handler: (_req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.house.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      return json(room.getTodos())
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/rooms\/([^/]+)\/todos$/,
    handler: async (req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.house.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const body = await parseBody(req)
      if (!body.content || typeof body.content !== 'string') return errorResponse('content is required')
      const todo = room.addTodo({
        content: body.content,
        assignee: body.assignee as string | undefined,
        assigneeId: body.assigneeId as string | undefined,
        dependencies: body.dependencies as ReadonlyArray<string> | undefined,
        createdBy: (body.createdBy as string) ?? SYSTEM_SENDER_ID,
      })
      return json(todo, 201)
    },
  },
  {
    method: 'PUT',
    pattern: /^\/api\/rooms\/([^/]+)\/todos\/([^/]+)$/,
    handler: async (req, match, { system }) => {
      const roomName = decodeURIComponent(match[1]!)
      const todoId = decodeURIComponent(match[2]!)
      const room = system.house.getRoom(roomName)
      if (!room) return errorResponse(`Room "${roomName}" not found`, 404)
      const body = await parseBody(req)
      const updated = room.updateTodo(todoId, {
        status: body.status as Parameters<typeof room.updateTodo>[1]['status'],
        assignee: body.assignee as string | undefined,
        assigneeId: body.assigneeId as string | undefined,
        content: body.content as string | undefined,
        result: body.result as string | undefined,
      })
      if (!updated) return errorResponse(`Todo "${todoId}" not found`, 404)
      return json(updated)
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/rooms\/([^/]+)\/todos\/([^/]+)$/,
    handler: (_req, match, { system }) => {
      const roomName = decodeURIComponent(match[1]!)
      const todoId = decodeURIComponent(match[2]!)
      const room = system.house.getRoom(roomName)
      if (!room) return errorResponse(`Room "${roomName}" not found`, 404)
      const removed = room.removeTodo(todoId)
      if (!removed) return errorResponse(`Todo "${todoId}" not found`, 404)
      return json({ removed: true })
    },
  },
]
