// procedure_search — symptom-driven BM25 search over the wiki's pre-built
// search index. Phase F.3. Wiki authoring + build keeps the index in
// _search-index.json; this tool fetches once per process (5 min TTL),
// scores queries with classical BM25, and returns top-N procedures with
// matched-term explanations.

import type { Tool, ToolResult } from '../../../core/types/tool.ts'
import type { WikiSourceBinding } from '../../types.ts'
import { createWikiSource, type WikiSource } from '../../../wikis/wiki-fetcher.ts'

interface SearchDoc {
  readonly procedureId: string
  readonly title: string
  readonly text: string
  readonly length: number
}

interface SearchIndex {
  readonly version: 1
  readonly wiki: string
  readonly docs: ReadonlyArray<SearchDoc>
  readonly avgLength: number
}

interface SearchDeps {
  readonly source: WikiSource
  readonly wikiName: string
  readonly wikiHomepage: string
  readonly telemetry?: (event: SearchTelemetry) => void
}

export interface SearchTelemetry {
  readonly tool: 'procedure_search'
  readonly ts: string
  readonly callerId: string
  readonly callerName: string
  readonly query: string
  readonly topResultId: string | null
  readonly resultCount: number
  readonly durationMs: number
  readonly errorClass?: 'no-index' | 'empty-query'
}

const defaultTelemetry = (event: SearchTelemetry): void => {
  try { console.error('procedure_search_telemetry ' + JSON.stringify(event)) } catch { /* never crash */ }
}

interface IndexCache {
  index: SearchIndex
  fetchedAt: number
  // Inverted index: term → Map<docIdx, term-frequency>
  inverted: Map<string, Map<number, number>>
  // Per-doc length (cached as array for fast lookup)
  docLengths: number[]
}
const INDEX_TTL_MS = 5 * 60 * 1000

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by',
  'do', 'does', 'either', 'for', 'from', 'has', 'have', 'if', 'in',
  'into', 'is', 'it', 'its', 'no', 'not', 'of', 'on', 'or', 'other',
  'per', 'so', 'than', 'that', 'the', 'their', 'them', 'then', 'this',
  'to', 'was', 'were', 'will', 'with', 'within', 'when', 'while',
])

const tokenizeQuery = (q: string): string[] => {
  // Same shape as the build-time tokenizer: lowercase, drop stopwords,
  // turn «TAG» → tag-<lower>, split on non-alphanumeric. Don't filter
  // procmd-noise here — a query for "check sg level" should still match
  // even though `check` is stopworded at index time (BM25 score will be
  // tiny but the result list won't be empty if there's a partial match).
  const flat = q.replace(/«([A-Z][A-Z0-9-]*)»/g, ' tag-$1 ').toLowerCase()
  const tokens = flat.split(/[^a-z0-9-]+/).filter(Boolean)
  return tokens.filter(t => t.length > 1 && !STOPWORDS.has(t))
}

const buildInverted = (index: SearchIndex): { inverted: Map<string, Map<number, number>>; docLengths: number[] } => {
  const inverted = new Map<string, Map<number, number>>()
  const docLengths = new Array(index.docs.length).fill(0)
  for (let i = 0; i < index.docs.length; i++) {
    const doc = index.docs[i]!
    docLengths[i] = doc.length
    const tokens = doc.text.split(/\s+/).filter(Boolean)
    for (const t of tokens) {
      const lc = t.toLowerCase()
      let postings = inverted.get(lc)
      if (!postings) { postings = new Map(); inverted.set(lc, postings) }
      postings.set(i, (postings.get(i) ?? 0) + 1)
    }
  }
  return { inverted, docLengths }
}

const BM25_K1 = 1.5
const BM25_B = 0.75

interface ScoredResult {
  procedureId: string
  title: string
  score: number
  matchedTerms: string[]
}

const score = (queryTokens: string[], cache: IndexCache): ScoredResult[] => {
  const N = cache.docLengths.length
  const docScores = new Map<number, { score: number; matched: Set<string> }>()
  for (const q of queryTokens) {
    const postings = cache.inverted.get(q)
    if (!postings || postings.size === 0) continue
    const df = postings.size
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
    for (const [docIdx, tf] of postings) {
      const dl = cache.docLengths[docIdx]!
      const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / cache.index.avgLength))
      const contrib = idf * (tf * (BM25_K1 + 1)) / denom
      let entry = docScores.get(docIdx)
      if (!entry) { entry = { score: 0, matched: new Set() }; docScores.set(docIdx, entry) }
      entry.score += contrib
      entry.matched.add(q)
    }
  }
  const out: ScoredResult[] = []
  for (const [docIdx, entry] of docScores) {
    const doc = cache.index.docs[docIdx]!
    out.push({
      procedureId: doc.procedureId,
      title: doc.title,
      score: entry.score,
      matchedTerms: [...entry.matched].sort(),
    })
  }
  out.sort((a, b) => b.score - a.score)
  return out
}

