// ============================================================================
// REST calls + result formatting for the providers panel.
// ============================================================================

export interface TestResult {
  ok: boolean
  error?: string
  elapsedMs: number
  modelCount?: number
  concurrency?: {
    model: string
    target: number
    succeeded: number
    failed: number
    avgMs: number
    p95Ms: number
    byFailure: Record<string, number>
  }
}

export const save = async (name: string, body: Record<string, unknown>): Promise<boolean> => {
  const res = await fetch(`/api/providers/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.ok
}

export const saveOrder = async (order: string[]): Promise<boolean> => {
  const res = await fetch(`/api/providers/order`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order }),
  })
  return res.ok
}

export const testKey = async (name: string, apiKey?: string): Promise<TestResult> => {
  const res = await fetch(`/api/providers/${encodeURIComponent(name)}/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(apiKey ? { apiKey } : {}),
  })
  try { return await res.json() as TestResult }
  catch { return { ok: false, error: 'invalid response', elapsedMs: 0 } }
}

// Build a human-friendly toast line from a test result. Includes model count
// + concurrency probe details when present.
export const formatTestToast = (name: string, r: TestResult): string => {
  if (!r.ok && !r.concurrency) {
    return `${name}: ${r.error ?? 'test failed'}`
  }
  const parts: string[] = []
  if (typeof r.modelCount === 'number') parts.push(`${r.modelCount} models`)
  if (r.concurrency) {
    const c = r.concurrency
    const capacity = `${c.succeeded}/${c.target} ok`
    const lat = c.succeeded > 0 ? `avg ${c.avgMs}ms` : null
    const fails = Object.entries(c.byFailure).map(([k, n]) => `${n}×${k}`).join(', ')
    parts.push(capacity)
    if (lat) parts.push(lat)
    if (fails) parts.push(fails)
    parts.push(`(${c.model})`)
  }
  return `${name}: ${parts.join(' · ')}`
}
