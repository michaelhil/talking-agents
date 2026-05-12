// Per-room summary & compression configuration.
//
// Two independent features share one config object because the UI and
// streaming surface them together:
//   - Summary: rolling user-readable overview of all messages in the room.
//   - Compression: rewrites the oldest Y messages into a single evolving
//     `room_summary` message at the top of the message stream, which also
//     feeds the LLM context via context-builder.
//
// Each feature has its own schedule (time OR message count, mutually
// exclusive). Disabled features have `enabled: false` and do not fire.

export type Aggressiveness = 'low' | 'med' | 'high'

// Mutually exclusive — one of timed (every N seconds) or message-count
// (every M messages since last run). `null` variants aren't used; the
// discriminator is `kind`.
export type SummarySchedule =
  | { readonly kind: 'time'; readonly everySeconds: number }
  | { readonly kind: 'messages'; readonly everyMessages: number }

export interface SummaryFeatureConfig {
  readonly enabled: boolean
  readonly schedule: SummarySchedule
}

export interface CompressionFeatureConfig {
  readonly enabled: boolean
  readonly schedule: SummarySchedule
  // Keep this many most-recent messages untouched.
  readonly keepFresh: number
  // Compress this many oldest messages in one pass, once we've accumulated
  // at least `keepFresh + batchSize` total non-compressed messages.
  readonly batchSize: number
  readonly aggressiveness: Aggressiveness
}

export interface SummaryConfig {
  // Model string, "provider:model" or bare model for Ollama. Undefined means
  // "use the system default" — resolved at call time (e.g. first configured
  // agent's model, or a fallback constant).
  readonly model?: string
  readonly summary: SummaryFeatureConfig
  readonly compression: CompressionFeatureConfig
}

export const DEFAULT_SUMMARY_CONFIG: SummaryConfig = {
  summary: {
    enabled: false,
    schedule: { kind: 'messages', everyMessages: 25 },
  },
  compression: {
    enabled: false,
    schedule: { kind: 'messages', everyMessages: 30 },
    keepFresh: 40,
    batchSize: 30,
    aggressiveness: 'med',
  },
}

// Validate an unknown body against SummaryConfig. Returns the typed config
// on success, or a structured error message on failure. The endpoint
// `PUT /api/rooms/:name/summary-config` accepts JSON from authed clients
// (the UI); before this validator the route did `body as unknown as
// SummaryConfig`, which TS-accepted any shape and pushed the failure to
// runtime in unpredictable places (an invalid schedule.kind could
// silently break the scheduler). Validation here is at the trust
// boundary; the rest of the codebase keeps trusting the SummaryConfig
// type.
// Result type for validators. Generic so inner validators can bubble up
// errors directly without TS getting confused about the value-branch shape.
type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string }

export const validateSummaryConfig = (raw: unknown): ValidationResult<SummaryConfig> => {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'body must be a JSON object' }
  const obj = raw as Record<string, unknown>

  if (obj.model !== undefined && typeof obj.model !== 'string') {
    return { ok: false, error: 'model must be a string when present' }
  }
  const summary = validateSummaryFeature(obj.summary, 'summary')
  if (summary.ok === false) return { ok: false, error: summary.error }
  const compression = validateCompressionFeature(obj.compression)
  if (compression.ok === false) return { ok: false, error: compression.error }

  const out: SummaryConfig = {
    ...(typeof obj.model === 'string' ? { model: obj.model } : {}),
    summary: summary.value,
    compression: compression.value,
  }
  return { ok: true, value: out }
}

const validateSchedule = (raw: unknown, path: string): ValidationResult<SummarySchedule> => {
  if (!raw || typeof raw !== 'object') return { ok: false, error: `${path}.schedule must be an object` }
  const s = raw as Record<string, unknown>
  if (s.kind === 'time') {
    if (typeof s.everySeconds !== 'number' || s.everySeconds <= 0) {
      return { ok: false, error: `${path}.schedule.everySeconds must be a positive number` }
    }
    return { ok: true, value: { kind: 'time', everySeconds: s.everySeconds } }
  }
  if (s.kind === 'messages') {
    if (typeof s.everyMessages !== 'number' || s.everyMessages <= 0) {
      return { ok: false, error: `${path}.schedule.everyMessages must be a positive number` }
    }
    return { ok: true, value: { kind: 'messages', everyMessages: s.everyMessages } }
  }
  return { ok: false, error: `${path}.schedule.kind must be 'time' or 'messages'` }
}

const validateSummaryFeature = (raw: unknown, path: string): ValidationResult<SummaryFeatureConfig> => {
  if (!raw || typeof raw !== 'object') return { ok: false, error: `${path} must be an object` }
  const f = raw as Record<string, unknown>
  if (typeof f.enabled !== 'boolean') return { ok: false, error: `${path}.enabled must be a boolean` }
  const sched = validateSchedule(f.schedule, path)
  if (sched.ok === false) return { ok: false, error: sched.error }
  return { ok: true, value: { enabled: f.enabled, schedule: sched.value } }
}

const validateCompressionFeature = (raw: unknown): ValidationResult<CompressionFeatureConfig> => {
  const base = validateSummaryFeature(raw, 'compression')
  if (base.ok === false) return { ok: false, error: base.error }
  const f = raw as Record<string, unknown>
  if (typeof f.keepFresh !== 'number' || f.keepFresh < 0) return { ok: false, error: 'compression.keepFresh must be a non-negative number' }
  if (typeof f.batchSize !== 'number' || f.batchSize <= 0) return { ok: false, error: 'compression.batchSize must be a positive number' }
  if (f.aggressiveness !== 'low' && f.aggressiveness !== 'med' && f.aggressiveness !== 'high') {
    return { ok: false, error: "compression.aggressiveness must be 'low', 'med', or 'high'" }
  }
  return { ok: true, value: { ...base.value, keepFresh: f.keepFresh, batchSize: f.batchSize, aggressiveness: f.aggressiveness } }
}
