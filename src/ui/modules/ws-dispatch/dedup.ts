// Dedup for provider routing toasts — same (agent, key) pair within the
// dedup window is suppressed.
//   - bound:      key = newProvider           (5s window)
//   - all_failed: key = `${model}::${code}`   (5s window)
// Without dedup on all_failed, a flaky agent that retries fast floods
// the toast stack with identical "all providers failed" messages.

const BOUND_DEDUP_MS = 5000
const ALL_FAILED_DEDUP_MS = 5000
const lastBoundAt = new Map<string, number>()
const lastAllFailedAt = new Map<string, number>()

export const shouldEmitBound = (agentId: string | null, newProvider: string, now: number): boolean => {
  const key = `${agentId ?? '__system__'}::${newProvider}`
  const prev = lastBoundAt.get(key)
  if (prev !== undefined && now - prev < BOUND_DEDUP_MS) return false
  lastBoundAt.set(key, now)
  return true
}

export const shouldEmitAllFailed = (
  agentId: string | null,
  model: string,
  primaryCode: string,
  now: number,
): boolean => {
  const key = `${agentId ?? '__system__'}::${model}::${primaryCode}`
  const prev = lastAllFailedAt.get(key)
  if (prev !== undefined && now - prev < ALL_FAILED_DEDUP_MS) return false
  lastAllFailedAt.set(key, now)
  return true
}
