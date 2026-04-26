// ============================================================================
// LimitMetrics — process-global counters for cap/limit hits.
//
// Centralizes observability for caps that would otherwise be invisible:
// truncations, retries, drops, evictions. Surfaced via GET /api/system/limits.
// Single-threaded JS; no locking. Per-instance metrics are out of scope —
// these are infrastructure-level counts, not per-tenant behavior.
//
// Why a snapshot instead of streaming: the read side is an admin polling at
// ~10s intervals. Streaming would be over-engineering for an internal tool.
// ============================================================================

export interface LimitMetricsSnapshot {
  // Counts incrementing only when a cap is hit / a fallback fires.
  // Scope: only the limits whose enforcement site has access to a system
  // (or shared) reference. Truncations inside pure functions (document
  // formatForContext, whisper validate) already signal at the call site
  // ("…" suffix or "[N more blocks omitted]") and aren't tracked here.
  // LLM retries surface via onEvent({kind:'warning'}) per attempt — also
  // not tracked here to avoid threading metrics through evaluation+spawn.
  sseBufferExceeded: number            // openai-compatible SSE buffer overflow
  evictionFlushRetries: number         // system-registry retry loop (per attempt)
  evictionForceEvicts: number          // system-registry force-evict after exhaustion
  wsBackpressureDropped: number        // ws-handler closed slow consumer
  rateLimitEvicted: number             // rate-limit LRU dropped a key
  staleSessionsEvicted: number         // ws-handler TTL sweep dropped a session
}

export interface LimitMetrics {
  readonly inc: (field: keyof LimitMetricsSnapshot, by?: number) => void
  readonly snapshot: () => LimitMetricsSnapshot
  readonly reset: () => void           // tests only
}

const zeroSnapshot = (): LimitMetricsSnapshot => ({
  sseBufferExceeded: 0,
  evictionFlushRetries: 0,
  evictionForceEvicts: 0,
  wsBackpressureDropped: 0,
  rateLimitEvicted: 0,
  staleSessionsEvicted: 0,
})

export const createLimitMetrics = (): LimitMetrics => {
  let counts = zeroSnapshot()
  return {
    inc: (field, by = 1) => { counts[field] += by },
    snapshot: () => ({ ...counts }),
    reset: () => { counts = zeroSnapshot() },
  }
}
