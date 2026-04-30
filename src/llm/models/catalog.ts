// ============================================================================
// Curated model catalog — a short list of recommended models per provider,
// rendered as the default view in the UI model dropdown. Users can still
// opt into the full provider-reported list via a "Show all" toggle.
//
// Hand-maintained. When provider offerings change, edit here.
// ============================================================================

import type { CloudProviderName } from '../providers-config.ts'

export interface CuratedModel {
  readonly id: string
  // Human-readable label shown alongside the id (optional — if omitted, UI
  // uses the id).
  readonly label?: string
  // Function-calling support. `true` / `false` when known; `undefined` means
  // unverified (default-allow). Only mark `false` when the provider is
  // documented to reject `tools:` in the request for this model — the UI
  // shows a warning in the agent inspector's Tools group when this is false.
  readonly supportsTools?: boolean
}

// Keyed by provider name. Order within an array is the display order.
// The FIRST entry per provider is considered the provider's "pick" — used
// when computing the server-side default model if no other hint is available.
export const CURATED_MODELS: Record<string, ReadonlyArray<CuratedModel>> = {
  anthropic: [
    { id: 'claude-haiku-4-5',  label: 'Haiku 4.5 (cheap, fast)' },
    { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5 (balanced)'   },
  ],
  gemini: [
    { id: 'gemini-2.5-flash-lite', label: 'Flash-Lite (cheapest)' },
    { id: 'gemini-2.5-flash',      label: 'Flash (default)'       },
    { id: 'gemini-2.5-pro',        label: 'Pro (premium)'         },
  ],
  groq: [
    { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B (fast)'    },
    { id: 'llama-3.1-8b-instant',    label: 'Llama 3.1 8B (fastest)' },
  ],
  cerebras: [
    { id: 'qwen-3-235b-a22b-instruct-2507', label: 'Qwen 3 235B' },
    { id: 'llama3.1-8b',                    label: 'Llama 3.1 8B' },
  ],
  mistral: [
    { id: 'mistral-small-latest',  label: 'Small (cheap)'   },
    { id: 'mistral-medium-latest', label: 'Medium'          },
    { id: 'mistral-large-latest',  label: 'Large (premium)' },
  ],
  openrouter: [
    { id: 'deepseek/deepseek-chat',             label: 'DeepSeek V3 (cheap)' },
    { id: 'meta-llama/llama-3.3-70b-instruct',  label: 'Llama 3.3 70B'       },
  ],
  sambanova: [
    { id: 'Meta-Llama-3.3-70B-Instruct', label: 'Llama 3.3 70B' },
  ],
}

// Preferred default picks for a fresh system, in order. Used by /api/models
// when no last-used model is available, and by the seed flow.
//
// Gemini first because its free tier is the most generous of the major
// providers — a developer who only has a Gemini key gets a working default
// instead of a broken Anthropic-flavoured one. Anthropic and the rest stay
// as fallbacks if Gemini isn't keyed.
export const DEFAULT_PREFERENCE_ORDER: ReadonlyArray<CloudProviderName | 'ollama'> = [
  'gemini', 'anthropic', 'groq', 'cerebras',
]

export const isCuratedModel = (provider: string, modelId: string): boolean => {
  const list = CURATED_MODELS[provider]
  if (!list) return false
  return list.some(m => m.id === modelId)
}

// Return tool-capability for a model reference, or `undefined` when unknown.
// Accepts both prefixed (`provider:modelId`) and bare (`modelId`) refs.
// Unknown is default-allow — the UI only warns on an explicit `false`.
export const modelSupportsTools = (modelRef: string): boolean | undefined => {
  const colonIdx = modelRef.indexOf(':')
  const [provider, modelId] = colonIdx > 0
    ? [modelRef.slice(0, colonIdx), modelRef.slice(colonIdx + 1)]
    : [undefined, modelRef]
  const search = (list: ReadonlyArray<CuratedModel> | undefined): boolean | undefined => {
    const hit = list?.find(m => m.id === modelId)
    return hit?.supportsTools
  }
  if (provider) return search(CURATED_MODELS[provider])
  // No prefix — scan all providers, return the first explicit verdict.
  for (const list of Object.values(CURATED_MODELS)) {
    const v = search(list)
    if (v !== undefined) return v
  }
  return undefined
}
