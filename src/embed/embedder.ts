// ============================================================================
// Embedder — single-batch text embedding via OpenAI or Gemini.
//
// Provider-neutral entry point: embedTexts({ texts, provider, model, apiKey })
// returns one vector per input text. No streaming, no model-prefix routing,
// no cooldown — this is a thin transport layer. Callers (memory-indexer,
// document-indexer) decide policy (which provider, retry behaviour, batching).
//
// Defaults per provider:
//   openai → text-embedding-3-small (1536 dim)
//   gemini → text-embedding-004     (768  dim)
//
// Mid-batch dimension switching is impossible — the caller must commit to a
// single (provider, model, dim) for the lifetime of an index. See
// vector-store.ts for the binding contract.
// ============================================================================

import { fetchWithTimeout } from '../core/fetch-utils.ts'

export type EmbedProvider = 'openai' | 'gemini'

export interface EmbedRequest {
  readonly texts: ReadonlyArray<string>
  readonly provider: EmbedProvider
  readonly model: string
  readonly apiKey: string
  readonly timeoutMs?: number
}

export interface EmbedResult {
  readonly vectors: ReadonlyArray<ReadonlyArray<number>>
  readonly model: string
  readonly dim: number
}

export class EmbedError extends Error {
  readonly provider: EmbedProvider
  readonly status: number | null
  readonly retryAfterSec: number | null
  constructor(message: string, opts: { provider: EmbedProvider; status?: number; retryAfterSec?: number | null }) {
    super(message)
    this.name = 'EmbedError'
    this.provider = opts.provider
    this.status = opts.status ?? null
    this.retryAfterSec = opts.retryAfterSec ?? null
  }
}

export const DEFAULT_OPENAI_MODEL = 'text-embedding-3-small'
export const DEFAULT_GEMINI_MODEL = 'text-embedding-004'

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_INPUTS_PER_BATCH = 100  // both providers support at least 100 per call

const parseRetryAfter = (header: string | null): number | null => {
  if (!header) return null
  const n = Number.parseInt(header, 10)
  if (Number.isFinite(n) && n >= 0) return n
  const date = Date.parse(header)
  if (Number.isFinite(date)) return Math.max(0, Math.round((date - Date.now()) / 1000))
  return null
}

export const embedTexts = async (req: EmbedRequest): Promise<EmbedResult> => {
  if (req.texts.length === 0) {
    throw new EmbedError('embedTexts called with empty texts array', { provider: req.provider })
  }
  if (req.texts.length > MAX_INPUTS_PER_BATCH) {
    throw new EmbedError(
      `batch size ${req.texts.length} exceeds max ${MAX_INPUTS_PER_BATCH}; caller must split`,
      { provider: req.provider },
    )
  }
  if (!req.apiKey) {
    throw new EmbedError(`no API key configured for provider '${req.provider}'`, { provider: req.provider })
  }
  if (req.provider === 'openai') return await embedOpenAI(req)
  if (req.provider === 'gemini') return await embedGemini(req)
  throw new EmbedError(`unknown provider '${req.provider as string}'`, { provider: req.provider })
}

// --- OpenAI -----------------------------------------------------------------
//
// POST https://api.openai.com/v1/embeddings
// Body: { model, input: string[] }
// Response: { data: [{ embedding: number[], index: number }, ...], model, usage }
//
const embedOpenAI = async (req: EmbedRequest): Promise<EmbedResult> => {
  const url = 'https://api.openai.com/v1/embeddings'
  const body = JSON.stringify({ model: req.model, input: req.texts })
  let res: Response
  try {
    res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${req.apiKey}`,
        },
        body,
      },
      req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
  } catch (err) {
    throw new EmbedError(
      `openai embedding network error: ${(err as Error).message}`,
      { provider: 'openai' },
    )
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const retryAfterSec = parseRetryAfter(res.headers.get('retry-after'))
    throw new EmbedError(
      `openai embedding ${res.status}: ${text.slice(0, 300)}`,
      { provider: 'openai', status: res.status, retryAfterSec },
    )
  }
  const json = (await res.json()) as {
    data?: Array<{ embedding: number[]; index: number }>
    model?: string
  }
  if (!json.data || json.data.length !== req.texts.length) {
    throw new EmbedError(
      `openai embedding response missing data or count mismatch (got ${json.data?.length ?? 0}, expected ${req.texts.length})`,
      { provider: 'openai' },
    )
  }
  // Sort by index just in case (OpenAI returns in order, but be robust).
  const sorted = [...json.data].sort((a, b) => a.index - b.index)
  const vectors = sorted.map(d => d.embedding)
  return { vectors, model: json.model ?? req.model, dim: vectors[0]!.length }
}

// --- Gemini -----------------------------------------------------------------
//
// POST https://generativelanguage.googleapis.com/v1beta/models/<MODEL>:batchEmbedContents?key=...
// Body: { requests: [{ model, content: { parts: [{ text }] } }, ...] }
// Response: { embeddings: [{ values: number[] }, ...] }
//
const embedGemini = async (req: EmbedRequest): Promise<EmbedResult> => {
  const modelPath = req.model.startsWith('models/') ? req.model : `models/${req.model}`
  const url = `https://generativelanguage.googleapis.com/v1beta/${modelPath}:batchEmbedContents?key=${encodeURIComponent(req.apiKey)}`
  const body = JSON.stringify({
    requests: req.texts.map(text => ({
      model: modelPath,
      content: { parts: [{ text }] },
    })),
  })
  let res: Response
  try {
    res = await fetchWithTimeout(
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
      req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
  } catch (err) {
    throw new EmbedError(
      `gemini embedding network error: ${(err as Error).message}`,
      { provider: 'gemini' },
    )
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const retryAfterSec = parseRetryAfter(res.headers.get('retry-after'))
    throw new EmbedError(
      `gemini embedding ${res.status}: ${text.slice(0, 300)}`,
      { provider: 'gemini', status: res.status, retryAfterSec },
    )
  }
  const json = (await res.json()) as {
    embeddings?: Array<{ values: number[] }>
  }
  if (!json.embeddings || json.embeddings.length !== req.texts.length) {
    throw new EmbedError(
      `gemini embedding response missing embeddings or count mismatch (got ${json.embeddings?.length ?? 0}, expected ${req.texts.length})`,
      { provider: 'gemini' },
    )
  }
  const vectors = json.embeddings.map(e => e.values)
  return { vectors, model: req.model, dim: vectors[0]!.length }
}

// Convenience: embed in batches of MAX_INPUTS_PER_BATCH automatically.
// Useful for memory-indexer and document-indexer which may have arbitrary text counts.
export const embedTextsBatched = async (
  req: Omit<EmbedRequest, 'texts'> & { texts: ReadonlyArray<string> },
): Promise<EmbedResult> => {
  const allVectors: number[][] = []
  let model = req.model
  let dim = 0
  for (let i = 0; i < req.texts.length; i += MAX_INPUTS_PER_BATCH) {
    const slice = req.texts.slice(i, i + MAX_INPUTS_PER_BATCH)
    const r = await embedTexts({ ...req, texts: slice })
    for (const v of r.vectors) allVectors.push([...v])
    model = r.model
    dim = r.dim
  }
  return { vectors: allVectors, model, dim }
}
