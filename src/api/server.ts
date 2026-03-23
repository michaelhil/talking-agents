// ============================================================================
// Talking Agents — HTTP + WebSocket Server
//
// Thin routing layer over System. Every endpoint calls existing System methods.
// No business logic here — the server is just a protocol adapter.
//
// REST: /api/rooms, /api/agents, /api/messages, /health
// WebSocket: real-time message delivery + agent state broadcasting
// Static: serves UI files from src/ui/ with .ts transpilation
// ============================================================================

import type { System } from '../main.ts'
import type { HumanAgent } from '../agents/human-agent.ts'
import type {
  Message,
  MessageTarget,
  StateValue,
  WSInbound,
  WSOutbound,
} from '../core/types.ts'
import { DEFAULTS, SYSTEM_SENDER_ID } from '../core/types.ts'
import { ensureUniqueName } from '../core/names.ts'
import { resolve, normalize } from 'node:path'

// === Types ===

interface ClientSession {
  readonly agent: HumanAgent
  lastActivity: number  // timestamp for TTL cleanup
}

interface ServerConfig {
  readonly port?: number
  readonly uiPath?: string
  readonly sessionTtlMs?: number  // default 1 hour
}

interface WSData {
  sessionToken: string
  name?: string
  reconnect?: boolean
}

// === Helpers ===

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const errorResponse = (message: string, status = 400) =>
  json({ error: message }, status)

const notFound = (what: string) => errorResponse(`${what} not found`, 404)

const parseBody = async (req: Request): Promise<Record<string, unknown>> => {
  try {
    return (await req.json()) as Record<string, unknown>
  } catch {
    return {}
  }
}

