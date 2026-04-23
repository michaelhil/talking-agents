// Provider-probe logic — concurrency test used by /api/providers/:name/test.
//
// Lives in llm/ (not api/routes/) so it can be reused by future callers
// (CLI, MCP tool) and so the route file stays thin.

import { PROVIDER_PROFILES, type CloudProviderName } from './providers-config.ts'

export const TEST_TIMEOUT_MS = 15_000

interface ProbeAttempt {
  readonly ok: boolean
  readonly ms: number
  readonly code?: string
}

export interface ProbeResult {
  readonly model: string
  readonly target: number
  readonly succeeded: number
  readonly failed: number
  readonly avgMs: number
  readonly p95Ms: number
  readonly byFailure: Record<string, number>
}

export const p95 = (xs: ReadonlyArray<number>): number => {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)
  return Math.round(sorted[idx] ?? 0)
}

// Pick the best test model: first pinned, then first curated, then first
// reported. Returns null if nothing suitable is available.
export const pickTestModel = (
  pinned: ReadonlyArray<string>,
  curated: ReadonlyArray<string>,
  reported: ReadonlyArray<string>,
): string | null => {
  if (pinned.length > 0 && pinned[0]) return pinned[0]
  if (curated.length > 0 && curated[0]) return curated[0]
  if (reported.length > 0 && reported[0]) return reported[0]
  return null
}

export const runProbe = async (
  chatFn: (model: string) => Promise<void>,
  model: string,
  target: number,
  overallTimeoutMs: number,
): Promise<ProbeResult> => {
  const attempts: ProbeAttempt[] = []
  const overall = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`timeout after ${overallTimeoutMs}ms`)), overallTimeoutMs))

  const one = async (): Promise<ProbeAttempt> => {
    const t0 = performance.now()
    try {
      await chatFn(model)
      return { ok: true, ms: Math.round(performance.now() - t0) }
    } catch (err) {
      const ms = Math.round(performance.now() - t0)
      const code = (err as { code?: string })?.code ?? 'error'
      return { ok: false, ms, code }
    }
  }

  try {
    const results = await Promise.race([
      Promise.all(Array.from({ length: target }, () => one())),
      overall,
    ]) as ProbeAttempt[]
    attempts.push(...results)
  } catch {
    // Overall timeout — anything that completed in-flight is lost; stub as fails.
    for (let i = 0; i < target; i++) attempts.push({ ok: false, ms: overallTimeoutMs, code: 'timeout' })
  }

  const successes = attempts.filter(a => a.ok).map(a => a.ms)
  const failures = attempts.filter(a => !a.ok)
  const byFailure: Record<string, number> = {}
  for (const f of failures) byFailure[f.code ?? 'error'] = (byFailure[f.code ?? 'error'] ?? 0) + 1

  return {
    model,
    target,
    succeeded: successes.length,
    failed: failures.length,
    avgMs: successes.length > 0 ? Math.round(successes.reduce((s, x) => s + x, 0) / successes.length) : 0,
    p95Ms: p95(successes),
    byFailure,
  }
}

const knownCloudNames: ReadonlySet<string> = new Set(Object.keys(PROVIDER_PROFILES))

export const isCloud = (name: string): name is CloudProviderName => knownCloudNames.has(name)

export type ProviderStatus = 'ok' | 'no_key' | 'cooldown' | 'down' | 'disabled'

export const computeStatus = (
  kind: 'cloud' | 'ollama',
  hasKey: boolean,
  userEnabled: boolean,
  cooldown: { coldUntilMs: number; reason: string } | null,
  circuitOpen: boolean,
): ProviderStatus => {
  if (!userEnabled) return 'disabled'
  if (circuitOpen) return 'down'
  if (cooldown) return 'cooldown'
  if (kind === 'cloud' && !hasKey) return 'no_key'
  return 'ok'
}
