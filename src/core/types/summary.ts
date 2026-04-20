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
