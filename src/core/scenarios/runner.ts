// ============================================================================
// Scenario runner — lifecycle and queue. Op implementations live in ops.ts.
//
// Persistent-only lifecycle (v1): every setup op is idempotent.
// One run per instance at a time. Status transitions:
//
//   running ─┬─→ awaiting (guide-tooltip / guide-modal with waitFor)
//            │      └─→ running (advance / post / timer / stop)
//            ├─→ completed
//            ├─→ failed
//            └─→ stopped
//
// Timer hygiene: every setTimeout / setInterval the runner spawns is
// tracked in the per-runId timers map and cleared together on terminal
// status. Without this an awaiting run holds the System closure across
// instance eviction.
// ============================================================================

import type { System } from '../../main.ts'
import type { Scenario, ScenarioRun, RunOptions, GuideWait } from './types.ts'
import type { Message } from '../types/messaging.ts'
import type { ScenarioEventName, ScenarioEventEmitter } from './runner-types.ts'
import { executeOp, type OpContext } from './ops.ts'
import { arrangeExternalWait, type ExternalWaitArgs } from './waits.ts'

export type { ScenarioEventName, ScenarioEventEmitter } from './runner-types.ts'

export interface ScenarioRunner {
  readonly run: (scenario: Scenario, options?: RunOptions) => Promise<{ ok: boolean; runId?: string; reason?: string }>
  readonly stop: (runId: string) => { ok: boolean; reason?: string }
  readonly advance: (runId: string) => { ok: boolean; reason?: string }
  readonly getRun: (runId: string) => ScenarioRun | undefined
  readonly listRuns: () => ReadonlyArray<ScenarioRun>
  // Called by main.ts on every message-posted event so post-wait guides resolve.
  readonly onRoomMessage: (roomId: string, message: Message) => void
  // Stop and clear all runs — wired into instance eviction.
  readonly stopAll: () => void
}

export interface ScenarioRunnerDeps {
  readonly getSystem: () => System
  readonly emit?: ScenarioEventEmitter
}

const ABANDON_TIMEOUT_MS = 30 * 60_000   // 30 min — matches default instance idleMs
// Ended runs are kept briefly so /api/scenarios/runs/:runId reflects the
// terminal status to a client that only just received the WS event. After
// this the entry is dropped — without pruning the runs Map only ever grows.
const PRUNE_ENDED_AFTER_MS = 60_000

