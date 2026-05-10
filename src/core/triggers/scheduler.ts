// ============================================================================
// Trigger scheduler — single setInterval coarse poll over all agents/triggers.
//
// Rationale (see plan): one timer for the whole instance. Per-tick: walk each
// agent → walk its enabled triggers → fire those whose
// `(lastFiredAt ?? 0) + intervalSec*1000 <= now` AND agent is not busy.
// `lastFiredAt` is set BEFORE dispatch (overrun protection — a slow eval
// won't get re-fired the next tick).
//
// Three minimisation levers built in:
//   1. Early-return when no agent has any enabled triggers (cached flag).
//   2. The setInterval is stopped entirely when the count drops to zero and
//      restarted on first add. Idle instances pay zero scheduler cost.
//   3. First-fire stagger: when invalidating the cache (after add/load), any
//      trigger with `lastFiredAt` undefined gets it set to bootTime so the
//      first eval lands at `bootTime + intervalSec`, not immediately.
//      Prevents thundering-herd at boot when N triggers all default-fire.
// ============================================================================

import type { Agent, Team } from '../types/agent.ts'
import type { House } from '../types/room.ts'
import { asAIAgent } from '../../agents/shared.ts'
import { computeDueTriggers, type AgentTriggerSnapshot } from './types.ts'

const TICK_MS = 5_000

export interface TriggerScheduler {
  // Call after add/update/delete to refresh the "any triggers exist" cache and
  // start/stop the timer accordingly. Idempotent.
  readonly invalidate: () => void
  readonly stop: () => void
  // For testing: force one tick immediately. Returns the fire list.
  readonly tickNow: () => Promise<ReadonlyArray<{ readonly agentId: string; readonly triggerId: string }>>
}

export interface SchedulerDeps {
  readonly team: Team
  readonly house: House
  // Now-source. Defaults to Date.now; tests inject a fake clock.
  readonly now?: () => number
  // Optional: callback after a trigger is dispatched. Tests use it as a
  // signal; production might surface a "trigger fired" log line. Best-effort.
  readonly onFired?: (agentId: string, triggerId: string) => void
  // Narrow capabilities for the start-script / start-scenario trigger modes.
  // Wired in main.ts where scriptRunner + scenarioRunner exist. Optional so
  // tests + headless boots that never use these modes can omit them.
  readonly startScript?: (roomId: string, name: string) => Promise<{ ok: boolean; reason?: string }>
  readonly startScenario?: (name: string) => Promise<{ ok: boolean; reason?: string }>
  readonly isScriptRunningInRoom?: (roomId: string) => boolean
  readonly isScenarioRunning?: () => boolean
}

