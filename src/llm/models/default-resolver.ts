// ============================================================================
// resolveDefaultModel — pure function that picks the best default model given
// current provider state. Used by /api/models (UI default) and by the per-call
// effective-model resolution in agent eval (fallback when preferred is dead).
//
// Filter rules:
//   - Provider must be in the active router order
//   - Cloud providers must have an effective key (env or providers-store)
//   - Provider must not be in active cooldown
//   - Provider must have at least one available model
//
// Selection:
//   - Walk DEFAULT_PREFERENCE_ORDER first (curated preference for fresh systems)
//   - Then any other qualifying provider as a tail-fallback
//   - Return '' when nothing qualifies — caller renders "Configure a provider"
//
// Pure: takes a snapshot of provider state, no I/O, easy to unit test.
// ============================================================================

import { DEFAULT_PREFERENCE_ORDER, CURATED_MODELS } from './catalog.ts'

// Skip thinking models when picking the default — a fresh user's seed
// agent should never land on a 10s-time-to-first-content reasoning model.
// Unknown ids (not in the curated map) are treated as fast (default).
const isThinking = (provider: string, modelId: string): boolean => {
  const entry = CURATED_MODELS[provider]?.find(m => m.id === modelId)
  return entry?.kind === 'thinking'
}

export interface ProviderSnapshot {
  readonly name: string
  // 'ok' = has effective key (or is ollama) AND not in cooldown.
  readonly status: 'ok' | 'no_key' | 'cooldown' | 'down'
  // First entry is the preferred pick for this provider (curated order).
  readonly models: ReadonlyArray<{ readonly id: string }>
}

// Format a model reference. Returns the BARE model id (no `provider:`
// prefix) regardless of provider. Rationale: an auto-added prefix
// PINS the model to that provider in the router, disabling failover —
// when the upstream throttles (gemini Pro 503, anthropic 529, etc.)
// the request fails hard with no recovery. Bare ids let the router
// walk candidates and pick whichever is healthy.
//
// Users who genuinely WANT pinning (e.g. a model the router can't
// disambiguate by id alone) can still type the prefix manually in the
// agent inspector — the router honors explicit pins, it just doesn't
// add them automatically anymore.
const formatModelRef = (_providerName: string, modelId: string): string => modelId

export const resolveDefaultModel = (providers: ReadonlyArray<ProviderSnapshot>): string => {
  // First pass: walk the curated preference order, pick the first ok provider
  // whose first NON-thinking model is available.
  for (const prov of DEFAULT_PREFERENCE_ORDER) {
    const p = providers.find(x => x.name === prov && x.status === 'ok')
    if (!p) continue
    const firstFast = p.models.find(m => !isThinking(prov, m.id))
    if (!firstFast) continue
    return formatModelRef(prov, firstFast.id)
  }
  // Second pass: any remaining ok provider with a non-thinking model. Catches
  // providers that aren't in DEFAULT_PREFERENCE_ORDER (mistral, openrouter,
  // sambanova, ollama) so a fresh user with only Ollama configured still
  // gets a default.
  for (const p of providers) {
    if (p.status !== 'ok') continue
    const firstFast = p.models.find(m => !isThinking(p.name, m.id))
    if (firstFast) return formatModelRef(p.name, firstFast.id)
  }
  return ''
}
