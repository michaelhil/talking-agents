// ============================================================================
// Model-name prefix parsing — single source of truth.
//
// Two callsites used to have separate logic:
//   - router.ts: parseProviderPrefix     (for routing decisions)
//   - ai-agent.ts: splitProviderModel    (for context-window lookup)
//
// Both needed updating when a new cloud provider was added. They drifted.
// This module is the one place that maps prefixed strings to providers.
// Callers handle "unknown provider" semantics themselves — routing walks all
// candidates, context-lookup falls back to Ollama or "unknown".
// ============================================================================

import { PROVIDER_PROFILES, type CloudProviderName } from '../providers-config.ts'

// Set built from PROVIDER_PROFILES so adding a provider in providers-config
// automatically updates every callsite that imports from here.
const KNOWN_CLOUD_PROVIDERS: ReadonlySet<string> = new Set(Object.keys(PROVIDER_PROFILES))

export const isCloudProvider = (name: string): name is CloudProviderName =>
  KNOWN_CLOUD_PROVIDERS.has(name)

export interface PrefixedModel {
  /** Provider name when a syntactic prefix is present; null otherwise.
   *  Whether the prefix names a real provider is the caller's concern —
   *  the router checks it against its `providers` map; the context-window
   *  resolver checks it against `isCloudProvider`. */
  readonly provider: string | null
  /** Model id without the prefix. Equal to input string when no prefix. */
  readonly modelId: string
}

// Split provider-prefixed model: "groq:llama-3.3" → { provider: "groq", modelId: "llama-3.3" }.
// Splits on the FIRST colon only — OpenRouter slugs can contain additional
// colons (e.g. "openrouter:meta-llama/x:free"). When the segment before the
// first colon contains a slash (e.g. "meta-llama/..."), the whole string is
// treated as a bare modelId — that's an OpenRouter slug, not a prefix.
//
// Permissive: returns ANY non-slash prefix. Validity is the caller's check
// (the router walks its providers map; the context resolver uses
// isCloudProvider). This lets test code use fake provider names without
// the parser hardcoding the known list.
export const parsePrefixedModel = (model: string): PrefixedModel => {
  const colonIdx = model.indexOf(':')
  if (colonIdx === -1) return { provider: null, modelId: model }
  const prefix = model.slice(0, colonIdx)
  if (!prefix || prefix.includes('/')) return { provider: null, modelId: model }
  return { provider: prefix, modelId: model.slice(colonIdx + 1) }
}
