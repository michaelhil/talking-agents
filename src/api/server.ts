// ============================================================================
// samsinn — HTTP + WebSocket Server
//
// Thin glue layer. Delegates REST to http-routes.ts, WebSocket to ws-handler.ts.
// Handles Bun.serve setup, static file serving, and WebSocket upgrade.
// ============================================================================

import type { System } from '../main.ts'
import type { Message } from '../core/types/messaging.ts'
import type { WSOutbound } from '../core/types/ws-protocol.ts'
import { DEFAULTS } from '../core/types/constants.ts'
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

const serveStatic = async (pathname: string, uiPath: string, transpiler: Bun.Transpiler, distReady?: Promise<void>): Promise<Response | null> => {
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
    // If a boot-time build is in flight, wait for it so the first CSS
    // request doesn't race to a 404 → unstyled flash.
    if (distReady) await distReady
    const file = Bun.file(`${uiPath}/dist.css`)
    if (await file.exists()) {
      return new Response(file, { headers: { 'Content-Type': 'text/css', 'Cache-Control': 'no-cache' } })
    }
    return new Response('/* dist.css missing — run `bun run build:css` */', {
      status: 404,
      headers: { 'Content-Type': 'text/css' },
    })
  }

  return null
}

// Build-on-boot: if dist.css is missing, run the Tailwind CLI synchronously
// before accepting connections. On failure, log loudly — a silently missing
// stylesheet produces an unstyled UI with no clue why.
const ensureDistCss = async (uiPath: string): Promise<void> => {
  const out = Bun.file(`${uiPath}/dist.css`)
  if (await out.exists()) return
  console.log('[css] dist.css missing — running one-shot Tailwind build…')
  const t0 = Date.now()
  try {
    const proc = Bun.spawn([
      'bunx', '@tailwindcss/cli',
      '-i', `${uiPath}/input.css`,
      '-o', `${uiPath}/dist.css`,
      '--minify',
    ], { stdout: 'inherit', stderr: 'inherit' })
    const code = await proc.exited
    if (code !== 0) {
      console.error(`[css] ❌ Tailwind build failed (exit ${code}). UI will load unstyled until you run \`bun run build:css\`.`)
      return
    }
    // Re-stat to confirm the file landed (the spawn could exit 0 with no output
    // in pathological cases).
    const after = Bun.file(`${uiPath}/dist.css`)
    const size = (await after.exists()) ? after.size : 0
    console.log(`[css] ✓ built dist.css in ${Date.now() - t0} ms (${size} B)`)
  } catch (err) {
    console.error(`[css] ❌ Could not spawn Tailwind CLI: ${err instanceof Error ? err.message : String(err)}.`)
    console.error(`[css]   Run \`bun install\` to make sure @tailwindcss/cli is available, or pre-build with \`bun run build:css\`.`)
  }
}

// === Server Factory ===

export const createServer = (system: System, config?: ServerConfig) => {
  const port = config?.port ?? DEFAULTS.port
  const uiPath = resolve(config?.uiPath ?? `${import.meta.dir}/../ui`)
  const transpiler = new Bun.Transpiler({ loader: 'ts' })

  // Kick off dist.css build if missing. The Bun.serve setup below is
  // synchronous, so by the time requests arrive this promise is usually
  // resolved; if not, /dist.css returns 404 and the browser retries when
  // the user refreshes. Errors log loudly inside ensureDistCss.
  const distReady = ensureDistCss(uiPath)

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

  system.setOnMacroEvent(withAutoSave((roomId, event, detail) => {
    const room = system.house.getRoom(roomId)
    const roomName = room?.profile.name ?? roomId
    // TS can't narrow the generic event/detail pair at this call site — narrow manually.
    switch (event) {
      case 'started':
        wsManager.broadcast({ type: 'macro_event', roomName, event, detail: detail as { readonly macroId: string; readonly agentName: string } | undefined })
        break
      case 'step':
        wsManager.broadcast({ type: 'macro_event', roomName, event, detail: detail as { readonly macroId: string; readonly stepIndex: number; readonly agentName: string } | undefined })
        break
      case 'completed':
      case 'cancelled':
        wsManager.broadcast({ type: 'macro_event', roomName, event, detail: detail as { readonly macroId: string } | undefined })
        break
    }
  }))

  system.setOnArtifactChanged(withAutoSave((action, artifact) => {
    wsManager.broadcast({ type: 'artifact_changed', action, artifact })
  }))

  system.setOnModeAutoSwitched((roomId, toMode, reason) => {
    const room = system.house.getRoom(roomId)
    wsManager.broadcast({
      type: 'mode_auto_switched',
      roomName: room?.profile.name ?? roomId,
      toMode,
      reason,
    })
  })

  system.setOnMacroSelectionChanged(withAutoSave((roomId, macroArtifactId) => {
    const room = system.house.getRoom(roomId)
    wsManager.broadcast({
      type: 'macro_selection_changed',
      roomName: room?.profile.name ?? roomId,
      macroArtifactId,
    })
  }))

  // Bookmark mutations arrive via REST; the callback only needs to schedule
  // a snapshot save — there is no WS broadcast (single-user admin surface,
  // panel refetches on open).
  system.setOnBookmarksChanged(withAutoSave(() => {}))

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

      // API routes — resolve client IP for endpoints that gate source-serving.
      const remoteAddress = server.requestIP(req)?.address
      const apiResponse = await handleAPI(req, pathname, system, wsManager.broadcast, wsManager.subscribeAgentState, wsManager.unsubscribeAgentState, remoteAddress)
      if (apiResponse) return apiResponse

      // Static files
      const staticResponse = await serveStatic(pathname, uiPath, transpiler, distReady)
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
          // Remove from all rooms to prevent phantom member accumulation
          for (const room of system.house.getRoomsForAgent(session.agent.id)) {
            room.removeMember(session.agent.id)
          }
          wsManager.broadcast({ type: 'agent_removed', agentName: session.agent.name })
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
