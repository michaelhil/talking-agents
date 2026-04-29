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
import { authEnabled, isValidSession, sessionFromRequest } from './auth.ts'
import { houseRoutes } from './routes/house.ts'
import { roomRoutes } from './routes/rooms.ts'
import { artifactRoutes } from './routes/artifacts.ts'
import { agentRoutes } from './routes/agents.ts'
import { messageRoutes } from './routes/messages.ts'
import { ollamaRoutes } from './routes/ollama.ts'
import { providersRoutes } from './routes/providers.ts'
import { wikisRoutes } from './routes/wikis.ts'
import { packsRoutes } from './routes/packs.ts'
import { systemRoutes } from './routes/system.ts'
import { instanceRoutes } from './routes/instances.ts'
import { bugRoutes } from './routes/bugs.ts'
import { bookmarkRoutes } from './routes/bookmarks.ts'
import { toolRoutes } from './routes/tools.ts'
import { loggingRoutes } from './routes/logging.ts'
import { scriptRoutes } from './routes/scripts.ts'
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
  // Wiki routes BEFORE roomRoutes so /api/rooms/:name/wikis matches first.
  ...wikisRoutes,
  ...packsRoutes,
  ...systemRoutes,
  ...instanceRoutes,
  ...bugRoutes,
  ...loggingRoutes,
  ...bookmarkRoutes,
  // Scripts before rooms (avoids /rooms/:name/script being shadowed)
  ...scriptRoutes,
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
  instanceId: string,
  broadcast: (msg: WSOutbound) => void,
  subscribeAgentState: RouteContext['subscribeAgentState'],
  unsubscribeAgentState?: (agentId: string) => void,
  remoteAddress?: string,
  resetInstance?: RouteContext['resetInstance'],
  broadcastToInstance?: RouteContext['broadcastToInstance'],
  instances?: RouteContext['instances'],
  diagnostics?: RouteContext['diagnostics'],
): Promise<Response | null> => {
  const ctx: RouteContext = {
    system, instanceId, broadcast, subscribeAgentState, unsubscribeAgentState,
    remoteAddress, resetInstance, broadcastToInstance, instances, diagnostics,
  }

  // Auth gate. Scoped to /api/* so static paths (/, /index.html, /dist.css,
  // /favicon.ico) can load and the UI can boot to show the token prompt.
  // Without this scope, the gate ran on every path (returning null fell
  // through to serveStatic, but a 401 short-circuited the chain), so the
  // root page returned "Unauthorized" plain text and invitees never saw
  // the prompt.
  // /api/auth itself is exempt so the UI can submit the token.
  // /api/system/info is exempt so the version banner can render at the
  // token-prompt screen without a session.
  if (
    authEnabled() &&
    pathname.startsWith('/api/') &&
    pathname !== '/api/auth' &&
    pathname !== '/api/system/info'
  ) {
    if (!isValidSession(sessionFromRequest(req))) {
      return new Response('Unauthorized', { status: 401 })
    }
  }

  for (const route of allRoutes) {
    if (route.method !== req.method) continue
    const match = pathname.match(route.pattern)
    if (match) return route.handler(req, match, ctx)
  }

  return null
}
