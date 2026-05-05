// Per-agent fallback-chain resolution for transient upstream failures.
//
// On a fallbackable error (rate_limited / provider_down / network) the eval
// loop calls resolveFallbackChain(primary) and walks the returned models in
// order, retrying each until one succeeds or all are exhausted.
//
// The chain comes from the agent's `modelFallback` config field. Authors
// (humans or script files) declare it explicitly. There are no system-wide
// defaults, no tier abstractions, no provider equivalence tables — these
// drift and create surprises. A model is a name; the user picks names.
//
// Pure function — no I/O, no closure over agent state. Test it directly.

const normaliseToArray = (
  fallback: string | ReadonlyArray<string> | undefined,
): ReadonlyArray<string> => {
  if (fallback === undefined) return []
  if (typeof fallback === 'string') return fallback.length > 0 ? [fallback] : []
  return fallback
}

// Returns the ordered chain of fallback model refs to try, in priority order.
// Filters out:
//   - the primary model itself (no point retrying the model that just failed)
//   - empty strings (defensive — config came from disk)
//   - duplicates (chain element seen earlier wins)
// Empty array when no fallback applies.
export const resolveFallbackChain = (
  primary: string,
  explicitFallback?: string | ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const raw = normaliseToArray(explicitFallback)
  const seen = new Set<string>([primary])
  const out: string[] = []
  for (const ref of raw) {
    const trimmed = ref.trim()
    if (!trimmed) continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

// Codes from AgentResponseErrorCode that warrant advancing to the next
// element of the agent's fallback chain. The chain walks DIFFERENT
// providers, so per-provider account state (credit-out, model not in
// account, quota exceeded) gets a chance on the next provider — not just
// transient upstream errors.
//
// Excluded: agent-side issues (tool_loop_exceeded, empty_response,
// tools_unavailable) — those would repeat on any provider; and no_api_key
// — already filtered at the router level (provider isn't in candidates).
//
// `model_unavailable` is included because Anthropic / OpenAI / others
// surface low-credit, account-restricted, and per-account model gating
// as HTTP 400 (invalid_request_error). Different account on the next
// chain element may have none of those problems.
export const FALLBACKABLE_CODES: ReadonlySet<string> = new Set([
  'rate_limited', 'provider_down', 'network', 'model_unavailable',
])
