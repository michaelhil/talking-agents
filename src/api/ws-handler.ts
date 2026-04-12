// ============================================================================
// WebSocket Handler — WS protocol, session management, and broadcasting.
//
// Handles upgrade, message dispatch, reconnection, and inactive agent reclaim.
// Commands mirror REST endpoints but use a simpler JSON message protocol.
//
// Command modules live in ws-commands/: room, agent, artifact, message.
// The dispatch loop tries each handler in order; first match wins.
// ============================================================================

import type { System } from '../main.ts'
import type { HumanAgent } from '../agents/human-agent.ts'
import type {
  AgentProfile,
  RoomState,
  StateValue,
  WSInbound,
  WSOutbound,
} from '../core/types.ts'
import { asAIAgent } from '../agents/shared.ts'
import { handleRoomCommand } from './ws-commands/room-commands.ts'
import { handleAgentCommand } from './ws-commands/agent-commands.ts'
import { handleArtifactCommand } from './ws-commands/artifact-commands.ts'
import { handleMessageCommand } from './ws-commands/message-commands.ts'
import { sendError } from './ws-commands/types.ts'

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
  readonly subscribeOllamaMetrics: (sessionToken: string) => void
  readonly unsubscribeOllamaMetrics: (sessionToken: string) => void
  readonly buildSnapshot: (agentId: string, sessionToken?: string) => Extract<WSOutbound, { type: 'snapshot' }>
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

  // Wire system callbacks → WS broadcasts
  system.setOnRoomCreated((profile) => {
    broadcast({ type: 'room_created', profile })
  })
  system.setOnRoomDeleted((_roomId, roomName) => {
    broadcast({ type: 'room_deleted', roomName })
  })
  system.setOnMembershipChanged((roomId, roomName, agentId, agentName, action) => {
    broadcast({ type: 'membership_changed', roomId, roomName, agentId, agentName, action })
  })

  system.setOnEvalEvent((agentName, event) => {
    broadcast({ type: 'agent_activity', agentName, event })
  })

  // Wire gateway health changes → broadcast to all clients
  system.ollama.onHealthChange((health) => {
    broadcast({ type: 'ollama_health', health: health as unknown as Record<string, unknown> })
  })

  // Subscribe-based ollama metrics push (keyed by agent ID)
  const metricsSubscribers = new Set<string>()
  let metricsPushTimer: ReturnType<typeof setInterval> | undefined

  const startMetricsPush = (): void => {
    if (metricsPushTimer) return
    metricsPushTimer = setInterval(() => {
      if (metricsSubscribers.size === 0) return
      const metrics = system.ollama.getMetrics() as unknown as Record<string, unknown>
      const data = JSON.stringify({ type: 'ollama_metrics', metrics })
      // Find WS connections for subscribed agents
      for (const agentId of metricsSubscribers) {
        for (const [token, session] of sessions) {
          if (session.agent.id === agentId) {
            const ws = wsConnections.get(token)
            if (ws) try { ws.send(data) } catch { /* client gone */ }
          }
        }
      }
    }, 3_000)
  }

  const subscribeOllamaMetrics = (agentId: string): void => {
    metricsSubscribers.add(agentId)
    startMetricsPush()
  }

  const unsubscribeOllamaMetrics = (agentId: string): void => {
    metricsSubscribers.delete(agentId)
    if (metricsSubscribers.size === 0 && metricsPushTimer) {
      clearInterval(metricsPushTimer)
      metricsPushTimer = undefined
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

  const buildSnapshot = (agentId: string, sessionToken?: string): Extract<WSOutbound, { type: 'snapshot' }> => {
    const roomStates: Record<string, RoomState> = {}
    for (const profile of system.house.listAllRooms()) {
      const room = system.house.getRoom(profile.id)
      if (room) roomStates[profile.id] = room.getRoomState()
    }
    const agents: AgentProfile[] = system.team.listAgents()
      .filter(a => !a.inactive)
      .map(a => {
        const ai = asAIAgent(a)
        const ctx = a.state.getContext()
        return { id: a.id, name: a.name, kind: a.kind, state: a.state.get(), ...(ctx ? { context: ctx } : {}), ...(ai ? { model: ai.getModel() } : {}) }
      })
    return {
      type: 'snapshot',
      rooms: system.house.listAllRooms(),
      agents,
      agentId,
      roomStates,
      ...(sessionToken ? { sessionToken } : {}),
    }
  }

  return { sessions, wsConnections, broadcast, subscribeAgentState, unsubscribeAgentState, subscribeOllamaMetrics, unsubscribeOllamaMetrics, buildSnapshot }
}

// === Command dispatch order — first handler that returns true wins ===

const commandHandlers = [
  handleMessageCommand,
  handleRoomCommand,
  handleAgentCommand,
  handleArtifactCommand,
]

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

  // Handle ollama metrics subscribe/unsubscribe
  const msgType = (msg as Record<string, unknown>).type
  if (msgType === 'subscribe_ollama_metrics') {
    wsManager.subscribeOllamaMetrics(session.agent.id)
    return
  }
  if (msgType === 'unsubscribe_ollama_metrics') {
    wsManager.unsubscribeOllamaMetrics(session.agent.id)
    return
  }

  const ctx = { ws, session, system, broadcast: wsManager.broadcast, wsManager }

  try {
    for (const handler of commandHandlers) {
      if (await handler(msg, ctx)) return
    }
    sendError(ws, `Unknown message type: ${(msg as Record<string, unknown>).type}`)
  } catch (err) {
    sendError(ws, err instanceof Error ? err.message : 'Command failed')
  }
}
