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
import { CURATED_MODELS } from './catalog.ts'

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

// Anthropic publishes model ids in dated-canonical form
// (`claude-haiku-4-5-20251001`). Agents and the curated dropdown carry the
// bare alias (`claude-haiku-4-5`). Without translation, the router's
// `availableModels.includes(modelId)` filter rejects the alias and the
// request fails as "no eligible provider".
//
// Resolution lives at the adapter layer (not the router) because it's
// anthropic-specific knowledge: only anthropic uses the alias-plus-date
// convention. Bounding by the curated catalog keeps us from inventing
// aliases for unknown anthropic ids — only ids we explicitly know about
// participate in alias matching.
//
// `<alias>-YYYYMMDD` is the only suffix shape that counts. This avoids
// false positives like `gpt-4` matching `gpt-4-turbo` or
// `llama-3.3` matching `llama-3.3-70b-versatile`, both of which are
// different models, not dated variants.
//
// On multiple matches (Anthropic ships two dated canonicals at once for
// the same alias), the lexicographically-largest dated suffix wins —
// for YYYYMMDD that's the chronologically newest.
export const expandAnthropicAliases = (
  ids: ReadonlyArray<string>,
): { expanded: ReadonlyArray<string>; aliasMap: ReadonlyMap<string, string> } => {
  const aliasMap = new Map<string, string>()
  const aliases = CURATED_MODELS.anthropic ?? []
  const idSet = new Set(ids)
  for (const { id: alias } of aliases) {
    const matches = ids.filter(id => {
      if (!id.startsWith(`${alias}-`)) return false
      return /^\d{8}$/.test(id.slice(alias.length + 1))
    })
    if (matches.length === 0) continue
    matches.sort()
    const canonical = matches[matches.length - 1]!
    aliasMap.set(alias, canonical)
  }
  const extras: string[] = []
  for (const alias of aliasMap.keys()) {
    if (!idSet.has(alias)) extras.push(alias)
  }
  return { expanded: [...ids, ...extras], aliasMap }
}