export const createScenarioRunner = (deps: ScenarioRunnerDeps): ScenarioRunner => {
  const { getSystem, emit } = deps
  const runs = new Map<string, ScenarioRun>()
  // runId → resolver to call when status leaves 'awaiting'.
  const awaitResolvers = new Map<string, () => void>()
  // runId → cleanup callbacks (one for each setTimeout/setInterval handle
  // AND for each external-wait arranger unsubscribe). Single cleanup
  // mechanism — eviction calls clearCleanups(runId) and every subscription
  // and timer goes away atomically. Without this, closures would pin the
  // runner across instance eviction.
  const cleanups = new Map<string, Array<() => void>>()

  const trackCleanup = (runId: string, fn: () => void): void => {
    const list = cleanups.get(runId) ?? []
    list.push(fn)
    cleanups.set(runId, list)
  }
  const trackTimer = (runId: string, handle: ReturnType<typeof setTimeout>): void => {
    trackCleanup(runId, () => clearTimeout(handle))
  }
  const clearCleanups = (runId: string): void => {
    const list = cleanups.get(runId)
    if (!list) return
    for (const fn of list) {
      try { fn() } catch (err) {
        console.error(`[scenarios] cleanup callback threw: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    cleanups.delete(runId)
  }

  const fire = (runId: string, event: ScenarioEventName, detail: Record<string, unknown>): void => {
    try { emit?.(runId, event, detail) } catch (err) {
      console.error(`[scenarios] emit ${event} threw: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // --- One run at a time per instance (v1) ---
  // Multiple concurrent scenarios in one instance would interleave guide
  // overlays and confuse the UI. Reject with a clear reason; caller stops
  // the prior run first.
  const hasActiveRun = (): boolean => {
    for (const r of runs.values()) {
      if (r.status === 'running' || r.status === 'awaiting') return true
    }
    return false
  }

  const armAbandonTimer = (runId: string): void => {
    const t = setTimeout(() => {
      const r = runs.get(runId)
      if (!r || r.status !== 'awaiting') return
      console.warn(`[scenarios] run ${runId} abandoned after ${ABANDON_TIMEOUT_MS}ms — stopping`)
      finishRun(r, 'stopped', 'abandoned')
    }, ABANDON_TIMEOUT_MS)
    trackTimer(runId, t)
  }

  const finishRun = (r: ScenarioRun, status: 'completed' | 'failed' | 'stopped', reason?: string): void => {
    r.status = status
    r.endedAt = Date.now()
    if (reason && status === 'failed') r.failureReason = reason
    clearCleanups(r.runId)
    const resolver = awaitResolvers.get(r.runId)
    if (resolver) { awaitResolvers.delete(r.runId); resolver() }
    if (status === 'completed') fire(r.runId, 'scenario_completed', {})
    else if (status === 'failed') fire(r.runId, 'scenario_failed', { reason: reason ?? 'unknown' })
    else fire(r.runId, 'scenario_stopped', {})
    // Prune so the runs Map doesn't grow unbounded over a long-lived
    // instance. The entry stays around briefly so a client polling
    // immediately after the terminal WS event still sees the final state.
    const pruneTimer = setTimeout(() => { runs.delete(r.runId) }, PRUNE_ENDED_AFTER_MS)
    trackTimer(r.runId, pruneTimer)
  }

  // Guide-op waits — covers click / post / timer attached to guide-tooltip
  // or guide-modal. `click` is resolved by the runner's advance() API;
  // `post` is resolved by onRoomMessage (both runner-internal). `timer`
  // routes through the same external arranger as the standalone `wait` op
  // for consistency.
  const arrangeWait = (state: ScenarioRun, waitFor: GuideWait): Promise<void> => {
    state.status = 'awaiting'
    state.awaitingWait = waitFor
    armAbandonTimer(state.runId)
    if (waitFor.type === 'timer') {
      const unsub = arrangeExternalWait(
        { type: 'timer', seconds: waitFor.seconds },
        {
          state,
          system: getSystem(),
          resolve: () => resumeFromWait(state.runId),
          trackTimer: (h) => trackTimer(state.runId, h),
        },
      )
      trackCleanup(state.runId, unsub)
    }
    // The actual wait happens in the run loop's `await new Promise(...)`
    // which closes over the awaitResolvers map; this function only sets up
    // the conditions that allow that resolver to fire.
    return Promise.resolve()
  }

  // External-source wait — used by the standalone `wait` op and (after
  // refactor) the `start-script` op. `awaitingWait` is left unset because
  // these waits don't get resolved by the runner's onRoomMessage / advance
  // paths — the external arranger calls resolve() directly.
  const arrangeExternal = (state: ScenarioRun, args: ExternalWaitArgs): Promise<void> => {
    state.status = 'awaiting'
    armAbandonTimer(state.runId)
    const unsub = arrangeExternalWait(args, {
      state,
      system: getSystem(),
      resolve: () => resumeFromWait(state.runId),
      trackTimer: (h) => trackTimer(state.runId, h),
    })
    trackCleanup(state.runId, unsub)
    return Promise.resolve()
  }

  const resumeFromWait = (runId: string): void => {
    const r = runs.get(runId)
    if (!r || r.status !== 'awaiting') return
    delete r.awaitingWait
    // Cancel the abandon + any timer-wait setTimeout for this run; the
    // resolver path doesn't need them to fire and they'd otherwise sit until
    // the 30 min ABANDON_TIMEOUT or the timer-wait `seconds` expired.
    clearCleanups(runId)
    const resolver = awaitResolvers.get(runId)
    if (resolver) { awaitResolvers.delete(runId); resolver() }
  }

  const buildOpContext = (state: ScenarioRun, options: RunOptions): OpContext => ({
    system: getSystem(),
    state,
    options,
    arrangeWait: (waitFor) => arrangeWait(state, waitFor),
    arrangeExternal: (args) => arrangeExternal(state, args),
    trackTimer: (handle) => trackTimer(state.runId, handle),
    trackCleanup: (fn) => trackCleanup(state.runId, fn),
    fire: (event, detail) => fire(state.runId, event, detail),
  })

  const run = async (scenario: Scenario, options: RunOptions = {}): Promise<{ ok: boolean; runId?: string; reason?: string }> => {
    if (hasActiveRun()) {
      return { ok: false, reason: 'another scenario is running in this instance — stop it first' }
    }
    const runId = crypto.randomUUID()
    const state: ScenarioRun = {
      runId,
      scenarioId: scenario.id,
      title: scenario.title,
      status: 'running',
      currentOpIndex: 0,
      totalOps: scenario.ops.length,
      startedAt: Date.now(),
      lastTouchedAt: Date.now(),
    }
    runs.set(runId, state)
    fire(runId, 'scenario_started', {
      scenarioId: scenario.id,
      title: scenario.title,
      totalOps: scenario.ops.length,
    })

    // Async loop. Driven by state.currentOpIndex so branching ops can mutate
    // the index in place (Phase C of audit work). Default progression:
    // increment by 1 after each op.
    //
    // Cycle detector: track per-op visit counts. If any single op is
    // visited 3+ times, abort with a clear reason. This bounds branching
    // loops without a magic-number "max jumps" cap. Threshold of 3 lets
    // a branch op fall back legitimately one extra time after a prior
    // visit (e.g. branch fired, fallback took us away, branch fired again
    // because the LLM still says go-back).
    const MAX_VISITS_PER_OP = 3
    void (async () => {
      const ctx = buildOpContext(state, options)
      const visitCounts = new Map<number, number>()
      try {
        while (state.currentOpIndex < scenario.ops.length) {
          const s1 = state.status as string
          if (s1 === 'stopped' || s1 === 'failed') return
          const i = state.currentOpIndex
          const visits = (visitCounts.get(i) ?? 0) + 1
          visitCounts.set(i, visits)
          if (visits > MAX_VISITS_PER_OP) {
            finishRun(state, 'failed',
              `cycle detected at op index ${i} (visited ${visits} times); raise MAX_VISITS_PER_OP if this is legitimate replay`)
            return
          }
          state.lastTouchedAt = Date.now()
          const op = scenario.ops[i]!
          // Snapshot the index before executeOp so we can detect a branch
          // op that mutated state.currentOpIndex during execution.
          const indexBeforeExec = state.currentOpIndex
          await executeOp(op, ctx)
          fire(runId, 'scenario_op_executed', { opIndex: i, kind: op.kind })
          if ((state.status as string) === 'awaiting') {
            await new Promise<void>(res => awaitResolvers.set(runId, res))
            const s2 = state.status as string
            if (s2 === 'stopped' || s2 === 'failed') return
            state.status = 'running'
          }
          // If the op didn't explicitly jump (most ops don't), advance
          // sequentially. A branching op sets state.currentOpIndex to the
          // target; we leave it alone in that case.
          if (state.currentOpIndex === indexBeforeExec) {
            state.currentOpIndex = i + 1
          }
        }
        finishRun(state, 'completed')
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        finishRun(state, 'failed', reason)
      }
    })()

    return { ok: true, runId }
  }

  // === Public surface ===

  const stop = (runId: string): { ok: boolean; reason?: string } => {
    const r = runs.get(runId)
    if (!r) return { ok: false, reason: `run ${runId} not found` }
    if (r.status === 'completed' || r.status === 'failed' || r.status === 'stopped') {
      return { ok: false, reason: `run ${runId} already ended (${r.status})` }
    }
    finishRun(r, 'stopped')
    return { ok: true }
  }

  const advance = (runId: string): { ok: boolean; reason?: string } => {
    const r = runs.get(runId)
    if (!r) return { ok: false, reason: `run ${runId} not found` }
    if (r.status !== 'awaiting') {
      return { ok: false, reason: `run ${runId} is not awaiting (status=${r.status})` }
    }
    resumeFromWait(runId)
    return { ok: true }
  }

  const getRun = (runId: string): ScenarioRun | undefined => runs.get(runId)
  const listRuns = (): ReadonlyArray<ScenarioRun> => [...runs.values()]

  const onRoomMessage = (roomId: string, _message: Message): void => {
    // Resume any 'post'-wait whose room matches this one.
    for (const r of runs.values()) {
      if (r.status !== 'awaiting' || !r.awaitingWait) continue
      if (r.awaitingWait.type !== 'post') continue
      const room = getSystem().house.getRoom(r.awaitingWait.room)
      if (!room) continue
      if (room.profile.id === roomId) resumeFromWait(r.runId)
    }
  }

  const stopAll = (): void => {
    for (const r of runs.values()) {
      if (r.status === 'running' || r.status === 'awaiting') {
        finishRun(r, 'stopped')
      }
    }
  }

  return { run, stop, advance, getRun, listRuns, onRoomMessage, stopAll }
}
