// ============================================================================
// WebSocket Handler — WS protocol, session management, and broadcasting.
//
// Handles upgrade, message dispatch, reconnection, and inactive agent reclaim.
// Commands mirror REST endpoints but use a simpler JSON message protocol.
// ============================================================================

import type { System } from '../main.ts'
import type { HumanAgent } from '../agents/human-agent.ts'
import type {
  Message,
  StateValue,
  WSInbound,
  WSOutbound,
} from '../core/types.ts'
import { addAgentToRoom, asAIAgent } from '../agents/shared.ts'

// === Types ===

export interface ClientSession {
  readonly agent: HumanAgent
  lastActivity: number
}

export interface WSData {
  sessionToken: string
  name?: string
  reconnect?: boolean
}

// === Session + State Management ===

export interface WSManager {
  readonly sessions: Map<string, ClientSession>
  readonly wsConnections: Map<string, { send: (data: string) => void }>
  readonly broadcast: (msg: WSOutbound) => void
  readonly subscribeAgentState: (agentId: string, agentName: string) => void
  readonly unsubscribeAgentState: (agentId: string) => void
  readonly buildSnapshot: (agentId: string, sessionToken?: string) => Record<string, unknown>
}

export const createWSManager = (system: System): WSManager => {
  const sessions = new Map<string, ClientSession>()
  const wsConnections = new Map<string, { send: (data: string) => void }>()
  const stateUnsubs = new Map<string, () => void>()

  const broadcast = (msg: WSOutbound): void => {
    const data = JSON.stringify(msg)
    for (const ws of wsConnections.values()) {
      try { ws.send(data) } catch { /* client gone */ }
    }
  }

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

  const buildSnapshot = (agentId: string, sessionToken?: string): Record<string, unknown> => {
    // Build per-room state for UI sync on connect/reconnect
    const roomStates: Record<string, unknown> = {}
    for (const profile of system.house.listAllRooms()) {
      const room = system.house.getRoom(profile.id)
      if (room) {
        roomStates[profile.id] = room.getRoomState()
      }
    }
    return {
      type: 'snapshot',
      rooms: system.house.listAllRooms(),
      agents: system.team.listAgents()
        .filter(a => !a.inactive)
        .map(a => ({
          id: a.id, name: a.name, kind: a.kind, state: a.state.get(),
        })),
      agentId,
      roomStates,
      ...(sessionToken ? { sessionToken } : {}),
    }
  }

  return { sessions, wsConnections, broadcast, subscribeAgentState, unsubscribeAgentState, buildSnapshot }
}

// === Lookup Helpers ===

const sendError = (ws: { send: (data: string) => void }, message: string): void => {
  ws.send(JSON.stringify({ type: 'error', message } satisfies WSOutbound))
}

const requireRoom = (ws: { send: (data: string) => void }, system: System, roomName: string): ReturnType<typeof system.house.getRoom> => {
  const room = system.house.getRoom(roomName)
  if (!room) sendError(ws, `Room "${roomName}" not found`)
  return room
}

const requireAgent = (ws: { send: (data: string) => void }, system: System, agentName: string): ReturnType<typeof system.team.getAgent> => {
  const agent = system.team.getAgent(agentName)
  if (!agent) sendError(ws, `Agent "${agentName}" not found`)
  return agent
}

// === Message Handler ===

