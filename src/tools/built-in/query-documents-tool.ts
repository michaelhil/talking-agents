// ============================================================================
// query_documents — built-in tool. Searches the per-instance document
// corpus (PDFs, markdown, plain text uploaded via /api/documents) for
// chunks similar to the agent's query.
//
// Filter:
//   docIds?: string[]   restrict to specific documents in the instance
//
// Returns up to k hits (default 5, capped at 20). Each hit:
//   { text, docId, filename, chunkIdx, score }
// ============================================================================

import type { Tool } from '../../core/types/tool.ts'
import type { ProviderKeys } from '../../llm/provider-keys.ts'
import type { VectorStore } from '../../embed/vector-store.ts'
import { embedTexts, type EmbedProvider } from '../../embed/embedder.ts'
import { resolveEmbedder } from '../../embed/embed-resolver.ts'
import { buildEmbeddingProvidersFromKeys } from '../../embed/memory-indexer.ts'

export interface QueryDocumentsToolDeps {
  readonly vectorStore: VectorStore
  readonly providerKeys: ProviderKeys
}

const MAX_K = 20
const DEFAULT_K = 5

export const createQueryDocumentsTool = (deps: QueryDocumentsToolDeps): Tool => ({
  name: 'query_documents',
  description:
    'Searches the document corpus uploaded to this samsinn instance ' +
    '(PDFs, markdown, plain text) for passages similar to your query.',
  usage:
    'Use when the user references uploaded documents — "what does the spec ' +
    'say about X", "search my notes for Y". Cite filename + chunk index in ' +
    'your reply. Empty result means no documents matched; do not fabricate.',
  returns:
    'Array of { text, docId, filename, chunkIdx, score } — empty if no matches.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural-language description of what to find.' },
      docIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional. Restrict to these specific document IDs.',
      },
      k: {
        type: 'number',
        description: `Optional. Max hits to return (1–${MAX_K}, default ${DEFAULT_K}).`,
      },
    },
    required: ['query'],
  },
  execute: async (params) => {
    const query = String(params.query ?? '').trim()
    if (!query) return { success: false, error: 'query_documents requires a non-empty query' }

    const k = Math.max(1, Math.min(MAX_K, Math.trunc(Number(params.k ?? DEFAULT_K)) || DEFAULT_K))
    const docIdSet = Array.isArray(params.docIds) && params.docIds.length > 0
      ? new Set((params.docIds as unknown[]).filter(v => typeof v === 'string') as string[])
      : null

    const bound = deps.vectorStore.getBinding()
    if (!bound) return { success: true, data: [] }  // no docs ingested yet

    const resolved = resolveEmbedder({
      providers: buildEmbeddingProvidersFromKeys(deps.providerKeys),
      bound: { provider: bound.provider as EmbedProvider, model: bound.model, dim: bound.dim },
    })
    if (resolved.status !== 'ok') {
      return { success: false, error: resolved.reason }
    }

    let queryVector: ReadonlyArray<number>
    try {
      const r = await embedTexts({
        texts: [query],
        provider: resolved.provider,
        model: resolved.model,
        apiKey: resolved.apiKey,
      })
      queryVector = r.vectors[0]!
    } catch (err) {
      return { success: false, error: `embedding failed: ${(err as Error).message}` }
    }

    await deps.vectorStore.load()
    const hits = deps.vectorStore.search(queryVector, 'document', {
      k,
      filter: docIdSet
        ? ({ metadata }) => typeof metadata.docId === 'string' && docIdSet.has(metadata.docId)
        : undefined,
    })
    return {
      success: true,
      data: hits.map(h => ({
        text: h.text,
        docId: h.metadata.docId,
        filename: h.metadata.filename ?? null,
        chunkIdx: h.metadata.chunkIdx,
        score: Math.round(h.score * 1000) / 1000,
      })),
    }
  },
})
