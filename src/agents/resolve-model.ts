// ============================================================================
// resolveEffectiveModel — derive-on-read model resolution for an agent.
//
// Mirrors src/wiki/resolve-active.ts: instead of caching/mutating a derived
// value (preferred → effective) at boot when provider state changes, we resolve
// it fresh on each agent invocation. The agent stores the user's *intent*
// (preferred); we compute the *effective* model right before the LLM call.
//
// When preferred is unavailable, fall through to the system default. Surface
// the fallback through the returned struct so the caller can emit a one-shot
// notice — never mutate the agent's stored model.
//
// Pure: takes a snapshot of available models + a default, no I/O.
// ============================================================================

export type EffectiveModelReason = 'preferred_available' | 'preferred_unavailable' | 'preferred_blank'

export interface EffectiveModel {
  readonly model: string
  readonly fallback: boolean
  readonly reason: EffectiveModelReason
}

export const resolveEffectiveModel = (
  preferred: string,
  isAvailable: (model: string) => boolean,
  fallback: string,
): EffectiveModel => {
  // Empty preferred → use the fallback. This is the cold-boot case: a fresh
  // user with no providers configured selects '' from the modal; later they
  // add a key and the same agent will resolve to that provider's curated pick.
  if (!preferred || preferred.trim() === '') {
    return { model: fallback, fallback: true, reason: 'preferred_blank' }
  }
  if (isAvailable(preferred)) {
    return { model: preferred, fallback: false, reason: 'preferred_available' }
  }
  // Preferred is set but not currently callable. If we have no fallback either,
  // hand back the preferred string — the LLM call will fail and surface as a
  // typed error message (Phase 1's action: 'error') rather than silently
  // swapping to nothing.
  if (!fallback) {
    return { model: preferred, fallback: false, reason: 'preferred_unavailable' }
  }
  return { model: fallback, fallback: true, reason: 'preferred_unavailable' }
}
