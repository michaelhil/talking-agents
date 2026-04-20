// ============================================================================
// HTTP Routes — Shared helpers + thin route-table dispatcher.
//
// Pure request→response functions. No WebSocket or server lifecycle concerns.
// All routes delegate to System methods — no business logic here.
//
// Route modules live in routes/: rooms, agents, artifacts, messages, house.
// The dispatcher iterates the route table, matches method+pattern, calls handler.
// ============================================================================

import type { System } from '../main.ts'
import type { WSOutbound } from '../core/types/ws-protocol.ts'
import { houseRoutes } from './routes/house.ts'
import { roomRoutes } from './routes/rooms.ts'
import { artifactRoutes } from './routes/artifacts.ts'
import { agentRoutes } from './routes/agents.ts'
import { messageRoutes } from './routes/messages.ts'
import { ollamaRoutes } from './routes/ollama.ts'
import { providersRoutes } from './routes/providers.ts'
import { systemRoutes } from './routes/system.ts'
import { bookmarkRoutes } from './routes/bookmarks.ts'
import type { RouteContext } from './routes/types.ts'

// === Shared Helpers (exported for use by route modules) ===

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

export const errorResponse = (message: string, status = 400) =>
  json({ error: message }, status)

export const parseBody = async (req: Request): Promise<Record<string, unknown>> => {
  try {
    return (await req.json()) as Record<string, unknown>
  } catch {
    return {}
  }
}

export const extractParam = (pathname: string, pattern: string): string | null => {
  const regex = new RegExp(`^${pattern.replace(':name', '([^/]+)')}$`)
  const match = pathname.match(regex)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

// === Route Table ===
// Order matters: more-specific patterns (e.g. /rooms/:name/todos/:id) before general ones.

const allRoutes = [
  ...houseRoutes,
  ...ollamaRoutes,
  ...providersRoutes,
  ...systemRoutes,
  ...bookmarkRoutes,
  // Artifacts before rooms (avoids /rooms/:name/artifacts being shadowed)
  ...artifactRoutes,
  ...roomRoutes,
  ...agentRoutes,
  ...messageRoutes,
]

// === Dispatcher ===

export const handleAPI = async (
  req: Request,
  pathname: string,
  system: System,
  broadcast: (msg: WSOutbound) => void,
  subscribeAgentState: (agentId: string, agentName: string) => void,
  unsubscribeAgentState?: (agentId: string) => void,
): Promise<Response | null> => {
  const ctx: RouteContext = { system, broadcast, subscribeAgentState, unsubscribeAgentState }

  for (const route of allRoutes) {
    if (route.method !== req.method) continue
    const match = pathname.match(route.pattern)
    if (match) return route.handler(req, match, ctx)
  }

  return null
}
