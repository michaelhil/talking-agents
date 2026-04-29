// ============================================================================
// samsinn — HTTP + WebSocket Server
//
// Thin glue layer. Delegates REST to http-routes.ts, WebSocket to ws-handler.ts.
// Handles Bun.serve setup, static file serving, and WebSocket upgrade.
// ============================================================================

import type { Message } from '../core/types/messaging.ts'
import type { HumanAgent } from '../agents/human-agent.ts'
import type { WSOutbound } from '../core/types/ws-protocol.ts'
import type { SystemRegistry } from '../core/system-registry.ts'
import type { WSManager } from './ws-handler.ts'
import { DEFAULTS } from '../core/types/constants.ts'
import { ensureUniqueName } from '../core/names.ts'
import { authEnabled, isValidSession, sessionFromRequest, validateToken, issueSession, buildSessionCookie } from './auth.ts'
import { handleAPI } from './http-routes.ts'
import { handleWSMessage, type WSData } from './ws-handler.ts'
import {
  INSTANCE_COOKIE,
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
  readonly port?: number
  readonly uiPath?: string
  // Per-instance reset wired by bootstrap.
  readonly resetInstance: (req: Request) => Promise<import('./routes/types.ts').ResetInstanceResult>
  // Instances admin (list / create / switch / delete) wired by bootstrap.
  readonly instances: import('./routes/types.ts').InstanceAdmin
  // Read-only diagnostics snapshot (per-instance broadcast wiring health).
  readonly diagnostics: import('./routes/types.ts').DiagnosticsCapability
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

// Security headers applied to every HTTP response. CSP intentionally
// absent — that's set by Caddy in deploy/Caddyfile; duplicating it here
// would diverge. These three are cheap defaults that close the worst
// gaps if Bun is ever reached without the reverse proxy in front.
const applySecurityHeaders = (res: Response): Response => {
  res.headers.set('X-Content-Type-Options', 'nosniff')
  res.headers.set('X-Frame-Options', 'DENY')
  if (!res.headers.has('Referrer-Policy')) {
    res.headers.set('Referrer-Policy', 'same-origin')
  }
  return res
}

// === Server Factory ===

export const createServer = (config: ServerConfig) => {
  const { registry, wsManager } = config
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
      // Local alias so the wrap is one short call per return site.
      // WS upgrade returns undefined, so those paths skip wrapping.
      const sec = applySecurityHeaders

      // === ?token=<X> redirect — single-click sandbox onboarding ===
      // Lets the operator share `https://host/?token=ABC` with invitees;
      // server validates, issues a session cookie, and 303s to a clean URL.
      // Wrong / unset tokens fall through to the normal flow (UI shows the
      // token prompt) so an outdated link doesn't lock anyone out.
      if (authEnabled()) {
        const tokenParam = url.searchParams.get('token')
        if (tokenParam && validateToken(tokenParam)) {
          const sessionId = issueSession()
          const cleaned = new URL(url)
          cleaned.searchParams.delete('token')
          const target = cleaned.pathname + (cleaned.search || '')
          return sec(new Response(null, {
            status: 303,
            headers: {
              'Location': target,
              'Set-Cookie': buildSessionCookie(sessionId),
            },
          }))
        }
      }

      // === ?join=<id> redirect — set cookie + 303 to a clean URL ===
      // Strip the join param and preserve the rest, so a shared link with
      // extra params (?join=abc&room=general) doesn't loop the redirect.
      const joinId = getJoinFromQuery(url)
      if (joinId) {
        const cleaned = new URL(url)
        cleaned.searchParams.delete('join')
        const target = cleaned.pathname + (cleaned.search || '')
        return sec(new Response(null, {
          status: 303,
          headers: {
            'Location': target,
            'Set-Cookie': buildInstanceCookie(joinId, req),
          },
        }))
      }

      // === Resolve which instance this request is for ===
      // Cookieless requests get a fresh per-visitor id (multi-tenant).
      const resolved = resolveInstanceId(req, url)
      const instanceId = resolved.id ?? generateInstanceId()
      const setCookieValue = resolved.id === null
        ? buildInstanceCookie(instanceId, req)
        : null

      // === WebSocket upgrade ===
      if (pathname === '/ws') {
        // Auth gate (deploy mode only). Cookie is set by /api/auth.
        if (authEnabled() && !isValidSession(sessionFromRequest(req))) {
          return sec(new Response('Unauthorized', { status: 401 }))
        }
        const name = url.searchParams.get('name')
        if (!name) return sec(new Response('name query parameter required', { status: 400 }))

        const sessionToken = url.searchParams.get('session') ?? crypto.randomUUID()

        // Session token reconnect (same browser tab, brief disconnect)
        if (wsManager.sessions.has(sessionToken)) {
          // Cross-instance token-reuse refusal — refuse if the existing
          // session belongs to a different instance.
          const sess = wsManager.sessions.get(sessionToken)!
          if (sess.instanceId !== instanceId) {
            return sec(new Response('Session token belongs to a different instance', { status: 403 }))
          }
          const upgraded = server.upgrade(req, { data: { sessionToken, instanceId, reconnect: true } })
          return upgraded ? undefined : sec(new Response('WebSocket upgrade failed', { status: 500 }))
        }

        // Resolve the per-instance system to scope reclaim + spawn.
        const targetSystem = await registry.getOrLoad(instanceId)

        // Name-based reclaim: find a human with same name. We no longer
        // require `inactive` — the seeded Human (and any persisted human in
        // v15+) is never marked inactive because no prior WS was bound to it.
        // Reclaim regardless; the WS open handler reuses the existing agent
        // and reattaches its transport, replacing any prior one.
        const existingAgent = targetSystem.team.listAgents().find(a =>
          a.kind === 'human' && a.name === name,
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
          return upgraded ? undefined : sec(new Response('WebSocket upgrade failed', { status: 500 }))
        }

        // New connection — fresh agent. Collision check scoped to instance.
        const activeNames = targetSystem.team.listAgents().filter(a => !a.inactive).map(a => a.name)
        const assignedName = activeNames.includes(name) ? ensureUniqueName(name, activeNames) : name

        const upgraded = server.upgrade(req, { data: { sessionToken, instanceId, name: assignedName } })
        return upgraded ? undefined : sec(new Response('WebSocket upgrade failed', { status: 500 }))
      }

      // === API + static dispatch ===
      // Resolve the system for this cookie (lazy-loads from disk if evicted).
      const system = await registry.getOrLoad(instanceId)
      const remoteAddress = server.requestIP(req)?.address
      const apiResponse = await handleAPI(
        req, pathname, system, instanceId,
        wsManager.broadcast, wsManager.subscribeAgentState, wsManager.unsubscribeAgentState,
        remoteAddress,
        config.resetInstance,
        wsManager.broadcastToInstance,
        config.instances,
        config.diagnostics,
      )
      if (apiResponse) {
        // Only append the cookieless-fallback Set-Cookie if the route didn't
        // already set its own samsinn_instance cookie (e.g. /switch). Otherwise
        // the browser would honor whichever appears last, masking the route's
        // intent.
        if (setCookieValue) {
          const existing = apiResponse.headers.getSetCookie?.() ?? []
          const alreadySet = existing.some(c => c.startsWith(`${INSTANCE_COOKIE}=`))
          if (!alreadySet) apiResponse.headers.append('Set-Cookie', setCookieValue)
        }
        return sec(apiResponse)
      }

      const staticResponse = await serveStatic(pathname, uiPath, transpiler)
      if (staticResponse) {
        if (setCookieValue && isInstanceBypass(pathname)) {
          // Set-Cookie on the page-load GET so the browser has it before
          // any subsequent XHR / WS upgrade.
          const headers = new Headers(staticResponse.headers)
          headers.append('Set-Cookie', setCookieValue)
          return sec(new Response(staticResponse.body, { status: staticResponse.status, headers }))
        }
        return sec(staticResponse)
      }

      return sec(new Response('Not found', { status: 404 }))
    },

    websocket: {
      async open(ws) {
        if (ws.data.reconnect) {
          let session = wsManager.sessions.get(ws.data.sessionToken)
          // First WS open after a name-based reclaim: the session map has no
          // entry yet because the upgrade route only sets `reconnect: true`
          // and hands us the reclaim'd name. Look up the existing agent by
          // name in this instance, then build the session here.
          if (!session && ws.data.name) {
            const sys = registry.tryGetLive(ws.data.instanceId)
              ?? await registry.getOrLoad(ws.data.instanceId)
            const existing = sys.team.listAgents().find(a => a.kind === 'human' && a.name === ws.data.name) as HumanAgent | undefined
            if (existing) {
              session = { agent: existing, instanceId: ws.data.instanceId, lastActivity: Date.now() }
              wsManager.sessions.set(ws.data.sessionToken, session)
            }
          }
          if (!session) return
          const newTransport = (msg: Message) => {
            wsManager.safeSend(ws, JSON.stringify({ type: 'message', message: msg } satisfies WSOutbound))
          }
          session.agent.setTransport(newTransport)
          // Reactivate if was inactive (name-based reclaim)
          if (session.agent.inactive) {
            session.agent.setInactive?.(false)
            wsManager.broadcastToInstance(session.instanceId, { type: 'agent_joined', agent: {
              id: session.agent.id, name: session.agent.name,
              kind: session.agent.kind,
            }})
          }
          session.lastActivity = Date.now()
          wsManager.wsConnections.set(ws.data.sessionToken, ws)
          // Custom WS close code 4001 = "instance unavailable" (WS spec
          // reserves 4000–4999 for application use). Client sees onclose
          // with this code and reconnects via the registry's lazy-load path.
          const snap = wsManager.buildSnapshot(session.instanceId, session.agent.id)
          if (!snap) { ws.close(4001, 'instance unavailable'); return }
          wsManager.safeSend(ws, JSON.stringify(snap))
          return
        }

        const targetSystem = await registry.getOrLoad(ws.data.instanceId)
        const agent = await targetSystem.spawnHumanAgent(
          { name: ws.data.name! },
          (msg: Message) => {
            wsManager.safeSend(ws, JSON.stringify({ type: 'message', message: msg } satisfies WSOutbound))
          },
        )

        const session = { agent, instanceId: ws.data.instanceId, lastActivity: Date.now() }
        wsManager.sessions.set(ws.data.sessionToken, session)
        wsManager.wsConnections.set(ws.data.sessionToken, ws)

        const snap = wsManager.buildSnapshot(ws.data.instanceId, agent.id, ws.data.sessionToken)
        if (!snap) { ws.close(4001, 'instance unavailable'); return }
        wsManager.safeSend(ws, JSON.stringify(snap))
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
        // v15+ humans are persistent. Closing the WS does NOT remove the
        // bound human from rooms or mark them inactive — they keep their
        // place and the next viewer (same browser, different tab, or a
        // colleague via /?join=) sees them as members. Legacy "phantom
        // member accumulation" risk is gone: humans are addressable by id,
        // duplicates can be deleted via the agent-list × button.
        if (session?.agent.kind === 'human') {
          session.agent.setInactive?.(true)
        }
        wsManager.wsConnections.delete(ws.data.sessionToken)
      },
    },
  })

  console.log(`Server listening on http://localhost:${port}`)
  console.log(`WebSocket: ws://localhost:${port}/ws?name=YourName`)
  console.log(`API: http://localhost:${port}/api/rooms`)

  return server
}
