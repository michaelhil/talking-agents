// ============================================================================
// Talking Agents — HTTP + WebSocket Server
//
// Thin glue layer. Delegates REST to http-routes.ts, WebSocket to ws-handler.ts.
// Handles Bun.serve setup, static file serving, and WebSocket upgrade.
// ============================================================================

import type { System } from '../main.ts'
import type { Message, WSOutbound } from '../core/types.ts'
import { DEFAULTS } from '../core/types.ts'
import { ensureUniqueName } from '../core/names.ts'
import { handleAPI } from './http-routes.ts'
import { createWSManager, handleWSMessage, type WSData } from './ws-handler.ts'
import { resolve, normalize } from 'node:path'

// === Server Config ===

interface ServerConfig {
  readonly port?: number
  readonly uiPath?: string
  readonly sessionTtlMs?: number
}

// === Static file serving (path traversal protected) ===

const serveStatic = async (pathname: string, uiPath: string, transpiler: Bun.Transpiler): Promise<Response | null> => {
  if (pathname === '/' || pathname === '/index.html') {
    const file = Bun.file(`${uiPath}/index.html`)
    if (await file.exists()) {
      return new Response(file, { headers: { 'Content-Type': 'text/html' } })
    }
    return new Response('<h1>Talking Agents</h1><p>UI coming soon.</p>', {
      headers: { 'Content-Type': 'text/html' },
    })
  }

  if (pathname.startsWith('/modules/') && pathname.endsWith('.ts')) {
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

  return null
}

// === Server Factory ===

export const createServer = (system: System, config?: ServerConfig) => {
  const port = config?.port ?? DEFAULTS.port
  const uiPath = resolve(config?.uiPath ?? `${import.meta.dir}/../ui`)
  const transpiler = new Bun.Transpiler({ loader: 'ts' })
  const sessionTtlMs = config?.sessionTtlMs ?? 60 * 60 * 1000

  const wsManager = createWSManager(system, sessionTtlMs)

  const server = Bun.serve<WSData>({
    port,

    async fetch(req, server) {
      const url = new URL(req.url)
      const pathname = url.pathname

      // WebSocket upgrade
      if (pathname === '/ws') {
        const name = url.searchParams.get('name')
        if (!name) return new Response('name query parameter required', { status: 400 })

        const sessionToken = url.searchParams.get('session') ?? crypto.randomUUID()

        if (wsManager.sessions.has(sessionToken)) {
          const upgraded = server.upgrade(req, { data: { sessionToken, reconnect: true } })
          return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 500 })
        }

        const existingNames = [...system.team.listAgents().map(a => a.name)]
        const assignedName = system.team.getAgent(name) ? ensureUniqueName(name, existingNames) : name

        const upgraded = server.upgrade(req, { data: { sessionToken, name: assignedName } })
        return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 500 })
      }

      // API routes
      const apiResponse = await handleAPI(req, pathname, system, wsManager.broadcast, wsManager.subscribeAgentState, wsManager.unsubscribeAgentState)
      if (apiResponse) return apiResponse

      // Static files
      const staticResponse = await serveStatic(pathname, uiPath, transpiler)
      if (staticResponse) return staticResponse

      return new Response('Not found', { status: 404 })
    },

    websocket: {
      async open(ws) {
        if (ws.data.reconnect) {
          const session = wsManager.sessions.get(ws.data.sessionToken)
          if (!session) return
          session.agent.setTransport((msg: Message) => {
            ws.send(JSON.stringify({ type: 'message', message: msg } satisfies WSOutbound))
          })
          session.lastActivity = Date.now()
          wsManager.wsConnections.set(ws.data.sessionToken, ws)
          ws.send(JSON.stringify(wsManager.buildSnapshot(session.agent.id)))
          return
        }

        const agent = await system.spawnHumanAgent(
          { name: ws.data.name!, description: `Human participant: ${ws.data.name}` },
          (msg: Message) => {
            ws.send(JSON.stringify({ type: 'message', message: msg } satisfies WSOutbound))
          },
        )

        const session = { agent, lastActivity: Date.now() }
        wsManager.sessions.set(ws.data.sessionToken, session)
        wsManager.wsConnections.set(ws.data.sessionToken, ws)

        ws.send(JSON.stringify(wsManager.buildSnapshot(agent.id, ws.data.sessionToken)))
      },

      async message(ws, raw) {
        const session = wsManager.sessions.get(ws.data.sessionToken)
        if (!session) return
        session.lastActivity = Date.now()
        await handleWSMessage(ws, session, typeof raw === 'string' ? raw : raw.toString(), system, wsManager)
      },

      close(ws) {
        wsManager.wsConnections.delete(ws.data.sessionToken)
      },
    },
  })

  console.log(`Server listening on http://localhost:${port}`)
  console.log(`WebSocket: ws://localhost:${port}/ws?name=YourName`)
  console.log(`API: http://localhost:${port}/api/rooms`)

  return server
}
