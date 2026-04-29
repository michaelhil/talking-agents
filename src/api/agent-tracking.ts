// ============================================================================
// Per-agent lifecycle wiring — the single source of truth for what happens
// when an agent enters or leaves the system.
//
// Wraps system.spawnAIAgent / spawnHumanAgent / removeAgent so every agent
// that enters the system gets the per-agent hooks installed in ONE place.
// Do NOT subscribe ad-hoc from REST/WS handlers — they go through spawn,
// which goes through here.
//
// Per-agent hooks (each must be idempotent so this wrapper can co-exist with
// the snapshot-restore init-loop in wireSystemEvents):
//   1. attachAgent(agentId, instanceId)
//        — registry's reverse index for provider-routing events.
//   2. wsManager.subscribeAgentState(agent, instanceId)
//        — turns agent.state.notifyState() into a scoped `agent_state` WS
//          broadcast. Without it, the UI's $agents store never sees the
//          'generating' transition, no thinking indicator appears, and
//          `agent_activity` chunk events arrive at a connected client with
//          nowhere to render.
//
// Bug class this prevents: a previous regression silently dropped state
// events for SEED-spawned and SCRIPT-spawned agents because the only callers
// of subscribeAgentState lived in REST/WS create handlers + a one-shot
// init-loop in wireSystemEvents. Adding a new agent-creation entry point
// (e.g. seedFreshInstance) bypassed both. Centralizing here makes the
// invariant impossible to miss: every spawn goes through this wrapper.
//
// Bun JS is single-threaded; mutating system function references via
// Object.assign at construction time is safe before any agents spawn.
// ============================================================================

import type { Agent } from '../core/types/agent.ts'
import type { System } from '../main.ts'

export interface AgentTrackingDeps {
  readonly attach: (agentId: string, instanceId: string) => void
  readonly detach: (agentId: string) => void
  readonly subscribeAgentState: (agent: Agent, instanceId: string) => void
  readonly unsubscribeAgentState: (agentId: string) => void
}

export const wireAgentTracking = (
  system: System,
  instanceId: string,
  deps: AgentTrackingDeps,
): void => {
  const { attach, detach, subscribeAgentState, unsubscribeAgentState } = deps
  const origSpawnAI = system.spawnAIAgent
  const origSpawnHuman = system.spawnHumanAgent
  const origRemove = system.removeAgent
  Object.assign(system, {
    spawnAIAgent: async (cfg: Parameters<typeof origSpawnAI>[0], opts?: Parameters<typeof origSpawnAI>[1]) => {
      const agent = await origSpawnAI(cfg, opts)
      attach(agent.id, instanceId)
      subscribeAgentState(agent, instanceId)
      return agent
    },
    spawnHumanAgent: async (cfg: Parameters<typeof origSpawnHuman>[0], send: Parameters<typeof origSpawnHuman>[1]) => {
      const agent = await origSpawnHuman(cfg, send)
      attach(agent.id, instanceId)
      // Humans don't have AI state, but subscribeAgentState early-returns
      // for kind !== 'ai'. Calling it keeps the per-spawn surface uniform.
      subscribeAgentState(agent, instanceId)
      return agent
    },
    removeAgent: (id: string) => {
      const ok = origRemove(id)
      if (ok) {
        detach(id)
        unsubscribeAgentState(id)
      }
      return ok
    },
  })
}
