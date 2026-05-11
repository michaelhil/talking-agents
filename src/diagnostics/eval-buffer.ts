// Per-instance ring buffer of recent agent evals — the post-hoc trace
// store behind /api/diagnostics/evals/*.
//
// Subscribes to the existing onEvalEvent stream and assembles per-eval
// records keyed by traceId. A record opens on the first event for a
// traceId and closes on `eval_completed`. Closed records sit in a FIFO
// ring; the oldest evicts on overflow.
//
// Why a ring (not unbounded): a busy instance produces hundreds of evals
// per session. The diagnostic value is "what just happened" — 50 evals
// covers any reasonable post-mortem window without unbounded memory.
//
// Why per-instance (not process-wide): each cookie-bound System has its
// own agents and rooms; cross-tenant trace bleed would be confusing
// (and a soft privacy leak). One ring per System matches every other
// per-instance store.

import type { EvalEvent, OnEvalEvent } from '../core/types/agent-eval.ts'

export interface ToolCallTrace {
  readonly tool: string
  readonly callId: string
  readonly success?: boolean
  readonly preview?: string
}

export interface EvalRecord {
  readonly traceId: string
  readonly agentName: string
  readonly startedAt: number
  endedAt?: number
  // Model selected for this eval (from context_ready). Carried through
  // even on model_fallback so we record the effective model.
  model?: string
  temperature?: number
  toolCount?: number
  // Toolnames sent to the LLM at eval-start time. Empty array when
  // includeTools is false. Captured by the surface introspection
  // companion module (separate from EvalEvent so the wire shape stays
  // small for chunk-heavy events).
  toolNames?: ReadonlyArray<string>
  toolCalls: ToolCallTrace[]
  warnings: string[]
  modelFallback?: { preferred: string; effective: string; reason: string }
  outcome?: 'respond' | 'pass' | 'error'
  // Conversation snapshot the agent saw — copied from context_ready.
  // Kept on the record so /api/diagnostics/evals/:traceId is a single
  // GET and not a join across event-by-event WS frames.
  messages?: ReadonlyArray<{ readonly role: string; readonly content: string }>
}

export interface EvalBuffer {
  // Subscribe to a system's multi-subscriber eval-event channel. The
  // wire-system-events broadcaster owns setOnEvalEvent (single slot);
  // the ring buffer attaches via the additional listener slot so both
  // can coexist. Returns an unsubscribe.
  readonly attach: (addListener: (cb: OnEvalEvent) => () => void) => () => void
  // Out-of-band attachment: some flows (the surface endpoint) want to
  // enrich the in-flight record with tool names captured at eval-start
  // time. Idempotent — last write wins.
  readonly setToolNames: (traceId: string, toolNames: ReadonlyArray<string>) => void
  // Read API used by /api/diagnostics/evals/*.
  readonly listRecent: (opts?: { limit?: number; agent?: string }) => ReadonlyArray<EvalRecord>
  readonly getByTraceId: (traceId: string) => EvalRecord | null
  readonly clear: () => void
}

const DEFAULT_CAPACITY = 50

export interface EvalBufferConfig {
  // Override the FIFO size. Tests use small values; production sticks
  // with the default.
  readonly capacity?: number
}

export const createEvalBuffer = (config: EvalBufferConfig = {}): EvalBuffer => {
  const capacity = config.capacity ?? DEFAULT_CAPACITY
  // Open records keyed by traceId; closed records evicted into the ring.
  const open = new Map<string, EvalRecord>()
  // FIFO of closed records. Newest at index 0 so listRecent's first
  // slice is O(limit).
  const closed: EvalRecord[] = []

  const closeRecord = (rec: EvalRecord, outcome: EvalRecord['outcome']): void => {
    rec.endedAt = Date.now()
    rec.outcome = outcome
    open.delete(rec.traceId)
    closed.unshift(rec)
    if (closed.length > capacity) closed.length = capacity
  }

  const handle = (agentName: string, event: EvalEvent): void => {
    const tid = event.traceId
    if (!tid) return
    let rec = open.get(tid)
    if (!rec) {
      rec = { traceId: tid, agentName, startedAt: Date.now(), toolCalls: [], warnings: [] }
      open.set(tid, rec)
    }
    switch (event.kind) {
      case 'context_ready':
        rec.model = event.model
        rec.temperature = event.temperature
        rec.toolCount = event.toolCount
        rec.messages = event.messages
        return
      case 'tool_start':
        rec.toolCalls.push({ tool: event.tool, callId: event.callId })
        return
      case 'tool_result': {
        // Match by callId — robust against out-of-order results when
        // parallel tool-call execution lands. Linear scan is fine; N is
        // small (one eval's tool calls).
        for (let i = 0; i < rec.toolCalls.length; i++) {
          const tc = rec.toolCalls[i]
          if (tc && tc.callId === event.callId && tc.success === undefined) {
            rec.toolCalls[i] = { tool: event.tool, callId: event.callId, success: event.success, ...(event.preview ? { preview: event.preview } : {}) }
            return
          }
        }
        // Lost the corresponding start — record the result as its own entry.
        rec.toolCalls.push({ tool: event.tool, callId: event.callId, success: event.success, ...(event.preview ? { preview: event.preview } : {}) })
        return
      }
      case 'warning':
        rec.warnings.push(event.message)
        return
      case 'model_fallback':
        rec.modelFallback = { preferred: event.preferred, effective: event.effective, reason: event.reason }
        rec.model = event.effective
        return
      case 'eval_completed':
        closeRecord(rec, event.outcome)
        return
      // chunk / thinking are streamed deltas — too noisy for the ring.
      case 'chunk':
      case 'thinking':
        return
    }
  }

  return {
    attach: (addListener) => {
      const cb: OnEvalEvent = (agentName, event) => handle(agentName, event)
      return addListener(cb)
    },
    setToolNames: (traceId, toolNames) => {
      const rec = open.get(traceId) ?? closed.find(r => r.traceId === traceId)
      if (rec) rec.toolNames = toolNames
    },
    listRecent: ({ limit = 20, agent } = {}) => {
      const filtered = agent ? closed.filter(r => r.agentName === agent) : closed
      return filtered.slice(0, limit)
    },
    getByTraceId: (traceId) => open.get(traceId) ?? closed.find(r => r.traceId === traceId) ?? null,
    clear: () => { open.clear(); closed.length = 0 },
  }
}
