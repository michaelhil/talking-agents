// System-wide message bookmarks. Thin wrappers over House; mutations trigger
// the OnBookmarksChanged callback which the server wires to auto-save.

import { json, errorResponse, parseBody } from '../http-routes.ts'
import type { RouteEntry } from './types.ts'

const readContent = (body: Record<string, unknown>): string | null => {
  const raw = body.content
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

export const bookmarkRoutes: RouteEntry[] = [
  {
    method: 'GET',
    pattern: /^\/api\/bookmarks$/,
    handler: (_req, _match, { system }) =>
      json({ bookmarks: system.house.listBookmarks() }),
  },
  {
    method: 'POST',
    pattern: /^\/api\/bookmarks$/,
    handler: async (req, _match, { system }) => {
      const body = await parseBody(req)
      const content = readContent(body)
      if (content === null) return errorResponse('content is required', 400)
      return json({ bookmark: system.house.addBookmark(content) }, 201)
    },
  },
  {
    method: 'PUT',
    pattern: /^\/api\/bookmarks\/([^/]+)$/,
    handler: async (req, match, { system }) => {
      const id = decodeURIComponent(match[1]!)
      const body = await parseBody(req)
      const content = readContent(body)
      if (content === null) return errorResponse('content is required', 400)
      const updated = system.house.updateBookmark(id, content)
      if (!updated) return errorResponse('bookmark not found', 404)
      return json({ bookmark: updated })
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/bookmarks\/([^/]+)$/,
    handler: (_req, match, { system }) => {
      const id = decodeURIComponent(match[1]!)
      const removed = system.house.deleteBookmark(id)
      if (!removed) return errorResponse('bookmark not found', 404)
      return json({ ok: true })
    },
  },
]