export const createTriggerScheduler = (deps: SchedulerDeps): TriggerScheduler => {
  const now = deps.now ?? Date.now
  let timer: ReturnType<typeof setInterval> | null = null
  // Lever 1: cached flag. Recomputed by invalidate(). Tick early-returns
  // when false. Cheap because invalidate runs O(agents × triggers) on a
  // mutation event, not every tick.
  let anyTriggers = false

  // Lever 3: stagger first-fire by setting `lastFiredAt = now()` for any
  // trigger that has no timestamp yet. This works for both boot-loaded
  // triggers (set the moment the scheduler boots) AND runtime-added
  // triggers (set the moment invalidate runs after the add). Without this,
  // a trigger added at runtime would fire immediately on the next tick
  // because lastFiredAt=undefined → 0 → already overdue. Idempotent: only
  // triggers with undefined lastFiredAt get touched.
  const stagger = (agent: Agent): void => {
    const triggers = agent.getTriggers?.() ?? []
    for (const t of triggers) {
      if (t.lastFiredAt === undefined) {
        agent.markTriggerFired?.(t.id, now())
      }
    }
  }

  const recomputeAnyTriggers = (): boolean => {
    for (const agent of deps.team.listAgents()) {
      const triggers = agent.getTriggers?.() ?? []
      for (const t of triggers) {
        if (t.enabled) return true
      }
    }
    return false
  }

  const buildSnapshots = (): ReadonlyArray<AgentTriggerSnapshot> => {
    const out: AgentTriggerSnapshot[] = []
    for (const agent of deps.team.listAgents()) {
      const triggers = agent.getTriggers?.()
      if (!triggers || triggers.length === 0) continue
      // For AI agents, busy = currently generating. Humans never have an
      // eval; their post-mode dispatch is synchronous via room.post.
      const isBusy = agent.kind === 'ai' ? agent.state.get() === 'generating' : false
      out.push({ agentId: agent.id, isBusy, triggers })
    }
    return out
  }

  const dispatch = (agentId: string, triggerId: string): void => {
    const agent = deps.team.getAgent(agentId)
    if (!agent) return
    const trigger = agent.getTriggers?.().find(t => t.id === triggerId)
    if (!trigger) return
    const room = deps.house.getRoom(trigger.roomId)
    if (!room) return  // Skip silently — room deletion between tick and dispatch is a normal race; cascade-clean in room-operations.ts:65-71 deletes orphaned triggers on the same path.

    // Per-mode busy gate. Skip without marking lastFiredAt so the trigger
    // re-evaluates next tick (target frees up → trigger fires).
    if (trigger.mode === 'start-script' && deps.isScriptRunningInRoom?.(trigger.roomId)) return
    if (trigger.mode === 'start-scenario' && deps.isScenarioRunning?.()) return

    // Mark fired BEFORE dispatch (overrun protection).
    agent.markTriggerFired?.(triggerId, now())

    if (trigger.mode === 'post') {
      try {
        room.post({
          senderId: agent.id,
          senderName: agent.name,
          content: trigger.prompt,
          type: 'chat',
          cause: { kind: 'trigger', name: trigger.name },
        })
      } catch (err) {
        console.error(`[trigger ${trigger.name}] post failed:`, err)
      }
    } else if (trigger.mode === 'execute' && agent.kind === 'ai') {
      const ai = asAIAgent(agent)
      ai?.fireTriggerExecute?.(trigger.prompt, trigger.roomId)
        .catch(err => console.error(`[trigger ${trigger.name}] execute failed:`, err))
    } else if (trigger.mode === 'start-script') {
      const target = trigger.targetName
      if (!target) return
      deps.startScript?.(trigger.roomId, target)
        .then(r => { if (!r.ok) console.warn(`[trigger ${trigger.name}] start-script "${target}" failed: ${r.reason ?? ''}`) })
        .catch(err => console.error(`[trigger ${trigger.name}] start-script threw:`, err))
    } else if (trigger.mode === 'start-scenario') {
      const target = trigger.targetName
      if (!target) return
      deps.startScenario?.(target)
        .then(r => { if (!r.ok) console.warn(`[trigger ${trigger.name}] start-scenario "${target}" failed: ${r.reason ?? ''}`) })
        .catch(err => console.error(`[trigger ${trigger.name}] start-scenario threw:`, err))
    }
    deps.onFired?.(agentId, triggerId)
  }

  const tick = async (): Promise<ReadonlyArray<{ agentId: string; triggerId: string }>> => {
    // Lever 1: early-return when nothing's configured.
    if (!anyTriggers) return []
    const due = computeDueTriggers(buildSnapshots(), now())
    for (const { agentId, triggerId } of due) {
      dispatch(agentId, triggerId)
    }
    return due
  }

  const start = (): void => {
    if (timer) return
    timer = setInterval(() => { void tick() }, TICK_MS)
  }

  const stop = (): void => {
    if (!timer) return
    clearInterval(timer)
    timer = null
  }

  const invalidate = (): void => {
    // Stagger any unstaggered triggers (lever 3). Runs over all agents but
    // is idempotent — only mutates triggers with undefined lastFiredAt.
    for (const agent of deps.team.listAgents()) stagger(agent)
    anyTriggers = recomputeAnyTriggers()
    // Lever 2: stop the timer when not needed; restart on first trigger.
    if (anyTriggers) start()
    else stop()
  }

  // Boot: compute initial state and start (or not).
  invalidate()

  return {
    invalidate,
    stop,
    tickNow: tick,
  }
}