/** Exported for test injection: constructs the tool from already-built
 *  deps (e.g. a fake `source` returning a fixture index). Production
 *  callers use `createProcedureSearchTool` which wires the real
 *  WikiSource. */
export const buildProcedureSearchTool = (deps: SearchDeps): Tool => {
  let indexCache: IndexCache | null = null

  const getIndex = async (): Promise<IndexCache | null> => {
    const now = Date.now()
    if (indexCache && now - indexCache.fetchedAt < INDEX_TTL_MS) return indexCache
    let raw: string
    try {
      raw = await deps.source.fetchPage('wiki/_search-index.json')
    } catch {
      return null
    }
    try {
      const parsed = JSON.parse(raw) as Partial<SearchIndex>
      if (parsed.version !== 1 || !Array.isArray(parsed.docs)) return null
      const idx = parsed as SearchIndex
      const { inverted, docLengths } = buildInverted(idx)
      indexCache = { index: idx, fetchedAt: now, inverted, docLengths }
      return indexCache
    } catch {
      return null
    }
  }

  return {
    name: 'procedure_search',
    description:
      'Symptom-driven search over Westinghouse PWR emergency procedures. ' +
      'Pass a free-text query describing what is wrong (e.g. "subcooling lost", "steam generator level low", "boron dilution alarm"); ' +
      'the tool returns up to 5 procedures ranked by BM25 relevance, with the procmd id, title, score, and which query terms matched.',
    usage:
      'Pass `query` (required, free text). Optional `limit` (default 5, max 10). ' +
      'Tag refs in the query (e.g. «PT-455») are recognised and contribute to scoring.',
    returns: 'A markdown string with the ranked procedure list. Each result is a clickable id + title + score + matched-terms summary.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text symptom description.' },
        limit: { type: 'number', description: 'Max results (default 5, max 10).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    execute: async (params, context): Promise<ToolResult> => {
      const t0 = Date.now()
      const query = typeof params.query === 'string' ? params.query.trim() : ''
      const limit = Math.max(1, Math.min(10, Number(params.limit) || 5))
      const emit = deps.telemetry ?? defaultTelemetry
      const fire = (topId: string | null, resultCount: number, errorClass?: SearchTelemetry['errorClass']): void => {
        emit({
          tool: 'procedure_search',
          ts: new Date().toISOString(),
          callerId: context.callerId,
          callerName: context.callerName,
          query,
          topResultId: topId,
          resultCount,
          durationMs: Date.now() - t0,
          ...(errorClass ? { errorClass } : {}),
        })
      }

      if (!query) {
        fire(null, 0, 'empty-query')
        return { success: false, error: 'query is required (free text describing the symptom or condition you are looking for)' }
      }
      const cache = await getIndex()
      if (!cache) {
        fire(null, 0, 'no-index')
        return { success: false, error: `${deps.wikiName} search index unavailable. The wiki must publish _search-index.json.` }
      }
      const tokens = tokenizeQuery(query)
      if (tokens.length === 0) {
        fire(null, 0, 'empty-query')
        return {
          success: true,
          data: `No searchable tokens in query "${query}" (all words were stopwords). Try more specific symptom language — e.g. tag names (\`«PT-455»\`), procedure terms (\`subcooling\`, \`pressurizer\`), or system names.`,
        }
      }
      const results = score(tokens, cache).slice(0, limit)
      const top = results[0]?.procedureId ?? null
      fire(top, results.length)

      if (results.length === 0) {
        return {
          success: true,
          data: `No procedures matched query \`${query}\` (searched terms: ${tokens.map(t => `\`${t}\``).join(', ')}). Try alternative wording or check the available procedures via \`procedure_lookup\` with no id.`,
        }
      }
      const lines: string[] = [`## Procedure search — \`${query}\``, '']
      lines.push(`Searched terms: ${tokens.map(t => `\`${t}\``).join(', ')}`)
      lines.push('')
      for (const r of results) {
        lines.push(`- **${r.procedureId}** — ${r.title}`)
        lines.push(`  score \`${r.score.toFixed(2)}\` · matched ${r.matchedTerms.map(t => `\`${t}\``).join(', ')}`)
      }
      lines.push('')
      lines.push(`Call \`procedure_lookup({ id: "<id>" })\` for the full procedure text.`)
      return { success: true, data: lines.join('\n') }
    },
  }
}

export const createProcedureSearchTool = (
  binding: WikiSourceBinding,
  wikiName: string,
  wikiHomepage: string,
  telemetry?: (event: SearchTelemetry) => void,
): Tool => buildProcedureSearchTool({
  source: createWikiSource(binding),
  wikiName,
  wikiHomepage,
  ...(telemetry ? { telemetry } : {}),
})
