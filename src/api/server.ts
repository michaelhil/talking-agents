// ============================================================================
// samsinn — HTTP + WebSocket Server
//
// Thin glue layer. Delegates REST to http-routes.ts, WebSocket to ws-handler.ts.
// Handles Bun.serve setup, static file serving, and WebSocket upgrade.
// ============================================================================

import type { SystemRegistry } from '../core/instances/system-registry.ts'
import type { WSManager } from './ws-handler.ts'
import { DEFAULTS } from '../core/types/constants.ts'
import { authEnabled, isValidSession, sessionFromRequest, validateToken, issueSession, buildSessionCookie, getAuthLimiter } from './auth.ts'
import { handleAPI } from './http-routes.ts'
import { handleWSMessage, type WSData } from './ws-handler.ts'
import {
  INSTANCE_COOKIE,
  buildInstanceCookie, getJoinFromQuery,
  resolveOrMintInstance, isSessionBoundToOtherInstance,
} from './instance-cookie.ts'
import { resolve, normalize } from 'node:path'
import { getCaptureRegistry } from '../core/biometrics/registry.ts'


// === Server Config ===

interface ServerConfig {
  readonly registry: SystemRegistry
  readonly wsManager: WSManager
  readonly port?: number
  readonly uiPath?: string
  // Per-instance reset wired by bootstrap.
  readonly resetInstance: (req: Request) => Promise<import('./routes/types.ts').ResetInstanceResult>
  // Per-instance evict (drop from memory, keep snapshot) — exercises the
  // evict→reload boundary in the deploy gate. Wired by bootstrap.
  readonly evictInstance: (req: Request) => Promise<import('./routes/types.ts').EvictInstanceResult>
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

  // /core/* — UI modules occasionally import shared, browser-safe code from
  // src/core/ (e.g., the canonical render-validator types live in core
  // because the eval loop validates them server-side). The server resolves
  // these to src/core/* and applies the same path-traversal guard. Pure-data
  // modules only — anything pulling in node:* APIs would explode at runtime.
  if (pathname.startsWith('/core/') && pathname.endsWith('.ts')) {
    const corePath = normalize(`${uiPath}/..${pathname}`)
    const coreRoot = normalize(`${uiPath}/../core`)
    if (!corePath.startsWith(coreRoot)) {
      return new Response('Forbidden', { status: 403 })
    }
    const file = Bun.file(corePath)
    if (await file.exists()) {
      const source = await file.text()
      const js = transpiler.transformSync(source)
      return new Response(js, {
        headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' },
      })
    }
  }

