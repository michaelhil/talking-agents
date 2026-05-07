// ============================================================================
// Embed-resolver — picks the embedder for the next ingestion.
//
// Two cases:
//   1. The instance has already committed to a binding (provider/model/dim)
//      from a prior ingestion. We MUST use the same binding — vector stores
//      cannot mix dims. If the bound provider currently has no API key
//      configured, the resolver returns a "stuck" result and the caller
//      surfaces a clear error. (We do not silently fall over to a different
//      provider; that would corrupt the index.)
//
//   2. The instance has no binding yet (first-ever ingestion). The resolver
//      picks the highest-priority configured cloud provider — OpenAI first,
//      then Gemini. The pick becomes the binding once written.
//
// The resolver does NOT touch the network and does NOT mutate any state.
// It returns a plan; callers decide whether to act on it.
// ============================================================================

import type { MergedProviders } from '../llm/providers-store.ts'
import type { EmbedProvider } from './embedder.ts'
import { DEFAULT_OPENAI_MODEL, DEFAULT_GEMINI_MODEL } from './embedder.ts'

export interface ResolverInput {
  readonly providers: MergedProviders
  readonly bound: { provider: EmbedProvider; model: string; dim: number } | null
}

export type ResolverResult =
  | {
      readonly status: 'ok'
      readonly provider: EmbedProvider
      readonly model: string
      readonly apiKey: string
      readonly source: 'env' | 'stored'
    }
  | {
      readonly status: 'stuck'
      readonly reason: string
      // The binding the instance is committed to, when we got stuck because
      // its key disappeared. Helps the UI explain the situation.
      readonly binding?: { provider: EmbedProvider; model: string }
    }
  | {
      readonly status: 'unconfigured'
      readonly reason: string
    }

// Priority order when picking a fresh embedder (no binding yet).
const FRESH_PROVIDER_ORDER: ReadonlyArray<EmbedProvider> = ['openai', 'gemini']

const defaultModelFor = (p: EmbedProvider): string => {
  if (p === 'openai') return DEFAULT_OPENAI_MODEL
  if (p === 'gemini') return DEFAULT_GEMINI_MODEL
  throw new Error(`unknown embed provider '${p as string}'`)
}

export const resolveEmbedder = (input: ResolverInput): ResolverResult => {
  // Case 1 — already bound. Must continue with the same provider.
  if (input.bound) {
    const p = input.bound.provider
    const entry = input.providers.cloud[p]
    if (!entry || !entry.enabled || !entry.apiKey) {
      return {
        status: 'stuck',
        reason:
          `instance is bound to embedder ${p}/${input.bound.model} but no API key is configured for ${p}. ` +
          `Set ${p.toUpperCase()}_API_KEY (env) or save it via the providers panel and retry.`,
        binding: { provider: p, model: input.bound.model },
      }
    }
    // Honour stored embeddingModel only if it matches the bound model — a
    // different stored model would change dim and corrupt the index.
    return {
      status: 'ok',
      provider: p,
      model: input.bound.model,
      apiKey: entry.apiKey,
      source: entry.source === 'env' ? 'env' : 'stored',
    }
  }

  // Case 2 — no binding yet. Pick the first available cloud provider.
  for (const p of FRESH_PROVIDER_ORDER) {
    const entry = input.providers.cloud[p]
    if (!entry || !entry.enabled || !entry.apiKey) continue
    const model = entry.embeddingModel ?? defaultModelFor(p)
    return {
      status: 'ok',
      provider: p,
      model,
      apiKey: entry.apiKey,
      source: entry.source === 'env' ? 'env' : 'stored',
    }
  }

  return {
    status: 'unconfigured',
    reason:
      'No embedding provider is configured. Set OPENAI_API_KEY or GEMINI_API_KEY ' +
      '(env), or save a key via the providers panel.',
  }
}
