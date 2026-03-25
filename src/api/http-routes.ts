// ============================================================================
// HTTP Routes — REST API endpoint handlers.
//
// Pure request→response functions. No WebSocket or server lifecycle concerns.
// All routes delegate to System methods — no business logic here.
// ============================================================================

import type { System } from '../main.ts'
import type { AIAgent, MessageTarget, WSOutbound } from '../core/types.ts'
import { SYSTEM_SENDER_ID } from '../core/types.ts'

// === Helpers ===

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

export const errorResponse = (message: string, status = 400) =>
  json({ error: message }, status)

const notFound = (what: string) => errorResponse(`${what} not found`, 404)

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

// === Route Handler ===

export const handleAPI = async (
  req: Request,
  pathname: string,
  system: System,
  broadcast: (msg: WSOutbound) => void,
  subscribeAgentState: (agentId: string, agentName: string) => void,
  unsubscribeAgentState?: (agentId: string) => void,
): Promise<Response | null> => {
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

  // GET /api/house/prompts — all editable prompts
  if (method === 'GET' && pathname === '/api/house/prompts') {
    return json({
      housePrompt: system.house.getHousePrompt(),
      responseFormat: system.house.getResponseFormat(),
    })
  }

  // PUT /api/house/prompts — update house prompt and/or response format
  if (method === 'PUT' && pathname === '/api/house/prompts') {
    const body = await parseBody(req)
    if (typeof body.housePrompt === 'string') system.house.setHousePrompt(body.housePrompt)
    if (typeof body.responseFormat === 'string') system.house.setResponseFormat(body.responseFormat)
    return json({
      housePrompt: system.house.getHousePrompt(),
      responseFormat: system.house.getResponseFormat(),
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

  // PUT /api/rooms/:name/prompt — update room prompt
  if (method === 'PUT') {
    const name = extractParam(pathname, '/api/rooms/:name/prompt')
    if (name) {
      const room = system.house.getRoom(name)
      if (!room) return notFound(`Room "${name}"`)
      const body = await parseBody(req)
      if (typeof body.roomPrompt !== 'string') return errorResponse('roomPrompt is required')
      room.setRoomPrompt(body.roomPrompt)
      return json({ roomPrompt: room.profile.roomPrompt })
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
      return json(system.house.getRoomsForAgent(agent.id).map(r => r.profile))
    }

    const agentName = extractParam(pathname, '/api/agents/:name')
    if (agentName) {
      const agent = system.team.getAgent(agentName)
      if (!agent) return notFound(`Agent "${agentName}"`)
      const detail: Record<string, unknown> = {
        id: agent.id, name: agent.name, description: agent.description,
        kind: agent.kind, state: agent.state.get(), rooms: system.house.getRoomsForAgent(agent.id).map(r => r.profile.id),
      }
      if (agent.kind === 'ai' && 'getSystemPrompt' in agent) {
        detail.systemPrompt = (agent as AIAgent).getSystemPrompt()
      }
      return json(detail)
    }
  }

  // PATCH /api/agents/:name
  if (method === 'PATCH') {
    const agentName = extractParam(pathname, '/api/agents/:name')
    if (agentName) {
      const agent = system.team.getAgent(agentName)
      if (!agent) return notFound(`Agent "${agentName}"`)
      if (agent.kind !== 'ai') return errorResponse('Only AI agents can be updated')
      const body = await parseBody(req)
      if (body.systemPrompt) (agent as AIAgent).updateSystemPrompt(body.systemPrompt as string)
      return json({ updated: true, name: agent.name })
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
      unsubscribeAgentState?.(agent.id)
      system.removeAgent(agent.id)
      broadcast({ type: 'agent_removed', agentName: name })
      return json({ removed: true })
    }
  }

  // POST /api/messages
  if (method === 'POST' && pathname === '/api/messages') {
    const body = await parseBody(req)
    if (!body.content || !body.senderId) return errorResponse('content and senderId are required')
    const target = (body.target as MessageTarget) ?? {}
    const senderId = body.senderId as string
    const senderAgent = system.team.getAgent(senderId)
    const messages = system.routeMessage(target, {
      senderId,
      senderName: (body.senderName as string | undefined) ?? senderAgent?.name,
      content: body.content as string,
      type: (body.messageType as 'chat') ?? 'chat',
      metadata: body.metadata as Record<string, unknown> | undefined,
    })
    return json(messages, 201)
  }

  // PUT /api/rooms/:name/turn-taking
  const ttRoomName = extractParam(pathname, '/api/rooms/:name/turn-taking')
  if (method === 'PUT' && ttRoomName) {
    const room = system.house.getRoom(ttRoomName)
    if (!room) return notFound('Room')
    const body = await parseBody(req)
    room.setTurnTaking(body.enabled as boolean)
    broadcast({
      type: 'turn_taking_changed',
      roomName: room.profile.name,
      enabled: room.turnTaking.enabled,
      paused: room.turnTaking.paused,
    })
    return json({ enabled: room.turnTaking.enabled, paused: room.turnTaking.paused })
  }

  // PUT /api/rooms/:name/turn-taking/pause
  const ttPauseRoom = extractParam(pathname, '/api/rooms/:name/turn-taking/pause')
  if (method === 'PUT' && ttPauseRoom) {
    const room = system.house.getRoom(ttPauseRoom)
    if (!room) return notFound('Room')
    const body = await parseBody(req)
    room.setTurnTakingPaused(body.paused as boolean)
    broadcast({
      type: 'turn_taking_changed',
      roomName: room.profile.name,
      enabled: room.turnTaking.enabled,
      paused: room.turnTaking.paused,
    })
    return json({ enabled: room.turnTaking.enabled, paused: room.turnTaking.paused })
  }

  // PUT /api/rooms/:name/turn-taking/participating
  const ttPartRoom = extractParam(pathname, '/api/rooms/:name/turn-taking/participating')
  if (method === 'PUT' && ttPartRoom) {
    const room = system.house.getRoom(ttPartRoom)
    if (!room) return notFound('Room')
    const body = await parseBody(req)
    const agent = system.team.getAgent(body.agentName as string)
    if (!agent) return notFound('Agent')
    room.setParticipating(agent.id, body.participating as boolean)
    broadcast({
      type: 'turn_taking_changed',
      roomName: room.profile.name,
      enabled: room.turnTaking.enabled,
      paused: room.turnTaking.paused,
    })
    return json({ enabled: room.turnTaking.enabled, paused: room.turnTaking.paused })
  }

  return null
}
