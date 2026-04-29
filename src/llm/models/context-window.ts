// ============================================================================
// Model context-window lookup — dynamic where providers expose it, hardcoded
// table otherwise. Cached in-process (per provider+model).
//
// Ollama:     POST /api/show  → model_info['<arch>.context_length']
// OpenRouter: GET  /models/:id → data.context_length
// Cerebras / Groq / Mistral / SambaNova: /models endpoint returns ID only,
//   so we fall back to a curated table derived from public docs.
// ============================================================================

export interface ContextInfo {
  readonly contextMax: number                // 0 if unknown
  readonly source: 'ollama_api' | 'openrouter_api' | 'known_table' | 'unknown'
}

// Curated context windows for cloud providers that don't expose it in /models.
// Source: each provider's public docs as of early 2026. When in doubt, omit
// rather than guess — the UI falls back to "unknown" which is honest.
const CLOUD_TABLE: Record<string, Record<string, number>> = {
  anthropic: {
    'claude-haiku-4-5':   200_000,
    'claude-sonnet-4-5':  200_000,
    'claude-opus-4-5':    200_000,
  },
  gemini: {
    'gemini-2.5-flash-lite': 1_048_576,
    'gemini-2.5-flash':      1_048_576,
    'gemini-2.5-pro':        2_097_152,
  },
  cerebras: {
    'llama3.1-8b': 8192,
    'qwen-3-235b-a22b-instruct-2507': 64000,
    'gpt-oss-120b': 65536,
    'zai-glm-4.7': 128000,
  },
  groq: {
    'llama-3.3-70b-versatile': 131072,
    'llama-3.1-8b-instant': 131072,
    'llama-3.1-70b-versatile': 131072,
    'gemma2-9b-it': 8192,
    'kimi-k2-thinking': 128000,
    'openai/gpt-oss-120b': 131072,
    'openai/gpt-oss-20b': 131072,
    'qwen/qwen3-32b': 131072,
    'moonshotai/kimi-k2-instruct': 131072,
    'deepseek-r1-distill-llama-70b': 131072,
  },
  mistral: {
    'mistral-large-latest': 131072,
    'mistral-small-latest': 32768,
    'ministral-8b-latest': 131072,
    'ministral-3b-latest': 131072,
  },
  sambanova: {
    'Meta-Llama-3.3-70B-Instruct': 131072,
    'Meta-Llama-3.1-8B-Instruct': 131072,
    'DeepSeek-V3-0324': 65536,
  },
}

const cache = new Map<string, ContextInfo>()

export interface ContextLookupOptions {
  readonly ollamaBaseUrl?: string
  readonly openrouterApiKey?: string
  readonly timeoutMs?: number
}

const fetchWithTimeout = async (url: string, init: RequestInit, timeoutMs: number): Promise<Response> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try { return await fetch(url, { ...init, signal: controller.signal }) }
  finally { clearTimeout(timer) }
}

export const getContextWindow = async (
  providerName: string,
  modelId: string,
  opts: ContextLookupOptions = {},
): Promise<ContextInfo> => {
  const key = `${providerName}::${modelId}`
  const cached = cache.get(key)
  if (cached) return cached

  const timeoutMs = opts.timeoutMs ?? 3000
  let info: ContextInfo = { contextMax: 0, source: 'unknown' }

  if (providerName === 'ollama' && opts.ollamaBaseUrl) {
    try {
      const r = await fetchWithTimeout(`${opts.ollamaBaseUrl}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: modelId }),
      }, timeoutMs)
      if (r.ok) {
        const d = await r.json() as { model_info?: Record<string, unknown> }
        const mi = d.model_info ?? {}
        for (const [k, v] of Object.entries(mi)) {
          if (k.endsWith('.context_length') && typeof v === 'number' && v > 0) {
            info = { contextMax: v, source: 'ollama_api' }
            break
          }
        }
      }
    } catch { /* fall through */ }
  } else if (providerName === 'openrouter' && opts.openrouterApiKey) {
    try {
      const r = await fetchWithTimeout(
        `https://openrouter.ai/api/v1/models/${encodeURIComponent(modelId)}`,
        { headers: { Authorization: `Bearer ${opts.openrouterApiKey}` } },
        timeoutMs,
      )
      if (r.ok) {
        const d = await r.json() as { data?: { context_length?: number } }
        const ctx = Number(d.data?.context_length ?? 0)
        if (ctx > 0) info = { contextMax: ctx, source: 'openrouter_api' }
      }
    } catch { /* fall through */ }
  }

  if (info.source === 'unknown') {
    const hard = CLOUD_TABLE[providerName]?.[modelId]
    if (hard) info = { contextMax: hard, source: 'known_table' }
  }

  cache.set(key, info)
  return info
}

// Synchronous best-effort lookup — hits the in-process cache and the curated
// CLOUD_TABLE only. Returns `unknown` when neither source has an entry, so
// callers can fall back to a safe default. Used by the ai-agent factory to
// auto-derive the per-request context budget without awaiting HTTP.
export const getContextWindowSync = (providerName: string, modelId: string): ContextInfo => {
  const key = `${providerName}::${modelId}`
  const cached = cache.get(key)
  if (cached) return cached
  const hard = CLOUD_TABLE[providerName]?.[modelId]
  if (hard) return { contextMax: hard, source: 'known_table' }
  return { contextMax: 0, source: 'unknown' }
}

// For tests only.
export const clearContextCache = (): void => { cache.clear() }
