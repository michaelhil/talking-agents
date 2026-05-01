// Per-agent model-fallback resolution for transient upstream failures.
//
// On a fallbackable error (rate_limited / provider_down / network) the eval
// loop calls resolveModelFallback(primary) to find a second model to retry
// with. Order:
//   1. Explicit `modelFallback` on the agent config — user intent.
//   2. Implicit hardcoded mapping for known capacity-flaky upstream models.
//      Currently only `gemini:gemini-2.5-pro` → `gemini:gemini-2.5-flash`
//      because Google's Pro fleet 503s under load several times a day.
//      Add more here only with evidence the upstream actually warrants it.
// Returns null when no fallback applies (also null when fallback === primary,
// to avoid retrying with the same model the LLM call already failed on).
//
// Pure function — no I/O, no closure over agent state. Test it directly.

const IMPLICIT_FALLBACKS: Readonly<Record<string, string>> = {
  'gemini:gemini-2.5-pro': 'gemini:gemini-2.5-flash',
}

export const resolveModelFallback = (
  primary: string,
  explicitFallback?: string,
): string | null => {
  if (explicitFallback) return explicitFallback === primary ? null : explicitFallback
  const implicit = IMPLICIT_FALLBACKS[primary]
  return implicit && implicit !== primary ? implicit : null
}

// Codes from AgentResponseErrorCode that warrant retrying on a different
// model. Excludes config-level errors (no_api_key, model_unavailable) and
// agent-side issues (tool_loop_exceeded etc).
export const FALLBACKABLE_CODES: ReadonlySet<string> = new Set([
  'rate_limited', 'provider_down', 'network',
])
