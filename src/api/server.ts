// ============================================================================
// samsinn — HTTP + WebSocket Server
//
// Thin glue layer. Delegates REST to http-routes.ts, WebSocket to ws-handler.ts.
// Handles Bun.serve setup, static file serving, and WebSocket upgrade.
// ============================================================================

import type { Message } from '../core/types/messaging.ts'
import type { WSOutbound } from '../core/types/ws-protocol.ts'
import type { SystemRegistry } from '../core/system-registry.ts'
import type { WSManager } from './ws-handler.ts'
import { DEFAULTS } from '../core/types/constants.ts'
import { ensureUniqueName } from '../core/names.ts'
import { authEnabled, isValidSession, sessionFromRequest } from './auth.ts'
import { handleAPI } from './http-routes.ts'
import { handleWSMessage, type WSData } from './ws-handler.ts'
import {
  buildInstanceCookie, resolveInstanceId, generateInstanceId,
  getJoinFromQuery,
} from './instance-cookie.ts'
import { resolve, normalize } from 'node:path'

// Routes that never need a per-instance system. Bypass the cookie
// resolution + Set-Cookie path. The set is explicit; static files under
// /dist (bundled CSS + sourcemap) match a separate prefix.
const PRE_AUTH_INSTANCE_BYPASS: ReadonlySet<string> = new Set([
  '/', '/index.html',
  '/favicon.ico',
  '/api/auth',
  '/api/system/info',
  '/health',
])
const isInstanceBypass = (pathname: string): boolean =>
  PRE_AUTH_INSTANCE_BYPASS.has(pathname) || pathname.startsWith('/dist')

// === Server Config ===

interface ServerConfig {
  readonly registry: SystemRegistry
  readonly wsManager: WSManager
  // Boot instance — used as fallback when a request has no cookie.
  // Phase F generates this once at boot in bootstrap.ts.
  readonly bootInstanceId: string
  readonly port?: number
  readonly uiPath?: string
  // Per-instance reset wired by bootstrap.
  readonly resetInstance?: (req: Request) => Promise<import('./routes/types.ts').ResetInstanceResult>
  // Legacy fallback (still wired in single-tenant path).
  readonly onResetCommit?: () => Promise<{ ok: true } | { ok: false; reason: string }>
}

// === Static file serving (path traversal protected) ===

// Served in place of dist.css when the file is missing. A valid stylesheet
// that paints a loud red banner across the top of the page with instructions
// for the developer to recover. Simpler and more visible than a 404 +
// console warning that nobody reads. `bun run start` chains `build:css`
// before boot, so the user should only see this if they bypassed the
// chained script (e.g. running `bun run src/main.ts` directly) or manually
// deleted dist.css while the server is running.
const MISSING_DIST_BANNER = `/* samsinn: dist.css missing — run "bun install && bun run build:css" */
body::before {
  content: "\u26a0 samsinn: CSS build missing. Run: bun install && bun run build:css";
  position: fixed;
  inset: 0 0 auto 0;
  padding: 10px 16px;
  background: #dc2626;
  color: #ffffff;
  font: 600 13px/1.3 system-ui, -apple-system, sans-serif;
  z-index: 2147483647;
  text-align: center;
}
body { padding-top: 40px; }
`

const serveStatic = async (pathname: string, uiPath: string, transpiler: Bun.Transpiler): Promise<Response | null> => {
  if (pathname === '/' || pathname === '/index.html') {
    const file = Bun.file(`${uiPath}/index.html`)
    if (await file.exists()) {
      return new Response(file, { headers: { 'Content-Type': 'text/html' } })
    }
    return new Response('<h1>samsinn</h1><p>UI coming soon.</p>', {
      headers: { 'Content-Type': 'text/html' },
    })
  }

  if ((pathname.startsWith('/modules/') || pathname.startsWith('/lib/')) && pathname.endsWith('.ts')) {
    const filePath = normalize(`${uiPath}${pathname}`)
    if (!filePath.startsWith(uiPath)) {
      return new Response('Forbidden', { status: 403 })
    }
    const file = Bun.file(filePath)
    if (await file.exists()) {
      const source = await file.text()
      const js = transpiler.transformSync(source)
      return new Response(js, {
        headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' },
      })
    }
  }

  if (pathname === '/dist.css') {
    const file = Bun.file(`${uiPath}/dist.css`)
    if (await file.exists()) {
      return new Response(file, { headers: { 'Content-Type': 'text/css', 'Cache-Control': 'no-cache' } })
    }
    return new Response(MISSING_DIST_BANNER, {
      status: 200,
      headers: { 'Content-Type': 'text/css', 'Cache-Control': 'no-store' },
    })
  }

  return null
}

