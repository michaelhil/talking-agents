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
import type { Agent } from '../core/types/agent.ts'
import type { AgentProfile } from '../core/types/messaging.ts'
import type { RoomState } from '../core/types/room.ts'
import type { StateValue } from '../core/types/agent.ts'
import type { WSInbound, WSOutbound } from '../core/types/ws-protocol.ts'
import { asAIAgent } from '../agents/shared.ts'
import { handleRoomCommand } from './ws-commands/room-commands.ts'
import { handleAgentCommand } from './ws-commands/agent-commands.ts'
import { handleArtifactCommand } from './ws-commands/artifact-commands.ts'
import { handleMessageCommand } from './ws-commands/message-commands.ts'
import { sendError } from './ws-commands/types.ts'
import type { LimitMetrics } from '../core/limit-metrics.ts'

// === Constants ===

// Cap on per-connection queued bytes. Bun's ServerWebSocket exposes
// getBufferedAmount(); a slow consumer that lets this grow eats process
// memory. 8 MB is well above any plausible per-message size (snapshots a
// few hundred KB, deltas a few KB) and below "noticeably degraded".
// On overflow we close the socket (1009 = "message too big"); the client
// reconnects fresh, server state is authoritative so no data lost.
const MAX_WS_BUFFERED_BYTES = 8 * 1024 * 1024

// How long an inactive (closed-WS) human session is preserved for name-based
// reclaim. After this window the agent is removed from the team and the
// session entry deleted. 7 days strikes a balance: covers a long weekend or
// vacation, prevents indefinite accumulation.
export const SESSION_STALE_MS = 7 * 24 * 60 * 60 * 1000

// === Types ===

// Stored ws value. ServerWebSocket from Bun has both methods natively;
// the wider type lets callers apply backpressure + clean disconnect
// without reaching past WSManager. Tests inject objects that conform.
export interface WSConnection {
  send: (data: string) => void
  getBufferedAmount: () => number
  close: (code: number, reason?: string) => void
}

export interface ClientSession {
  readonly agent: HumanAgent
  readonly instanceId: string         // which per-tenant House this session belongs to
  lastActivity: number
}

export interface WSData {
  sessionToken: string
  instanceId: string                  // bound at upgrade from cookie
  name?: string
  reconnect?: boolean
}

// === Session + State Management ===

export interface WSManager {
  readonly sessions: Map<string, ClientSession>
  readonly wsConnections: Map<string, WSConnection>
  // Send to a single ws with backpressure protection. Used by the
  // per-agent transport closures in server.ts. Returns true if the bytes
  // were enqueued, false if the consumer was dropped for being too slow.
  readonly safeSend: (ws: WSConnection, data: string) => boolean
  // Global broadcast — used for shared state (Ollama health, reset, etc.)
  // that applies regardless of which instance a client belongs to.
  readonly broadcast: (msg: WSOutbound) => void
  // Per-instance broadcast — only delivers to ws connections whose session
  // has matching instanceId. Used by wireSystemEvents so an event fired in
  // instance A doesn't reach instance B's clients.
  readonly broadcastToInstance: (instanceId: string, msg: WSOutbound) => void
  readonly subscribeAgentState: (agent: Agent, instanceId: string) => void
  readonly unsubscribeAgentState: (agentId: string) => void
  // Returns null when the instance has been evicted between the WS upgrade
  // and the snapshot build. Callers must close the socket (4001) instead of
  // sending a fabricated empty snapshot — clients trust empty rooms+agents
  // and would render a blank UI without knowing why.
  readonly buildSnapshot: (instanceId: string, agentId: string, sessionToken?: string) => Extract<WSOutbound, { type: 'snapshot' }> | null
  // Drop sessions whose WS has been closed for more than SESSION_STALE_MS
  // and remove the corresponding human agent from the team. Without this,
  // every disconnected user accumulates a session entry forever (and an
  // inactive human in team.listAgents()) until the instance is evicted.
  // Returns the number of sessions dropped.
  readonly sweepStaleSessions: (now?: number) => number
}

// Resolver: given an instanceId, return the live System if currently in
// memory, or undefined. WSManager uses this to scope buildSnapshot/state
// subscriptions to the caller's tenant rather than closing over a single
// boot system. The shared Ollama gateway is the same across instances, so
// any live system's ollama field works (callers pass the resolved one in).
export interface WSManagerDeps {
  readonly getSystem: (instanceId: string) => System | undefined
  // Optional — when present, backpressure drops are counted. Tests omit.
  readonly limitMetrics?: LimitMetrics
}

