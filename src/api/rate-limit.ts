// ============================================================================
// In-memory per-key sliding-window rate limiter.
//
// Used by routes that need to throttle drive-by spam (instance creation,
// bug submission). Single-process, no Redis — fits samsinn's threat model:
// one operator, single host, restarts are rare enough that losing the
// counter on restart isn't a real abuse path.
//
// Keying is left to the caller (typically remote IP). The map is bounded
// by a cheap GC sweep that drops stale keys on each accept.
// ============================================================================

export interface RateLimitOk { readonly ok: true }
export interface RateLimitFail { readonly ok: false; readonly retryAfterMs: number }
export type RateLimitResult = RateLimitOk | RateLimitFail

export interface RateLimiterOptions {
  readonly windowMs: number
  readonly max: number
  readonly mapSizeCap?: number   // defaults to 1024
}

export interface RateLimiter {
  /** Check + record. Returns { ok: true } and records a timestamp on accept. */
  readonly check: (key: string | undefined, now?: number) => RateLimitResult
}

export const createRateLimiter = (opts: RateLimiterOptions): RateLimiter => {
  const { windowMs, max } = opts
  const cap = opts.mapSizeCap ?? 1024
  const stamps = new Map<string, number[]>()

  const check = (key: string | undefined, now: number = Date.now()): RateLimitResult => {
    // No key available (test/headless boundary) — fail open. Production
    // traffic always supplies one via Bun.serve.requestIP().
    if (!key) return { ok: true }
    const arr = stamps.get(key) ?? []
    const cutoff = now - windowMs
    const recent = arr.filter(t => t > cutoff)
    if (recent.length >= max) {
      const oldest = recent[0]!
      return { ok: false, retryAfterMs: oldest + windowMs - now }
    }
    recent.push(now)
    stamps.set(key, recent)
    // GC: drop stale keys when the map gets too big.
    if (stamps.size > cap) {
      for (const [k, v] of stamps) {
        if (v.every(t => t <= cutoff)) stamps.delete(k)
      }
    }
    return { ok: true }
  }

  return { check }
}
