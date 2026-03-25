// ============================================================================
// WebSocket Handler — WS protocol, session management, and broadcasting.
//
// Handles upgrade, message dispatch, reconnection, and inactive agent reclaim.
// Commands mirror REST endpoints but use a simpler JSON message protocol.
// ============================================================================

import type { System } from '../main.ts'
import type { HumanAgent } from '../agents/human-agent.ts'
import type {
  AIAgent,
  Message,
  StateValue,
  WSInbound,
  WSOutbound,
} from '../core/types.ts'

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

  const buildSnapshot = (agentId: string, sessionToken?: string): Record<string, unknown> => ({
    type: 'snapshot',
    rooms: system.house.listAllRooms(),
    agents: system.team.listAgents()
      .filter(a => !a.inactive)
      .map(a => ({
        id: a.id, name: a.name, description: a.description, kind: a.kind, state: a.state.get(),
      })),
    agentId,
    ...(sessionToken ? { sessionToken } : {}),
  })

  return { sessions, wsConnections, broadcast, subscribeAgentState, unsubscribeAgentState, buildSnapshot }
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
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' } satisfies WSOutbound))
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
          description: msg.description,
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
        wsManager.subscribeAgentState(agent.id, agent.name)
        wsManager.broadcast({ type: 'agent_joined', agent: { id: agent.id, name: agent.name, description: agent.description, kind: agent.kind } })
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
        if (agent && agent.kind === 'ai' && 'updateSystemPrompt' in agent) {
          (agent as AIAgent).updateSystemPrompt(msg.systemPrompt)
        }
        break
      }
      case 'set_turn_taking': {
        const room = system.house.getRoom(msg.roomName)
        if (!room) {
          ws.send(JSON.stringify({ type: 'error', message: `Room "${msg.roomName}" not found` } satisfies WSOutbound))
          break
        }
        room.setTurnTaking(msg.enabled)
        wsManager.broadcast({
          type: 'turn_taking_changed',
          roomName: room.profile.name,
          enabled: room.turnTaking.enabled,
          paused: room.turnTaking.paused,
        })
        break
      }
      case 'set_turn_taking_paused': {
        const room = system.house.getRoom(msg.roomName)
        if (!room) {
          ws.send(JSON.stringify({ type: 'error', message: `Room "${msg.roomName}" not found` } satisfies WSOutbound))
          break
        }
        room.setTurnTakingPaused(msg.paused)
        wsManager.broadcast({
          type: 'turn_taking_changed',
          roomName: room.profile.name,
          enabled: room.turnTaking.enabled,
          paused: room.turnTaking.paused,
        })
        break
      }
      case 'set_participating': {
        const room = system.house.getRoom(msg.roomName)
        const agent = system.team.getAgent(msg.agentName)
        if (!room) {
          ws.send(JSON.stringify({ type: 'error', message: `Room "${msg.roomName}" not found` } satisfies WSOutbound))
          break
        }
        if (!agent) {
          ws.send(JSON.stringify({ type: 'error', message: `Agent "${msg.agentName}" not found` } satisfies WSOutbound))
          break
        }
        room.setParticipating(agent.id, msg.participating)
        wsManager.broadcast({
          type: 'turn_taking_changed',
          roomName: room.profile.name,
          enabled: room.turnTaking.enabled,
          paused: room.turnTaking.paused,
        })
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