export const createWSManager = (deps: WSManagerDeps): WSManager => {
  const { getSystem, limitMetrics } = deps
  const sessions = new Map<string, ClientSession>()
  const wsConnections = new Map<string, WSConnection>()
  const stateUnsubs = new Map<string, () => void>()

  // Single backpressure-checking send. If the kernel send buffer holds more
  // than MAX_WS_BUFFERED_BYTES the consumer is too slow — close the socket
  // (1009) and let the client reconnect. Server state is authoritative;
  // the next snapshot brings them back to current.
  const safeSend = (ws: WSConnection, data: string): boolean => {
    let buffered = 0
    try { buffered = ws.getBufferedAmount() } catch { /* mock without method */ }
    if (buffered > MAX_WS_BUFFERED_BYTES) {
      limitMetrics?.inc('wsBackpressureDropped')
      try { ws.close(1009, 'slow consumer') } catch { /* already closed */ }
      return false
    }
    try { ws.send(data); return true } catch { return false }
  }

  const broadcast = (msg: WSOutbound): void => {
    const data = JSON.stringify(msg)
    for (const ws of wsConnections.values()) {
      safeSend(ws, data)
    }
  }

  // Per-instance broadcast — filters wsConnections by session.instanceId
  // so events fired in one tenant don't reach another tenant's clients.
  const broadcastToInstance = (instanceId: string, msg: WSOutbound): void => {
    const data = JSON.stringify(msg)
    for (const [token, session] of sessions) {
      if (session.instanceId !== instanceId) continue
      const ws = wsConnections.get(token)
      if (!ws) continue
      safeSend(ws, data)
    }
  }

  // System callback wiring (room/membership/agent-activity/provider-events/
  // summary lifecycle/ollama-health) lives in src/api/wire-system-events.ts.
  // Ollama metrics are pulled by the dashboard via GET /api/ollama/metrics
  // (3s polling) — no WS push path.

  const subscribeAgentState = (agent: Agent, instanceId: string): void => {
    if (agent.kind !== 'ai') return
    if (stateUnsubs.has(agent.id)) return
    const agentName = agent.name
    const unsub = agent.state.subscribe((state: StateValue, _agentId: string, context?: string) => {
      broadcastToInstance(instanceId, { type: 'agent_state', agentName, state, context })
    })
    stateUnsubs.set(agent.id, unsub)
  }

  const unsubscribeAgentState = (agentId: string): void => {
    const unsub = stateUnsubs.get(agentId)
    if (unsub) {
      unsub()
      stateUnsubs.delete(agentId)
    }
  }

  // Existing-agent subscription seeding moved into wireSystemEvents so
  // it runs at the right time (after the System is fully populated by
  // any snapshot restore). Single-tenant boot path calls wireSystemEvents
  // immediately after createWSManager, so behavior is preserved.

  const buildSnapshot = (instanceId: string, agentId: string, sessionToken?: string): Extract<WSOutbound, { type: 'snapshot' }> | null => {
    const sys = getSystem(instanceId)
    if (!sys) {
      // Instance evicted between WS upgrade and snapshot build. Returning
      // an empty shell would make the client trust a blank UI; instead we
      // return null and the caller closes the socket so the client
      // reconnects honestly through the registry's lazy-load path.
      console.error(`[ws] buildSnapshot for evicted instance ${instanceId} — caller will close socket (4001)`)
      void agentId; void sessionToken
      return null
    }
    const roomStates: Record<string, RoomState> = {}
    for (const profile of sys.house.listAllRooms()) {
      const room = sys.house.getRoom(profile.id)
      if (room) roomStates[profile.id] = room.getRoomState()
    }
    const agents: AgentProfile[] = sys.team.listAgents()
      .filter(a => !a.inactive)
      .map(a => {
        const ai = asAIAgent(a)
        const ctx = a.state.getContext()
        return { id: a.id, name: a.name, kind: a.kind, state: a.state.get(), ...(ctx ? { context: ctx } : {}), ...(ai ? { model: ai.getModel() } : {}) }
      })
    return {
      type: 'snapshot',
      rooms: sys.house.listAllRooms(),
      agents,
      agentId,
      roomStates,
      ...(sessionToken ? { sessionToken } : {}),
    }
  }

  const sweepStaleSessions = (now: number = Date.now()): number => {
    let dropped = 0
    const cutoff = now - SESSION_STALE_MS
    for (const [token, session] of [...sessions]) {
      // Skip live connections — their lastActivity is fresh anyway.
      if (wsConnections.has(token)) continue
      if (session.lastActivity > cutoff) continue
      // Remove the agent from its instance's team. If the instance is
      // currently evicted, getSystem returns undefined; skip the team
      // cleanup (the snapshot rehydrate path won't see this human). The
      // session entry is dropped either way.
      const sys = getSystem(session.instanceId)
      try { sys?.removeAgent(session.agent.id) } catch { /* best-effort */ }
      sessions.delete(token)
      limitMetrics?.inc('staleSessionsEvicted')
      dropped++
    }
    return dropped
  }

  return { sessions, wsConnections, safeSend, broadcast, broadcastToInstance, subscribeAgentState, unsubscribeAgentState, buildSnapshot, sweepStaleSessions }
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
  ws: WSConnection,
  session: ClientSession,
  raw: string,
  system: System,
  wsManager: WSManager,
): Promise<void> => {
  let msg: WSInbound
  try {
    msg = JSON.parse(raw) as WSInbound
  } catch {
    sendError(wsManager, ws, 'Invalid JSON')
    return
  }

  const ctx = { ws, session, system, broadcast: wsManager.broadcast, wsManager }

  try {
    for (const handler of commandHandlers) {
      if (await handler(msg, ctx)) return
    }
    sendError(wsManager, ws, `Unknown message type: ${(msg as Record<string, unknown>).type}`)
  } catch (err) {
    sendError(wsManager, ws, err instanceof Error ? err.message : 'Command failed')
  }
}
