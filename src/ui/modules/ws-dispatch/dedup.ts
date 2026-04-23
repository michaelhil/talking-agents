// Dedup for provider_bound toasts — same agent/provider pair within 5s is
// suppressed. Used by the provider_bound handler in index.ts.

const BOUND_DEDUP_MS = 5000
const lastBoundAt = new Map<string, number>()

export const shouldEmitBound = (agentId: string | null, newProvider: string, now: number): boolean => {
  const key = `${agentId ?? '__system__'}::${newProvider}`
  const prev = lastBoundAt.get(key)
  if (prev !== undefined && now - prev < BOUND_DEDUP_MS) return false
  lastBoundAt.set(key, now)
  return true
}