// === Server Factory ===

export const createServer = (config: ServerConfig) => {
  const { registry, wsManager, bootInstanceId } = config
  const port = config.port ?? DEFAULTS.port
  const uiPath = resolve(config.uiPath ?? `${import.meta.dir}/../ui`)
  const transpiler = new Bun.Transpiler({ loader: 'ts' })

  // Note: per-instance event wiring (broadcasts + autosave) is set up by
  // registry.onSystemCreated. createServer no longer wires anything itself.

  const server = Bun.serve<WSData>({
    port,

    async fetch(req, server) {
      const url = new URL(req.url)
      const pathname = url.pathname

      // === ?join=<id> redirect — set cookie + 303 to a clean URL ===
      // Strip the join param and preserve the rest, so a shared link with
      // extra params (?join=abc&room=general) doesn't loop the redirect.
      const joinId = getJoinFromQuery(url)
      if (joinId) {
        const cleaned = new URL(url)
        cleaned.searchParams.delete('join')
        const target = cleaned.pathname + (cleaned.search || '')
        return new Response(null, {
          status: 303,
          headers: {
            'Location': target,
            'Set-Cookie': buildInstanceCookie(joinId, req),
          },
        })
      }

      // === Resolve which instance this request is for ===
      // Cookieless requests get a fresh per-visitor id (multi-tenant).
      // bootInstanceId stays as a separate concept used by warmup + the
      // headless path; it's not used as a fallback here.
      const resolved = resolveInstanceId(req, url)
      const instanceId = resolved.id ?? generateInstanceId()
      const setCookieValue = resolved.id === null
        ? buildInstanceCookie(instanceId, req)
        : null
      void bootInstanceId   // referenced via config for tests/admin

      // === WebSocket upgrade ===
      if (pathname === '/ws') {
        // Auth gate (deploy mode only). Cookie is set by /api/auth.
        if (authEnabled() && !isValidSession(sessionFromRequest(req))) {
          return new Response('Unauthorized', { status: 401 })
        }
        const name = url.searchParams.get('name')
        if (!name) return new Response('name query parameter required', { status: 400 })

        const sessionToken = url.searchParams.get('session') ?? crypto.randomUUID()

        // Session token reconnect (same browser tab, brief disconnect)
        if (wsManager.sessions.has(sessionToken)) {
          // Cross-instance token-reuse refusal — refuse if the existing
          // session belongs to a different instance.
          const sess = wsManager.sessions.get(sessionToken)!
          if (sess.instanceId !== instanceId) {
            return new Response('Session token belongs to a different instance', { status: 403 })
          }
          const upgraded = server.upgrade(req, { data: { sessionToken, instanceId, reconnect: true } })
          return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 500 })
        }

        // Resolve the per-instance system to scope reclaim + spawn.
        const targetSystem = await registry.getOrLoad(instanceId)

        // Name-based reclaim: find inactive human agent with same name
        const existingAgent = targetSystem.team.listAgents().find(a =>
          a.kind === 'human' && a.name === name && a.inactive,
        )
        if (existingAgent) {
          // Find and reuse the old session for this agent
          let reclaimedToken: string | undefined
          for (const [token, session] of wsManager.sessions) {
            if (session.instanceId !== instanceId) continue
            if (session.agent.id === existingAgent.id) {
              reclaimedToken = token
              break
            }
          }
          const useToken = reclaimedToken ?? sessionToken
          const upgraded = server.upgrade(req, { data: { sessionToken: useToken, instanceId, reconnect: true, name } })
          return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 500 })
        }

        // New connection — fresh agent. Collision check scoped to instance.
        const activeNames = targetSystem.team.listAgents().filter(a => !a.inactive).map(a => a.name)
        const assignedName = activeNames.includes(name) ? ensureUniqueName(name, activeNames) : name

        const upgraded = server.upgrade(req, { data: { sessionToken, instanceId, name: assignedName } })
        return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 500 })
      }

      // === API + static dispatch ===
      // Resolve the system for this cookie (lazy-loads from disk if evicted).
      const system = await registry.getOrLoad(instanceId)
      const remoteAddress = server.requestIP(req)?.address
      const apiResponse = await handleAPI(
        req, pathname, system,
        wsManager.broadcast, wsManager.subscribeAgentState, wsManager.unsubscribeAgentState,
        remoteAddress,
        config.onResetCommit,
        config.resetInstance,
        wsManager.broadcastToInstance,
      )
      if (apiResponse) {
        if (setCookieValue) apiResponse.headers.append('Set-Cookie', setCookieValue)
        return apiResponse
      }

      const staticResponse = await serveStatic(pathname, uiPath, transpiler)
      if (staticResponse) {
        if (setCookieValue && isInstanceBypass(pathname)) {
          // Set-Cookie on the page-load GET so the browser has it before
          // any subsequent XHR / WS upgrade.
          const headers = new Headers(staticResponse.headers)
          headers.append('Set-Cookie', setCookieValue)
          return new Response(staticResponse.body, { status: staticResponse.status, headers })
        }
        return staticResponse
      }

      return new Response('Not found', { status: 404 })
    },

    websocket: {
      async open(ws) {
        if (ws.data.reconnect) {
          const session = wsManager.sessions.get(ws.data.sessionToken)
          if (!session) return
          const newTransport = (msg: Message) => {
            ws.send(JSON.stringify({ type: 'message', message: msg } satisfies WSOutbound))
          }
          session.agent.setTransport(newTransport)
          // Reactivate if was inactive (name-based reclaim)
          if (session.agent.inactive) {
            session.agent.setInactive?.(false)
            wsManager.broadcast({ type: 'agent_joined', agent: {
              id: session.agent.id, name: session.agent.name,
              kind: session.agent.kind,
            }})
          }
          session.lastActivity = Date.now()
          wsManager.wsConnections.set(ws.data.sessionToken, ws)
          ws.send(JSON.stringify(wsManager.buildSnapshot(session.agent.id)))
          return
        }

        const targetSystem = await registry.getOrLoad(ws.data.instanceId)
        const agent = await targetSystem.spawnHumanAgent(
          { name: ws.data.name! },
          (msg: Message) => {
            ws.send(JSON.stringify({ type: 'message', message: msg } satisfies WSOutbound))
          },
        )

        const session = { agent, instanceId: ws.data.instanceId, lastActivity: Date.now() }
        wsManager.sessions.set(ws.data.sessionToken, session)
        wsManager.wsConnections.set(ws.data.sessionToken, ws)

        ws.send(JSON.stringify(wsManager.buildSnapshot(agent.id, ws.data.sessionToken)))
      },

      async message(ws, raw) {
        const session = wsManager.sessions.get(ws.data.sessionToken)
        if (!session) return
        session.lastActivity = Date.now()
        // Resolve the cookie's system (lazy-load if evicted between connect
        // and message). Eviction during an active WS is rare — onSystemEvicted
        // closes the WS — but races are possible and getOrLoad returns the
        // reloaded system safely.
        const targetSystem = await registry.getOrLoad(ws.data.instanceId)
        await handleWSMessage(ws, session, typeof raw === 'string' ? raw : raw.toString(), targetSystem, wsManager)
      },

      close(ws) {
        const session = wsManager.sessions.get(ws.data.sessionToken)
        if (session?.agent.kind === 'human') {
          session.agent.setInactive?.(true)
          // Remove from all rooms to prevent phantom member accumulation —
          // scope to the originating instance.
          // System may have been evicted; if so, skip cleanup (the snapshot
          // captured pre-evict state and lazy reload won't see this human).
          ;(async () => {
            try {
              const sys = await registry.getOrLoad(ws.data.instanceId)
              for (const room of sys.house.getRoomsForAgent(session.agent.id)) {
                room.removeMember(session.agent.id)
              }
              wsManager.broadcastToInstance(ws.data.instanceId, { type: 'agent_removed', agentName: session.agent.name })
            } catch { /* evicted; skip */ }
          })()
        }
        wsManager.wsConnections.delete(ws.data.sessionToken)
        if (session) wsManager.unsubscribeOllamaMetrics(session.agent.id)
      },
    },
  })

  console.log(`Server listening on http://localhost:${port}`)
  console.log(`WebSocket: ws://localhost:${port}/ws?name=YourName`)
  console.log(`API: http://localhost:${port}/api/rooms`)

  return server
}
