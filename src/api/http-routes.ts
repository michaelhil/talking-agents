// ============================================================================
// HTTP Routes — REST API endpoint handlers.
//
// Pure request→response functions. No WebSocket or server lifecycle concerns.
// All routes delegate to System methods — no business logic here.
// ============================================================================

import type { System } from '../main.ts'
import type { MessageTarget, WSOutbound } from '../core/types.ts'
import { SYSTEM_SENDER_ID } from '../core/types.ts'
import { asAIAgent } from '../agents/shared.ts'

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

  // GET /api/tools — all registered tools (name + description)
  if (method === 'GET' && pathname === '/api/tools') {
    return json(system.toolRegistry.list().map(t => ({ name: t.name, description: t.description })))
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
    return json(system.house.listAllRooms())
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
        createdBy: (body.createdBy as string) ?? SYSTEM_SENDER_ID,
      })
      // room_created broadcast handled via onRoomCreated callback in system
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
      system.removeRoom(room.profile.id)
      // room_deleted broadcast handled via onRoomDeleted callback in system
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

  // GET /api/rooms/:name/members
  if (method === 'GET') {
    const name = extractParam(pathname, '/api/rooms/:name/members')
    if (name) {
      const room = system.house.getRoom(name)
      if (!room) return notFound(`Room "${name}"`)
      const members = room.getParticipantIds().map(id => {
        const agent = system.team.getAgent(id)
        return agent ? { id: agent.id, name: agent.name, kind: agent.kind } : { id }
      })
      return json(members)
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
      await system.addAgentToRoom(agent.id, room.profile.id)
      return json({ added: true, agentName: agent.name, roomName: room.profile.name })
    }
  }

  // DELETE /api/rooms/:name/members/:agentName
  if (method === 'DELETE') {
    const roomName = extractParam(pathname, '/api/rooms/:name/members')
    if (!roomName) {
      // Try the members/:agentName pattern
      const match = pathname.match(/^\/api\/rooms\/([^/]+)\/members\/([^/]+)$/)
      if (match) {
        const rName = decodeURIComponent(match[1]!)
        const aName = decodeURIComponent(match[2]!)
        const room = system.house.getRoom(rName)
        if (!room) return notFound(`Room "${rName}"`)
        const agent = system.team.getAgent(aName)
        if (!agent) return notFound(`Agent "${aName}"`)
        system.removeAgentFromRoom(agent.id, room.profile.id)
        return json({ removed: true, agentName: agent.name, roomName: room.profile.name })
      }
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
      const aiAgent = asAIAgent(agent)
      if (aiAgent) {
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
      const aiAgent = asAIAgent(agent)
      if (!aiAgent) return errorResponse('Only AI agents can be updated')
      const body = await parseBody(req)
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
      const aiAgent = asAIAgent(agent)
      if (!aiAgent) return errorResponse('Only AI agents can be cancelled')
      aiAgent.cancelGeneration()
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
      const aiA = asAIAgent(agent)
      broadcast({ type: 'agent_joined', agent: { id: agent.id, name: agent.name, kind: agent.kind, ...(aiA ? { model: aiA.getModel() } : {}) } })
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
    const newMode = body.mode as 'broadcast'
    if (newMode !== 'broadcast') {
      return errorResponse('mode must be broadcast')
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
    if (typeof body.paused !== 'boolean') return errorResponse('paused must be a boolean')
    room.setPaused(body.paused)
    broadcast({ type: 'delivery_mode_changed', roomName: room.profile.name, mode: room.deliveryMode, paused: room.paused })
    return json({ paused: room.paused })
  }

  // PUT /api/rooms/:name/mute
  const muteRoomName = extractParam(pathname, '/api/rooms/:name/mute')
  if (method === 'PUT' && muteRoomName) {
    const room = system.house.getRoom(muteRoomName)
    if (!room) return notFound('Room')
    const body = await parseBody(req)
    if (typeof body.agentName !== 'string') return errorResponse('agentName is required')
    if (typeof body.muted !== 'boolean') return errorResponse('muted must be a boolean')
    const agent = system.team.getAgent(body.agentName)
    if (!agent) return notFound('Agent')
    room.setMuted(agent.id, body.muted)
    broadcast({ type: 'mute_changed', roomName: room.profile.name, agentName: agent.name, muted: body.muted })
    return json({ muted: room.isMuted(agent.id) })
  }

  // POST /api/rooms/:name/flows
  const flowsRoom = extractParam(pathname, '/api/rooms/:name/flows')
  if (method === 'POST' && flowsRoom) {
    const room = system.house.getRoom(flowsRoom)
    if (!room) return notFound('Room')
    const body = await parseBody(req)
    if (typeof body.name !== 'string') return errorResponse('name is required')
    if (!Array.isArray(body.steps)) return errorResponse('steps must be an array')
    if (body.loop !== undefined && typeof body.loop !== 'boolean') return errorResponse('loop must be a boolean')
    const flow = room.addFlow({
      name: body.name,
      steps: body.steps as Array<{ agentId: string; agentName: string; stepPrompt?: string }>,
      loop: (body.loop as boolean | undefined) ?? false,
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
    if (typeof body.flowId !== 'string') return errorResponse('flowId is required')
    if (body.content && body.senderId) {
      room.setPaused(true)
      room.post({
        senderId: body.senderId as string,
        senderName: body.senderName as string | undefined,
        content: body.content as string,
        type: 'chat',
      })
    }
    room.startFlow(body.flowId)
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

  // GET /api/rooms/:name/todos
  const todosRoom = extractParam(pathname, '/api/rooms/:name/todos')
  if (method === 'GET' && todosRoom) {
    const room = system.house.getRoom(todosRoom)
    if (!room) return notFound('Room')
    return json(room.getTodos())
  }

  // POST /api/rooms/:name/todos
  if (method === 'POST' && todosRoom) {
    const room = system.house.getRoom(todosRoom)
    if (!room) return notFound('Room')
    const body = await parseBody(req)
    if (!body.content || typeof body.content !== 'string') return errorResponse('content is required')
    const todo = room.addTodo({
      content: body.content,
      assignee: body.assignee as string | undefined,
      assigneeId: body.assigneeId as string | undefined,
      dependencies: body.dependencies as ReadonlyArray<string> | undefined,
      createdBy: (body.createdBy as string) ?? SYSTEM_SENDER_ID,
    })
    return json(todo, 201)
  }

  // PUT /api/rooms/:name/todos/:todoId — need two-param extraction
  if (method === 'PUT') {
    const todoMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/todos\/([^/]+)$/)
    if (todoMatch) {
      const roomName = decodeURIComponent(todoMatch[1]!)
      const todoId = decodeURIComponent(todoMatch[2]!)
      const room = system.house.getRoom(roomName)
      if (!room) return notFound('Room')
      const body = await parseBody(req)
      const updated = room.updateTodo(todoId, {
        status: body.status as Parameters<typeof room.updateTodo>[1]['status'],
        assignee: body.assignee as string | undefined,
        assigneeId: body.assigneeId as string | undefined,
        content: body.content as string | undefined,
        result: body.result as string | undefined,
      })
      if (!updated) return notFound(`Todo "${todoId}"`)
      return json(updated)
    }
  }

  // DELETE /api/rooms/:name/todos/:todoId
  if (method === 'DELETE') {
    const todoMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/todos\/([^/]+)$/)
    if (todoMatch) {
      const roomName = decodeURIComponent(todoMatch[1]!)
      const todoId = decodeURIComponent(todoMatch[2]!)
      const room = system.house.getRoom(roomName)
      if (!room) return notFound('Room')
      const removed = room.removeTodo(todoId)
      if (!removed) return notFound(`Todo "${todoId}"`)
      return json({ removed: true })
    }
  }

  return null
}
