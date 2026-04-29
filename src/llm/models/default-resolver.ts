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

import { DEFAULT_PREFERENCE_ORDER } from './catalog.ts'

export interface ProviderSnapshot {
  readonly name: string
  // 'ok' = has effective key (or is ollama) AND not in cooldown.
  readonly status: 'ok' | 'no_key' | 'cooldown' | 'down'
  // First entry is the preferred pick for this provider (curated order).
  readonly models: ReadonlyArray<{ readonly id: string }>
}

// Format a model reference. Ollama is unprefixed (legacy); cloud uses
// `provider:model`. Matches the convention used everywhere else in the app.
const formatModelRef = (providerName: string, modelId: string): string =>
  providerName === 'ollama' ? modelId : `${providerName}:${modelId}`

export const resolveDefaultModel = (providers: ReadonlyArray<ProviderSnapshot>): string => {
  // First pass: walk the curated preference order, pick the first ok provider
  // that has at least one model.
  for (const prov of DEFAULT_PREFERENCE_ORDER) {
    const p = providers.find(x => x.name === prov && x.status === 'ok')
    if (!p || p.models.length === 0) continue
    return formatModelRef(prov, p.models[0]!.id)
  }
  // Second pass: any remaining ok provider with models. Catches providers that
  // aren't in DEFAULT_PREFERENCE_ORDER (e.g. mistral, openrouter, sambanova,
  // ollama) so a fresh user with only Ollama configured still gets a default.
  const fallback = providers.find(x => x.status === 'ok' && x.models.length > 0)
  if (fallback) return formatModelRef(fallback.name, fallback.models[0]!.id)
  return ''
}
