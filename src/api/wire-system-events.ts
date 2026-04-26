// ============================================================================
// wireSystemEvents — single source of truth for connecting a System's
// per-tenant event slots to the WS broadcast layer + the autosaver.
//
// Lives at the boundary between the multi-tenant registry and the WS
// transport. Called once per System (at construction time today; per
// `onSystemCreated` hook of SystemRegistry once Phase F4 lands).
//
// What it wires:
//   - 25 system callback slots that previously lived in server.ts and
//     ws-handler.ts. They now broadcast scoped to the originating
//     instance via wsManager.broadcastToInstance(instanceId, msg).
//   - Auto-save scheduling on every state-mutating callback.
//
// Why it's here:
//   - Keeps server.ts a pure HTTP/WS transport orchestrator.
//   - Keeps ws-handler.ts focused on connection state + buildSnapshot.
//   - Single edit site when adding a new system event kind.
//   - Phase F4 hooks this into registry.onSystemCreated so each lazy-
//     loaded System gets the same wiring without ad-hoc setup code.
// ============================================================================

import type { System } from '../main.ts'
import type { AutoSaver } from '../core/snapshot.ts'
import type { WSManager } from './ws-handler.ts'
import { asAIAgent } from '../agents/shared.ts'

export const wireSystemEvents = (
  system: System,
  wsManager: WSManager,
  autoSaver: AutoSaver,
  instanceId: string,
): void => {
  const sched = (): void => autoSaver.scheduleSave()
  const broadcast = (msg: Parameters<WSManager['broadcast']>[0]): void => {
    wsManager.broadcastToInstance(instanceId, msg)
  }

  // Helper resolvers for room/agent name lookup (tolerate missing entities).
  const roomNameFor = (roomId: string): string =>
    system.house.getRoom(roomId)?.profile.name ?? roomId
  const agentNameFor = (agentId: string | null | undefined): string | undefined =>
    typeof agentId === 'string' ? system.team.getAgent(agentId)?.name : undefined

  // === Mutating callbacks → broadcast + schedule save ===

  system.setOnMessagePosted((_roomId, message) => {
    broadcast({ type: 'message', message })
    sched()
  })

  system.setOnDeliveryModeChanged((roomId, mode) => {
    const room = system.house.getRoom(roomId)
    broadcast({
      type: 'delivery_mode_changed',
      roomName: roomNameFor(roomId),
      mode,
      paused: room?.paused ?? false,
    })
    sched()
  })

  system.setOnArtifactChanged((action, artifact) => {
    broadcast({ type: 'artifact_changed', action, artifact })
    sched()
  })

  // Bookmarks: REST-driven, no WS broadcast (single-user surface; UI refetches).
  system.setOnBookmarksChanged(() => { sched() })

  // === Non-mutating callbacks → broadcast only ===

  system.setOnTurnChanged((roomId, agentId, waitingForHuman) => {
    broadcast({
      type: 'turn_changed',
      roomName: roomNameFor(roomId),
      agentName: agentNameFor(agentId),
      waitingForHuman,
    })
  })

  system.setOnModeAutoSwitched((roomId, toMode, reason) => {
    broadcast({
      type: 'mode_auto_switched',
      roomName: roomNameFor(roomId),
      toMode,
      reason,
    })
  })

  system.setOnRoomCreated((profile) => {
    broadcast({ type: 'room_created', profile })
    sched()
  })

  system.setOnRoomDeleted((_roomId, roomName) => {
    broadcast({ type: 'room_deleted', roomName })
    sched()
  })

  system.setOnMembershipChanged((roomId, roomName, agentId, agentName, action) => {
    broadcast({ type: 'membership_changed', roomId, roomName, agentId, agentName, action })
    sched()
  })

  system.setOnEvalEvent((agentName, event) => {
    broadcast({ type: 'agent_activity', agentName, event })
  })

  // === Provider routing events → toasts ===
  // The shared router fires routing events with an agentId; the registry's
  // reverse index resolves agentId → instanceId in setProviderEventDispatcher,
  // and the per-instance System's late-bound setOnProvider* slots receive
  // them and re-broadcast scoped to the originating instance.

  system.setOnProviderBound((agentId, model, oldProvider, newProvider) => {
    broadcast({
      type: 'provider_bound',
      agentId,
      agentName: agentNameFor(agentId) ?? null,
      model, oldProvider, newProvider,
    })
  })

  system.setOnProviderAllFailed((agentId, model, attempts) => {
    broadcast({
      type: 'provider_all_failed',
      agentId,
      agentName: agentNameFor(agentId) ?? null,
      model, attempts,
    })
  })

  system.setOnProviderStreamFailed((agentId, model, provider, reason) => {
    broadcast({
      type: 'provider_stream_failed',
      agentId,
      agentName: agentNameFor(agentId) ?? null,
      model, provider, reason,
    })
  })

  // === Summary + compression ===

  system.setOnSummaryConfigChanged((roomId, config) => {
    const roomName = system.house.getRoom(roomId)?.profile.name
    if (!roomName) return
    broadcast({ type: 'summary_config_changed', roomName, config })
    sched()
  })
  system.setOnSummaryRunStarted((roomId, target) => {
    const roomName = system.house.getRoom(roomId)?.profile.name
    if (!roomName) return
    broadcast({ type: 'summary_run_started', roomName, target })
  })
  system.setOnSummaryRunDelta((roomId, target, delta) => {
    const roomName = system.house.getRoom(roomId)?.profile.name
    if (!roomName) return
    broadcast({ type: 'summary_run_delta', roomName, target, delta })
  })
  system.setOnSummaryRunCompleted((roomId, target, text) => {
    const roomName = system.house.getRoom(roomId)?.profile.name
    if (!roomName) return
    broadcast({ type: 'summary_run_completed', roomName, target, text })
  })
  system.setOnSummaryRunFailed((roomId, target, reason) => {
    const roomName = system.house.getRoom(roomId)?.profile.name
    if (!roomName) return
    broadcast({ type: 'summary_run_failed', roomName, target, reason })
  })

  // === Ollama gateway health (shared across instances; broadcast unscoped) ===
  // Note: ollama gateway is a shared resource (created in SharedRuntime once).
  // Health changes go to ALL connected clients regardless of instance —
  // that matches the underlying state (one gateway, one health value).
  system.ollama?.onHealthChange((health) => {
    wsManager.broadcast({ type: 'ollama_health', health })
  })

  // === Existing AI agent state subscriptions — populate at wire time ===
  // After wiring, subscribe each existing AI agent so the UI sees state
  // changes scoped to this instance.
  for (const agent of system.team.listAgents()) {
    if (agent.kind === 'ai') wsManager.subscribeAgentState(agent, instanceId)
  }
  // (asAIAgent is imported for future use by other extracted blocks.)
  void asAIAgent
}
