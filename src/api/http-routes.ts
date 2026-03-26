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

  // GET /api/models — available Ollama models (running first, then all)
  if (method === 'GET' && pathname === '/api/models') {
    try {
      const [running, all] = await Promise.all([
        system.ollama.runningModels().catch(() => [] as string[]),
        system.ollama.models().catch(() => [] as string[]),
      ])
      // Running models first, then remaining models (deduplicated)
      const runningSet = new Set(running)
      const available = all.filter(m => !runningSet.has(m))
      return json({ running, available })
    } catch {
      return json({ running: [], available: [] })
    }
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
      id: a.id, name: a.name, kind: a.kind, state: a.state.get(),
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
        id: agent.id, name: agent.name,
        kind: agent.kind, state: agent.state.get(), rooms: system.house.getRoomsForAgent(agent.id).map(r => r.profile.id),
      }
      if (agent.kind === 'ai' && 'getSystemPrompt' in agent) {
        const aiAgent = agent as AIAgent
        detail.systemPrompt = aiAgent.getSystemPrompt()
        detail.model = aiAgent.getModel()
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
      const aiAgent = agent as AIAgent
      if (body.systemPrompt) aiAgent.updateSystemPrompt(body.systemPrompt as string)
      if (body.model) aiAgent.updateModel(body.model as string)
      return json({ updated: true, name: agent.name })
    }

  }

  // POST /api/agents/:name/cancel — cancel generation
  if (method === 'POST') {
    const cancelName = extractParam(pathname, '/api/agents/:name/cancel')
    if (cancelName) {
      const agent = system.team.getAgent(cancelName)
      if (!agent) return notFound(`Agent "${cancelName}"`)
      if (agent.kind !== 'ai') return errorResponse('Only AI agents can be cancelled')
      ;(agent as AIAgent).cancelGeneration()
      return json({ cancelled: true, name: agent.name })
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
        model: body.model as string,
        systemPrompt: body.systemPrompt as string,
        temperature: body.temperature as number | undefined,
        historyLimit: body.historyLimit as number | undefined,
      })
      subscribeAgentState(agent.id, agent.name)
      broadcast({ type: 'agent_joined', agent: { id: agent.id, name: agent.name, kind: agent.kind } })
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

  // PUT /api/rooms/:name/delivery-mode
  const dmRoomName = extractParam(pathname, '/api/rooms/:name/delivery-mode')
  if (method === 'PUT' && dmRoomName) {
    const room = system.house.getRoom(dmRoomName)
    if (!room) return notFound('Room')
    const body = await parseBody(req)
    const newMode = body.mode as 'broadcast' | 'staleness'
    if (!['broadcast', 'staleness'].includes(newMode)) {
      return errorResponse('mode must be broadcast or staleness')
    }
    room.setDeliveryMode(newMode)
    return json({ mode: room.deliveryMode })
  }

  // PUT /api/rooms/:name/pause
  const pauseRoomName = extractParam(pathname, '/api/rooms/:name/pause')
  if (method === 'PUT' && pauseRoomName) {
    const room = system.house.getRoom(pauseRoomName)
    if (!room) return notFound('Room')
    const body = await parseBody(req)
    room.setPaused(body.paused as boolean)
    broadcast({ type: 'delivery_mode_changed', roomName: room.profile.name, mode: room.deliveryMode, paused: room.paused })
    return json({ paused: room.paused })
  }

  // PUT /api/rooms/:name/mute
  const muteRoomName = extractParam(pathname, '/api/rooms/:name/mute')
  if (method === 'PUT' && muteRoomName) {
    const room = system.house.getRoom(muteRoomName)
    if (!room) return notFound('Room')
    const body = await parseBody(req)
    const agent = system.team.getAgent(body.agentName as string)
    if (!agent) return notFound('Agent')
    room.setMuted(agent.id, body.muted as boolean)
    broadcast({ type: 'mute_changed', roomName: room.profile.name, agentName: agent.name, muted: body.muted as boolean })
    return json({ muted: room.isMuted(agent.id) })
  }

  // PUT /api/rooms/:name/staleness/pause
  const stalenessPauseRoom = extractParam(pathname, '/api/rooms/:name/staleness/pause')
  if (method === 'PUT' && stalenessPauseRoom) {
    const room = system.house.getRoom(stalenessPauseRoom)
    if (!room) return notFound('Room')
    const body = await parseBody(req)
    room.setStalenessPaused(body.paused as boolean)
    return json({ paused: room.staleness.paused })
  }

  // PUT /api/rooms/:name/staleness/participating
  const stalenessPartRoom = extractParam(pathname, '/api/rooms/:name/staleness/participating')
  if (method === 'PUT' && stalenessPartRoom) {
    const room = system.house.getRoom(stalenessPartRoom)
    if (!room) return notFound('Room')
    const body = await parseBody(req)
    const agent = system.team.getAgent(body.agentName as string)
    if (!agent) return notFound('Agent')
    room.setParticipating(agent.id, body.participating as boolean)
    return json({ participating: room.staleness.participating.has(agent.id) })
  }

  // POST /api/rooms/:name/flows
  const flowsRoom = extractParam(pathname, '/api/rooms/:name/flows')
  if (method === 'POST' && flowsRoom) {
    const room = system.house.getRoom(flowsRoom)
    if (!room) return notFound('Room')
    const body = await parseBody(req)
    if (!body.name || !body.steps) return errorResponse('name and steps are required')
    const flow = room.addFlow({
      name: body.name as string,
      steps: body.steps as Array<{ agentName: string; stepPrompt?: string }>,
      loop: (body.loop as boolean) ?? false,
    })
    return json(flow, 201)
  }

  // GET /api/rooms/:name/flows
  if (method === 'GET' && flowsRoom) {
    const room = system.house.getRoom(flowsRoom)
    if (!room) return notFound('Room')
    return json(room.getFlows())
  }

  // POST /api/rooms/:name/flows/start
  const flowStartRoom = extractParam(pathname, '/api/rooms/:name/flows/start')
  if (method === 'POST' && flowStartRoom) {
    const room = system.house.getRoom(flowStartRoom)
    if (!room) return notFound('Room')
    const body = await parseBody(req)
    if (!body.flowId) return errorResponse('flowId is required')
    if (body.content && body.senderId) {
      room.post({
        senderId: body.senderId as string,
        senderName: body.senderName as string | undefined,
        content: body.content as string,
        type: 'chat',
      })
    }
    room.startFlow(body.flowId as string)
    return json({ started: true, mode: room.deliveryMode })
  }

  // POST /api/rooms/:name/flows/cancel
  const flowCancelRoom = extractParam(pathname, '/api/rooms/:name/flows/cancel')
  if (method === 'POST' && flowCancelRoom) {
    const room = system.house.getRoom(flowCancelRoom)
    if (!room) return notFound('Room')
    room.cancelFlow()
    return json({ cancelled: true, mode: room.deliveryMode })
  }

  return null
}
