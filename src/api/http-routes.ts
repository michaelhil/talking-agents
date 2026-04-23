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
import { toolRoutes } from './routes/tools.ts'
import type { RouteContext } from './routes/types.ts'

// Route helpers live in ./routes/helpers.ts to keep http-routes.ts cycle-free.

// === Route Table ===
// Order matters: more-specific patterns (e.g. /rooms/:name/todos/:id) before general ones.

const allRoutes = [
  // Tool routes come before houseRoutes so /api/tools/:name + /api/tools/rescan
  // are matched before any catch-all patterns elsewhere.
  ...toolRoutes,
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
  remoteAddress?: string,
): Promise<Response | null> => {
  const ctx: RouteContext = { system, broadcast, subscribeAgentState, unsubscribeAgentState, remoteAddress }

  for (const route of allRoutes) {
    if (route.method !== req.method) continue
    const match = pathname.match(route.pattern)
    if (match) return route.handler(req, match, ctx)
  }

  return null
}
