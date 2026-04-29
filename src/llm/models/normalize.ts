// ============================================================================
// Provider-specific model id normalization.
//
// Some provider /models endpoints decorate ids in ways that don't match the
// user-facing names. The router compares user-facing names against the
// catalog, so we strip decorations at the adapter layer to make the catalog
// match what users (and the seed config) actually pass.
//
// One place. Adding a new quirk lands here.
// ============================================================================

import type { CloudProviderName } from '../providers-config.ts'

// Strip Gemini's "models/" prefix. Gemini's OpenAI-compat /models endpoint
// returns ids as "models/gemini-2.5-flash-lite", but agents and seed configs
// use the bare name. Without this, router.resolveCandidates filtered gemini
// out of unprefixed-model candidates and requests fell through to keyless /
// unreachable providers — production samsinn.app symptom: silent Send.
const GEMINI_PREFIX = 'models/'

export const normalizeModelId = (provider: CloudProviderName | string, id: string): string => {
  if (provider === 'gemini' && id.startsWith(GEMINI_PREFIX)) {
    return id.slice(GEMINI_PREFIX.length)
  }
  return id
}