const extractParam = (pathname: string, pattern: string): string | null => {
  const regex = new RegExp(`^${pattern.replace(':name', '([^/]+)')}$`)
  const match = pathname.match(regex)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

// === Server Factory ===

export const createServer = (system: System, config?: ServerConfig) => {
  const port = config?.port ?? DEFAULTS.port
  const sessions = new Map<string, ClientSession>()
  const wsConnections = new Map<string, { send: (data: string) => void }>()  // sessionToken → ws
  const transpiler = new Bun.Transpiler({ loader: 'ts' })
  const sessionTtlMs = config?.sessionTtlMs ?? 60 * 60 * 1000  // 1 hour default

  // --- Session cleanup: remove disconnected sessions after TTL ---

  // Session cleanup runs periodically — interval ref kept for potential future clearInterval
  void setInterval(() => {
    const now = Date.now()
    for (const [token, session] of sessions) {
      if (!wsConnections.has(token) && now - session.lastActivity > sessionTtlMs) {
        system.removeAgent(session.agent.id)
        sessions.delete(token)
      }
    }
  }, 60_000)  // check every minute

  // --- Broadcast to all WebSocket clients ---

  const broadcast = (msg: WSOutbound) => {
    const data = JSON.stringify(msg)
    for (const ws of wsConnections.values()) {
      try { ws.send(data) } catch { /* client gone */ }
    }
  }

  // --- Agent state subscriptions (tracked for cleanup) ---

  const stateUnsubs = new Map<string, () => void>()  // agentId → unsubscribe

  const subscribeAgentState = (agentId: string, agentName: string): void => {
    const agent = system.team.getAgent(agentId)
    if (!agent || agent.kind !== 'ai') return
    const unsub = agent.state.subscribe((state: StateValue, _agentId: string, context?: string) => {
      broadcast({ type: 'agent_state', agentName, state, context })
    })
    stateUnsubs.set(agentId, unsub)
  }

  const unsubscribeAgentState = (agentId: string): void => {
    const unsub = stateUnsubs.get(agentId)
    if (unsub) {
      unsub()
      stateUnsubs.delete(agentId)
    }
  }

  // Subscribe to all existing AI agents at startup
  for (const agent of system.team.listAgents()) {
    if (agent.kind === 'ai') subscribeAgentState(agent.id, agent.name)
  }

  // --- Build snapshot for a connecting client ---

  const buildSnapshot = (agentId: string, sessionToken?: string): Record<string, unknown> => ({
    type: 'snapshot',
    rooms: system.house.listAllRooms(),
    agents: system.team.listAgents().map(a => ({
      id: a.id, name: a.name, description: a.description, kind: a.kind,
    })),
    agentId,
    ...(sessionToken ? { sessionToken } : {}),
  })

  // --- REST API Routes ---

  const handleAPI = async (req: Request, pathname: string): Promise<Response | null> => {
    const method = req.method

    // Health
    if (method === 'GET' && pathname === '/health') {
      let ollamaOk = false
      try { await system.ollama.models(); ollamaOk = true } catch { /* offline */ }
      return json({
        status: 'ok', ollama: ollamaOk,
        rooms: system.house.listAllRooms().length,
        agents: system.team.listAgents().length,
      })
    }

    // GET /api/rooms
    if (method === 'GET' && pathname === '/api/rooms') {
      const vis = new URL(req.url).searchParams.get('visibility')
      return json(vis === 'public' ? system.house.listPublicRooms() : system.house.listAllRooms())
    }

    // GET /api/rooms/:name
    if (method === 'GET') {
      const name = extractParam(pathname, '/api/rooms/:name')
      if (name) {
        const room = system.house.getRoom(name)
        if (!room) return notFound(`Room "${name}"`)
        const limit = parseInt(new URL(req.url).searchParams.get('limit') ?? '50', 10)
        return json({ profile: room.profile, messages: room.getRecent(limit) })
      }
    }

    // POST /api/rooms
    if (method === 'POST' && pathname === '/api/rooms') {
      const body = await parseBody(req)
      if (!body.name || typeof body.name !== 'string') return errorResponse('name is required')
      try {
        const result = system.house.createRoomSafe({
          name: body.name,
          description: body.description as string | undefined,
          roomPrompt: body.roomPrompt as string | undefined,
          visibility: (body.visibility as 'public' | 'private') ?? 'public',
          createdBy: (body.createdBy as string) ?? SYSTEM_SENDER_ID,
        })
        broadcast({ type: 'room_created', profile: result.value.profile })
        return json(result, 201)
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : 'Failed to create room')
      }
    }

    // DELETE /api/rooms/:name
    if (method === 'DELETE') {
      const name = extractParam(pathname, '/api/rooms/:name')
      if (name) {
        const room = system.house.getRoom(name)
        if (!room) return notFound(`Room "${name}"`)
        system.house.removeRoom(room.profile.id)
        return json({ removed: true })
      }
    }

    // POST /api/rooms/:name/members
    if (method === 'POST') {
      const name = extractParam(pathname, '/api/rooms/:name/members')
      if (name) {
        const room = system.house.getRoom(name)
        if (!room) return notFound(`Room "${name}"`)
        const body = await parseBody(req)
        const agentName = body.agentName as string | undefined
        if (!agentName) return errorResponse('agentName is required')
        const agent = system.team.getAgent(agentName)
        if (!agent) return notFound(`Agent "${agentName}"`)
        room.addMember(agent.id)
        await agent.join(room)
        return json({ added: true, agentName: agent.name, roomName: room.profile.name })
      }
    }

    // GET /api/agents
    if (method === 'GET' && pathname === '/api/agents') {
      return json(system.team.listAgents().map(a => ({
        id: a.id, name: a.name, description: a.description, kind: a.kind, state: a.state.get(),
      })))
    }

    // GET /api/agents/:name/rooms (must be before GET /api/agents/:name)
    if (method === 'GET') {
      const agentForRooms = extractParam(pathname, '/api/agents/:name/rooms')
      if (agentForRooms) {
        const agent = system.team.getAgent(agentForRooms)
        if (!agent) return notFound(`Agent "${agentForRooms}"`)
        return json(agent.getRoomIds().map(id => system.house.getRoom(id)?.profile).filter(Boolean))
      }

      const agentName = extractParam(pathname, '/api/agents/:name')
      if (agentName) {
        const agent = system.team.getAgent(agentName)
        if (!agent) return notFound(`Agent "${agentName}"`)
        return json({
          id: agent.id, name: agent.name, description: agent.description,
          kind: agent.kind, state: agent.state.get(), rooms: agent.getRoomIds(),
        })
      }
    }

    // POST /api/agents
    if (method === 'POST' && pathname === '/api/agents') {
      const body = await parseBody(req)
      if (!body.name || !body.model || !body.systemPrompt) {
        return errorResponse('name, model, and systemPrompt are required')
      }
      try {
        const agent = await system.spawnAIAgent({
          name: body.name as string,
          description: (body.description as string) ?? '',
          model: body.model as string,
          systemPrompt: body.systemPrompt as string,
          temperature: body.temperature as number | undefined,
          cooldownMs: (body.cooldownMs as number) ?? DEFAULTS.cooldownMs,
          historyLimit: body.historyLimit as number | undefined,
        })
        subscribeAgentState(agent.id, agent.name)
        broadcast({ type: 'agent_joined', agent: { id: agent.id, name: agent.name, description: agent.description, kind: agent.kind } })
        return json({ id: agent.id, name: agent.name }, 201)
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : 'Failed to create agent')
      }
    }

    // DELETE /api/agents/:name
    if (method === 'DELETE') {
      const name = extractParam(pathname, '/api/agents/:name')
      if (name) {
        const agent = system.team.getAgent(name)
        if (!agent) return notFound(`Agent "${name}"`)
        unsubscribeAgentState(agent.id)
        system.removeAgent(agent.id)
        broadcast({ type: 'agent_removed', agentName: name })
        return json({ removed: true })
      }
    }

    // POST /api/messages — unified message posting
    if (method === 'POST' && pathname === '/api/messages') {
      const body = await parseBody(req)
      if (!body.content || !body.senderId) return errorResponse('content and senderId are required')
      const target = (body.target as MessageTarget) ?? {}
      const messages = system.postAndDeliver(target, {
        senderId: body.senderId as string,
        content: body.content as string,
        type: (body.messageType as 'chat') ?? 'chat',
        metadata: body.metadata as Record<string, unknown> | undefined,
      })
      return json(messages, 201)
    }

    return null
  }

  // --- Static file serving (path traversal protected) ---

  const serveStatic = async (pathname: string): Promise<Response | null> => {
    const uiPath = resolve(config?.uiPath ?? `${import.meta.dir}/../ui`)

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
      // Path traversal protection: resolved path must be under uiPath
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

  // --- WebSocket message handler ---

  const handleWSMessage = async (ws: { send: (data: string) => void }, session: ClientSession, raw: string) => {
    let msg: WSInbound
    try {
      msg = JSON.parse(raw) as WSInbound
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' } satisfies WSOutbound))
      return
    }

    try {
      switch (msg.type) {
        case 'post_message': {
          const resolved = msg.target ?? {}
          system.postAndDeliver(resolved, {
            senderId: session.agent.id,
            content: msg.content,
            type: 'chat',
          })
          break
        }
        case 'create_room': {
          const result = system.house.createRoomSafe({
            name: msg.name,
            description: msg.description,
            roomPrompt: msg.roomPrompt,
            visibility: msg.visibility ?? 'public',
            createdBy: session.agent.id,
          })
          result.value.addMember(session.agent.id)
          await session.agent.join(result.value)
          broadcast({ type: 'room_created', profile: result.value.profile })
          break
        }
        case 'add_to_room': {
          const room = system.house.getRoom(msg.roomName)
          const agent = system.team.getAgent(msg.agentName)
          if (room && agent) {
            room.addMember(agent.id)
            await agent.join(room)
          }
          break
        }
        case 'create_agent': {
          const agent = await system.spawnAIAgent(msg.config)
          subscribeAgentState(agent.id, agent.name)
          broadcast({ type: 'agent_joined', agent: { id: agent.id, name: agent.name, description: agent.description, kind: agent.kind } })
          break
        }
        case 'remove_agent': {
          const agent = system.team.getAgent(msg.name)
          if (agent) {
            unsubscribeAgentState(agent.id)
            system.removeAgent(agent.id)
            broadcast({ type: 'agent_removed', agentName: msg.name })
          }
          break
        }
        default: {
          ws.send(JSON.stringify({
            type: 'error', message: `Unknown message type: ${(msg as Record<string, unknown>).type}`,
          } satisfies WSOutbound))
        }
      }
    } catch (err) {
      ws.send(JSON.stringify({
        type: 'error',
        message: err instanceof Error ? err.message : 'Command failed',
      } satisfies WSOutbound))
    }
  }

  // --- Bun server ---

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

        // Reconnection: reuse existing session
        if (sessions.has(sessionToken)) {
          const upgraded = server.upgrade(req, { data: { sessionToken, reconnect: true } })
          return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 500 })
        }

        // Ensure unique name
        const existingNames = [...system.team.listAgents().map(a => a.name)]
        const assignedName = system.team.getAgent(name) ? ensureUniqueName(name, existingNames) : name

        const upgraded = server.upgrade(req, { data: { sessionToken, name: assignedName } })
        return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 500 })
      }

      // API routes
      const apiResponse = await handleAPI(req, pathname)
      if (apiResponse) return apiResponse

      // Static files
      const staticResponse = await serveStatic(pathname)
      if (staticResponse) return staticResponse

      return new Response('Not found', { status: 404 })
    },

    websocket: {
      async open(ws) {
        if (ws.data.reconnect) {
          const session = sessions.get(ws.data.sessionToken)
          if (!session) return
          session.agent.setTransport((msg: Message) => {
            ws.send(JSON.stringify({ type: 'message', message: msg } satisfies WSOutbound))
          })
          session.lastActivity = Date.now()
          wsConnections.set(ws.data.sessionToken, ws)
          ws.send(JSON.stringify(buildSnapshot(session.agent.id)))
          return
        }

        const agent = await system.spawnHumanAgent(
          { name: ws.data.name!, description: `Human participant: ${ws.data.name}` },
          (msg: Message) => {
            ws.send(JSON.stringify({ type: 'message', message: msg } satisfies WSOutbound))
          },
        )

        const session: ClientSession = { agent, lastActivity: Date.now() }
        sessions.set(ws.data.sessionToken, session)
        wsConnections.set(ws.data.sessionToken, ws)

        ws.send(JSON.stringify(buildSnapshot(agent.id, ws.data.sessionToken)))
      },

      async message(ws, raw) {
        const session = sessions.get(ws.data.sessionToken)
        if (!session) return
        session.lastActivity = Date.now()
        await handleWSMessage(ws, session, typeof raw === 'string' ? raw : raw.toString())
      },

      close(ws) {
        wsConnections.delete(ws.data.sessionToken)
        // Session kept for reconnection; cleaned up by TTL interval
      },
    },
  })

  console.log(`Server listening on http://localhost:${port}`)
  console.log(`WebSocket: ws://localhost:${port}/ws?name=YourName`)
  console.log(`API: http://localhost:${port}/api/rooms`)

  return server
}
