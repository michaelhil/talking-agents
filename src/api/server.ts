// ============================================================================
// samsinn — HTTP + WebSocket Server
//
// Thin glue layer. Delegates REST to http-routes.ts, WebSocket to ws-handler.ts.
// Handles Bun.serve setup, static file serving, and WebSocket upgrade.
// ============================================================================

import type { System } from '../main.ts'
import type { Message, TodoItem, WSOutbound } from '../core/types.ts'
import { DEFAULTS } from '../core/types.ts'
import { ensureUniqueName } from '../core/names.ts'
import { handleAPI } from './http-routes.ts'
import { createWSManager, handleWSMessage, type WSData } from './ws-handler.ts'
import { resolve, normalize } from 'node:path'

// === Server Config ===

interface ServerConfig {
  readonly port?: number
  readonly uiPath?: string
  readonly onAutoSave?: () => void
}

// === Static file serving (path traversal protected) ===

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

  const wsManager = createWSManager(system)

  const triggerAutoSave = config?.onAutoSave ?? (() => {})

  // Wraps a callback to trigger auto-save after it runs
  const withAutoSave = <T extends unknown[]>(fn: (...args: T) => void) =>
    (...args: T): void => { fn(...args); triggerAutoSave() }

  // Wire room event callbacks to WebSocket broadcast
  // All messages posted to any room are broadcast to all WS clients (UI always sees everything)
  system.setOnMessagePosted(withAutoSave((_roomId, message) => {
    wsManager.broadcast({ type: 'message', message })
  }))

  system.setOnTurnChanged((roomId, agentId, waitingForHuman) => {
    const room = system.house.getRoom(roomId)
    const agent = (typeof agentId === 'string') ? system.team.getAgent(agentId) : undefined
    wsManager.broadcast({
      type: 'turn_changed',
      roomName: room?.profile.name ?? roomId,
      agentName: agent?.name,
      waitingForHuman,
    })
  })

  system.setOnDeliveryModeChanged(withAutoSave((roomId, mode) => {
    const room = system.house.getRoom(roomId)
    wsManager.broadcast({
      type: 'delivery_mode_changed',
      roomName: room?.profile.name ?? roomId,
      mode,
      paused: room?.paused ?? false,
    })
  }))

  system.setOnFlowEvent(withAutoSave((roomId, event, detail) => {
    const room = system.house.getRoom(roomId)
    wsManager.broadcast({
      type: 'flow_event',
      roomName: room?.profile.name ?? roomId,
      event,
      detail,
    })
  }))

  system.setOnTodoChanged(withAutoSave((roomId, action, todo) => {
    const room = system.house.getRoom(roomId)
    wsManager.broadcast({
      type: 'todo_changed',
      roomName: room?.profile.name ?? roomId,
      action,
      todo,
    })
  }))

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

        // Session token reconnect (same browser tab, brief disconnect)
        if (wsManager.sessions.has(sessionToken)) {
          const upgraded = server.upgrade(req, { data: { sessionToken, reconnect: true } })
          return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 500 })
        }

        // Name-based reclaim: find inactive human agent with same name
        const existingAgent = system.team.listAgents().find(a =>
          a.kind === 'human' && a.name === name && a.inactive,
        )
        if (existingAgent) {
          // Find and reuse the old session for this agent
          let reclaimedToken: string | undefined
          for (const [token, session] of wsManager.sessions) {
            if (session.agent.id === existingAgent.id) {
              reclaimedToken = token
              break
            }
          }
          const useToken = reclaimedToken ?? sessionToken
          const upgraded = server.upgrade(req, { data: { sessionToken: useToken, reconnect: true, name } })
          return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 500 })
        }

        // New connection — create fresh agent (auto-rename on collision with active agents)
        const activeNames = system.team.listAgents().filter(a => !a.inactive).map(a => a.name)
        const assignedName = activeNames.includes(name) ? ensureUniqueName(name, activeNames) : name

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

        const agent = await system.spawnHumanAgent(
          { name: ws.data.name! },
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
        const session = wsManager.sessions.get(ws.data.sessionToken)
        if (session?.agent.kind === 'human') {
          session.agent.setInactive?.(true)
          wsManager.broadcast({ type: 'agent_removed', agentName: session.agent.name })
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