  // /biometrics/* — browser-only TypeScript package for webcam-based
  // tracking, lazy-loaded by the biometrics UI extension. Same shape as the
  // /core/ resolver: path-traversal-guarded mapping into src/biometrics/.
  if (pathname.startsWith('/biometrics/') && pathname.endsWith('.ts')) {
    const bioPath = normalize(`${uiPath}/..${pathname}`)
    const bioRoot = normalize(`${uiPath}/../biometrics`)
    if (!bioPath.startsWith(bioRoot)) {
      return new Response('Forbidden', { status: 403 })
    }
    const file = Bun.file(bioPath)
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

  // Biometric: when an agent calls biometrics_stop, the capture registry
  // emits a stop request. Broadcast biometric_capture_stop_requested so any
  // live widget for that captureId releases its MediaStream and renders
  // its terminal summary. UI-initiated stops (widget Stop button, unmount,
  // beforeunload) already come FROM the widget — no rebroadcast needed.
  getCaptureRegistry().onAgentStop((captureId) => {
    wsManager.broadcast({ type: 'biometric_capture_stop_requested', captureId, reason: 'agent' })
  })

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
      //
      // A1: rate-limited per IP via the same auth limiter as POST /api/auth
      // so this URL-param path can't bypass the brute-force throttle.
      // Limit hit returns 429 directly (not 303 to clean URL — the user
      // needs to see the rate-limit message).
      if (authEnabled()) {
        const tokenParam = url.searchParams.get('token')
        if (tokenParam) {
          const remoteAddr = server.requestIP(req)?.address
          const limit = getAuthLimiter().check(remoteAddr)
          if (!limit.ok) {
            const retryS = Math.ceil(limit.retryAfterMs / 1000)
            return sec(new Response(`Too many auth attempts — try again in ${retryS}s`, {
              status: 429,
              headers: { 'Retry-After': String(retryS), 'Content-Type': 'text/plain' },
            }))
          }
          if (validateToken(tokenParam)) {
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
          } else {
            console.warn(`[auth] failed ?token= attempt from ${remoteAddr ?? 'unknown'}`)
          }
        }
      }

      // === ?join=<id> redirect — set cookie + 303 to a clean URL ===
      // Strip the join param and preserve the rest, so a shared link with
      // extra params (?join=abc&room=general) doesn't loop the redirect.
      //
      // F4: refuse joins to ids that don't exist. Without this an attacker-
      // chosen id propagates through the cookie to the next request, which
      // materializes a brand-new instance under their chosen id (an
      // amplification vector for instance-dir spam).
      const joinId = getJoinFromQuery(url)
      if (joinId) {
        if (!(await registry.exists(joinId))) {
          return sec(new Response('Instance not found', { status: 404 }))
        }
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
      // Cookieless requests get a per-visitor id. The cookie is set on the
      // way out; the instance itself is materialized lazily by /ws or an
      // /api/* call from the UI — never by a static GET or a cookieless
      // probe (see F1/F5 below).
      let { instanceId, setCookieValue } = resolveOrMintInstance(req, url)

      // F3: stale-cookie soft-expiry. When the cookie names an id that
      // is neither live in memory nor present on disk (e.g. operator
      // purged the instance dir; idle-evicted + trashed + purged by the
      // janitor), drop the cookie and mint a fresh id. Silent — the user
      // gets a clean session, no error surface. Prevents the
      // resurrection-from-stale-cookie path that re-seeds an instance
      // under a previously-deleted id.
      if (setCookieValue === null && !(await registry.exists(instanceId))) {
        const fresh = resolveOrMintInstance(new Request(req.url, { method: req.method }), url)
        instanceId = fresh.instanceId
        setCookieValue = fresh.setCookieValue
      }

      // F1: static-only paths never need a per-instance system. Serve
      // them before getOrLoad so bots/crawlers/uptime probes that just
      // GET / or /dist.css can't materialize an instance. The cookie is
      // still attached so the next real call (/ws or /api/*) reuses the
      // same id.
      const earlyStatic = await serveStatic(pathname, uiPath, transpiler)
      if (earlyStatic !== null) {
        if (setCookieValue) {
          const headers = new Headers(earlyStatic.headers)
          headers.append('Set-Cookie', setCookieValue)
          return sec(new Response(earlyStatic.body, { status: earlyStatic.status, headers }))
        }
        return sec(earlyStatic)
      }
      // /favicon.ico has no file but bots GET it constantly. 204 with
      // cookie, no instance.
      if (pathname === '/favicon.ico') {
        const headers = new Headers()
        if (setCookieValue) headers.append('Set-Cookie', setCookieValue)
        return sec(new Response(null, { status: 204, headers }))
      }

      // === WebSocket upgrade ===
      // v15+: WS sessions are pure viewers of an instance. No agent binding,
      // no reclaim-by-name, no spawn-on-connect. Each post_message names
      // its actor via senderId; non-content commands fall back to 'system'
      // attribution server-side.
      if (pathname === '/ws') {
        if (authEnabled() && !isValidSession(sessionFromRequest(req))) {
          return sec(new Response('Unauthorized', { status: 401 }))
        }
        const sessionToken = url.searchParams.get('session') ?? crypto.randomUUID()

        // Session token reuse — refuse if the existing session is bound to
        // a different instance (browser cookie was switched).
        if (isSessionBoundToOtherInstance(wsManager.sessions.get(sessionToken), instanceId)) {
          return sec(new Response('Session token belongs to a different instance', { status: 403 }))
        }

        const upgraded = server.upgrade(req, { data: { sessionToken, instanceId } })
        return upgraded ? undefined : sec(new Response('WebSocket upgrade failed', { status: 500 }))
      }

      // === API + static dispatch ===
      // Resolve the system for this cookie (lazy-loads from disk if evicted).
      const system = await registry.getOrLoad(instanceId)
      const remoteAddress = server.requestIP(req)?.address
      const apiResponse = await handleAPI(req, pathname, system, instanceId, {
        broadcast: wsManager.broadcast,
        subscribeAgentState: wsManager.subscribeAgentState,
        unsubscribeAgentState: wsManager.unsubscribeAgentState,
        remoteAddress,
        resetInstance: config.resetInstance,
        evictInstance: config.evictInstance,
        broadcastToInstance: wsManager.broadcastToInstance,
        instances: config.instances,
        diagnostics: config.diagnostics,
      })
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

      // Static was tried before getOrLoad (F1); reaching here means
      // neither a route nor a static file matched.
      return sec(new Response('Not found', { status: 404 }))
    },

    websocket: {
      async open(ws) {
        // Ensure the instance is loaded (lazy materialization on first
        // visit). The session entry is keyed by sessionToken so reconnects
        // and stale-sweep work the same.
        await registry.getOrLoad(ws.data.instanceId)
        const existing = wsManager.sessions.get(ws.data.sessionToken)
        const session = existing ?? { instanceId: ws.data.instanceId, sessionToken: ws.data.sessionToken, lastActivity: Date.now() }
        if (!existing) wsManager.sessions.set(ws.data.sessionToken, session)
        else session.lastActivity = Date.now()
        wsManager.wsConnections.set(ws.data.sessionToken, ws)

        const snap = wsManager.buildSnapshot(ws.data.instanceId, ws.data.sessionToken)
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
        // v15+ WS sessions own no agent. Just drop the connection map
        // entry; sessions can persist briefly for reconnect (sweep cleans
        // them up after SESSION_STALE_MS).
        wsManager.wsConnections.delete(ws.data.sessionToken)
      },
    },
  })

  console.log(`Server listening on http://localhost:${port}`)
  console.log(`WebSocket: ws://localhost:${port}/ws`)
  console.log(`API: http://localhost:${port}/api/rooms`)

  return server
}