export const handleWSMessage = async (
  ws: { send: (data: string) => void },
  session: ClientSession,
  raw: string,
  system: System,
  wsManager: WSManager,
): Promise<void> => {
  let msg: WSInbound
  try {
    msg = JSON.parse(raw) as WSInbound
  } catch {
    sendError(ws, 'Invalid JSON')
    return
  }

  try {
    switch (msg.type) {
      case 'post_message': {
        const resolved = msg.target ?? {}
        const delivered = system.routeMessage(resolved, {
          senderId: session.agent.id,
          senderName: session.agent.name,
          content: msg.content,
          type: 'chat',
        })
        for (const m of delivered) {
          ws.send(JSON.stringify({ type: 'message', message: m } satisfies WSOutbound))
        }
        break
      }
      case 'create_room': {
        const result = system.house.createRoomSafe({
          name: msg.name,
          roomPrompt: msg.roomPrompt,
          visibility: msg.visibility ?? 'public',
          createdBy: session.agent.id,
        })
        result.value.addMember(session.agent.id)
        await session.agent.join(result.value)
        wsManager.broadcast({ type: 'room_created', profile: result.value.profile })
        break
      }
      case 'add_to_room': {
        const room = requireRoom(ws, system, msg.roomName)
        const agent = requireAgent(ws, system, msg.agentName)
        if (room && agent) await addAgentToRoom(agent, room)
        break
      }
      case 'create_agent': {
        const agent = await system.spawnAIAgent(msg.config)
        wsManager.subscribeAgentState(agent.id, agent.name)
        wsManager.broadcast({ type: 'agent_joined', agent: { id: agent.id, name: agent.name, kind: agent.kind } })
        break
      }
      case 'remove_agent': {
        const agent = system.team.getAgent(msg.name)
        if (agent) {
          wsManager.unsubscribeAgentState(agent.id)
          system.removeAgent(agent.id)
          wsManager.broadcast({ type: 'agent_removed', agentName: msg.name })
        }
        break
      }
      case 'update_agent': {
        const agent = system.team.getAgent(msg.name)
        const aiAgent = agent ? asAIAgent(agent) : undefined
        if (aiAgent) {
          if (msg.systemPrompt) aiAgent.updateSystemPrompt(msg.systemPrompt)
          if (msg.model) aiAgent.updateModel(msg.model)
        }
        break
      }
      case 'cancel_generation': {
        const agent = system.team.getAgent(msg.name)
        const aiAgent = agent ? asAIAgent(agent) : undefined
        aiAgent?.cancelGeneration()
        break
      }
      case 'set_delivery_mode': {
        const room = requireRoom(ws, system, msg.roomName)
        if (!room) break
        room.setDeliveryMode(msg.mode)
        break
      }
      case 'set_paused': {
        const room = requireRoom(ws, system, msg.roomName)
        if (!room) break
        room.setPaused(msg.paused)
        wsManager.broadcast({ type: 'delivery_mode_changed', roomName: room.profile.name, mode: room.deliveryMode, paused: room.paused })
        break
      }
      case 'set_muted': {
        const room = requireRoom(ws, system, msg.roomName)
        const agent = requireAgent(ws, system, msg.agentName)
        if (!room || !agent) break
        room.setMuted(agent.id, msg.muted)
        wsManager.broadcast({ type: 'mute_changed', roomName: room.profile.name, agentName: agent.name, muted: msg.muted })
        break
      }
      case 'add_flow': {
        const room = requireRoom(ws, system, msg.roomName)
        if (!room) break
        const flow = room.addFlow({ name: msg.name, steps: msg.steps, loop: msg.loop ?? false })
        ws.send(JSON.stringify({ type: 'flow_event', roomName: room.profile.name, event: 'started', detail: { flowId: flow.id, flowName: flow.name } } satisfies WSOutbound))
        break
      }
      case 'remove_flow': {
        const room = requireRoom(ws, system, msg.roomName)
        if (!room) break
        room.removeFlow(msg.flowId)
        break
      }
      case 'start_flow': {
        const room = requireRoom(ws, system, msg.roomName)
        if (!room) break
        room.post({ senderId: session.agent.id, senderName: session.agent.name, content: msg.content, type: 'chat' })
        room.startFlow(msg.flowId)
        break
      }
      case 'cancel_flow': {
        const room = requireRoom(ws, system, msg.roomName)
        if (!room) break
        room.cancelFlow()
        break
      }
      case 'add_todo': {
        const room = requireRoom(ws, system, msg.roomName)
        if (!room) break
        const todo = room.addTodo({
          content: msg.content,
          assignee: msg.assignee,
          assigneeId: msg.assigneeId,
          dependencies: msg.dependencies,
          createdBy: session.agent.name,
        })
        wsManager.broadcast({ type: 'todo_changed', roomName: room.profile.name, action: 'added', todo })
        break
      }
      case 'update_todo': {
        const room = requireRoom(ws, system, msg.roomName)
        if (!room) break
        const updates: Record<string, unknown> = {}
        if (msg.status) updates.status = msg.status
        if (msg.assignee) updates.assignee = msg.assignee
        if (msg.assigneeId) updates.assigneeId = msg.assigneeId
        if (msg.content) updates.content = msg.content
        if (msg.result) updates.result = msg.result
        const updated = room.updateTodo(msg.todoId, updates as Parameters<typeof room.updateTodo>[1])
        if (updated) {
          wsManager.broadcast({ type: 'todo_changed', roomName: room.profile.name, action: 'updated', todo: updated })
        } else {
          sendError(ws, `Todo "${msg.todoId}" not found`)
        }
        break
      }
      case 'remove_todo': {
        const room = requireRoom(ws, system, msg.roomName)
        if (!room) break
        const existingTodos = room.getTodos()
        const todoToRemove = existingTodos.find(t => t.id === msg.todoId)
        const removed = room.removeTodo(msg.todoId)
        if (removed && todoToRemove) {
          wsManager.broadcast({ type: 'todo_changed', roomName: room.profile.name, action: 'removed', todo: todoToRemove })
        } else {
          sendError(ws, `Todo "${msg.todoId}" not found`)
        }
        break
      }
      default:
        sendError(ws, `Unknown message type: ${(msg as Record<string, unknown>).type}`)
    }
  } catch (err) {
    sendError(ws, err instanceof Error ? err.message : 'Command failed')
  }
}
