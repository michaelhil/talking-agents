// ============================================================================
// Triggers — per-agent scheduled prompts.
//
// Each trigger fires every `intervalSec` and either:
//   - mode='execute' (AI only): runs the prompt as a transient trailing user
//     message in a normal eval; the response posts to `roomId`. action='pass'
//     suppresses posting (handles "report only changes" cleanly).
//   - mode='post' (AI or human): posts the prompt verbatim to `roomId` as the
//     agent. Acts as a verbal trigger — other agents respond as usual.
//
// Storage: lives on the agent (AIAgent.triggers, HumanAgent.triggers).
// Pinned to a single roomId; cascade-deleted when the room is removed.
// `lastFiredAt` mutates on each fire and rides the existing snapshot debounce.
// ============================================================================

export type TriggerMode = 'execute' | 'post'

export interface Trigger {
  readonly id: string                  // crypto.randomUUID()
  readonly name: string                // human-readable label
  readonly prompt: string              // verbal text; user message in execute mode
  readonly mode: TriggerMode           // forced 'post' for human agents
  readonly intervalSec: number         // bounded [60, 86400]
  readonly enabled: boolean
  readonly roomId: string              // pinned target; cascade-cleaned on room delete
  readonly lastFiredAt?: number        // epoch ms; persists across restart
}

// Bounds. 60s minimum prevents runaway spam; 24h maximum keeps the UI's
// minutes/hours unit dropdown sensible. Picked to match the documented user
// expectation in the modal copy.
export const MIN_INTERVAL_SEC = 60
export const MAX_INTERVAL_SEC = 86400

// Validation for incoming REST/UI bodies. Pure: returns null on success or
// the first error string. Mirrors server-side enforcement; UI uses this for
// pre-flight validation so bad input never hits the wire.
export interface TriggerInput {
  readonly name?: unknown
  readonly prompt?: unknown
  readonly mode?: unknown
  readonly intervalSec?: unknown
  readonly enabled?: unknown
  readonly roomId?: unknown
}

export const validateTriggerInput = (input: TriggerInput, agentKind: 'ai' | 'human'): string | null => {
  if (typeof input.name !== 'string' || input.name.trim() === '') return 'name is required'
  if (typeof input.prompt !== 'string' || input.prompt.trim() === '') return 'prompt is required'
  if (typeof input.roomId !== 'string' || input.roomId.trim() === '') return 'roomId is required'
  if (typeof input.intervalSec !== 'number' || !Number.isFinite(input.intervalSec)) return 'intervalSec must be a number'
  if (input.intervalSec < MIN_INTERVAL_SEC || input.intervalSec > MAX_INTERVAL_SEC) {
    return `intervalSec must be between ${MIN_INTERVAL_SEC} and ${MAX_INTERVAL_SEC}`
  }
  if (input.mode !== 'execute' && input.mode !== 'post') return `mode must be 'execute' or 'post'`
  if (agentKind === 'human' && input.mode === 'execute') return `human agents cannot use mode 'execute'`
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') return 'enabled must be a boolean'
  return null
}

// Compute which (agentId, triggerId) pairs are due to fire at `now`.
// Pure: takes a snapshot of agents + their triggers + busy state, returns the
// fire list. The scheduler tick uses this; tests exercise it directly.
//
// "Due" iff: enabled AND `(lastFiredAt ?? 0) + intervalSec*1000 <= now` AND
// the agent isn't busy. For agents without a concurrency manager (humans),
// `isBusy` should be `false`. Caller is responsible for setting `lastFiredAt`
// before dispatching to prevent overrun double-fires.
export interface AgentTriggerSnapshot {
  readonly agentId: string
  readonly isBusy: boolean
  readonly triggers: ReadonlyArray<Trigger>
}

export const computeDueTriggers = (
  agents: ReadonlyArray<AgentTriggerSnapshot>,
  now: number,
): ReadonlyArray<{ readonly agentId: string; readonly triggerId: string }> => {
  const out: Array<{ agentId: string; triggerId: string }> = []
  for (const a of agents) {
    if (a.isBusy) continue
    for (const t of a.triggers) {
      if (!t.enabled) continue
      const nextFireAt = (t.lastFiredAt ?? 0) + t.intervalSec * 1000
      if (nextFireAt <= now) out.push({ agentId: a.agentId, triggerId: t.id })
    }
  }
  return out
}
