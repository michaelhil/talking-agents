// ============================================================================
// recall — built-in tool. Searches the per-instance vector store for
// previously-said messages similar to the agent's query. Hits include
// sender + room + timestamp so the agent can cite specifically.
//
// Scope filter:
//   "instance"     — search every room in this instance (default)
//   "room:<name>"  — only the named room (resolves via house.getRoom)
//
// Returns up to k hits (default 5, capped at 20). Each hit:
//   { text, roomName, senderName, timestamp, score }
//
// Failure modes:
//   - Embedder unconfigured/stuck: tool returns error explaining what to do.
//   - Vector store empty / no matches: returns empty array (success).
// ============================================================================

import type { Tool } from '../../core/types/tool.ts'
import type { House } from '../../core/types/room.ts'
import type { ProviderKeys } from '../../llm/provider-keys.ts'
import type { VectorStore } from '../../embed/vector-store.ts'
import { embedTexts, type EmbedProvider } from '../../embed/embedder.ts'
import { resolveEmbedder } from '../../embed/embed-resolver.ts'
import { buildEmbeddingProvidersFromKeys } from '../../embed/memory-indexer.ts'

export interface RecallToolDeps {
  readonly vectorStore: VectorStore
  readonly providerKeys: ProviderKeys
  readonly house: House
}

const MAX_K = 20
const DEFAULT_K = 5

export const createRecallTool = (deps: RecallToolDeps): Tool => ({
  name: 'recall',
  description:
    'Searches long-term conversation memory across this samsinn instance for ' +
    'messages similar to your query. Use to recall what was said in this or ' +
    'another room, possibly weeks ago, after summary-compression has folded ' +
    'the original messages out of live history.',
  usage:
    'Call when the user asks about something that may be in the past — ' +
    '"what did we decide about X", "who suggested Y last week". The hits ' +
    'cite roomName + senderName + timestamp so you can attribute claims. ' +
    'Empty result means nothing similar was found; do not fabricate.',
  returns:
    'Array of { text, roomName, senderName, timestamp (ISO), score } — empty if no matches.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural-language description of what to find.' },
      scope: {
        type: 'string',
        description:
          'Optional. "instance" (default) searches all rooms; "room:<name>" scopes to one room.',
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
    if (!query) return { success: false, error: 'recall requires a non-empty query' }

    const scopeRaw = typeof params.scope === 'string' ? params.scope.trim() : ''
    const k = Math.max(1, Math.min(MAX_K, Math.trunc(Number(params.k ?? DEFAULT_K)) || DEFAULT_K))

    let scopedRoomId: string | undefined
    if (scopeRaw && scopeRaw !== 'instance') {
      if (!scopeRaw.startsWith('room:')) {
        return { success: false, error: `unknown scope '${scopeRaw}'. Use "instance" or "room:<name>".` }
      }
      const roomName = scopeRaw.slice('room:'.length).trim()
      if (!roomName) return { success: false, error: 'room scope requires a non-empty name after "room:"' }
      const room = deps.house.getRoom(roomName)
      if (!room) return { success: false, error: `room '${roomName}' not found` }
      scopedRoomId = room.profile.id
    }

    // Resolve embedder, honouring the existing vector-store binding.
    const bound = deps.vectorStore.getBinding()
    const resolved = resolveEmbedder({
      providers: buildEmbeddingProvidersFromKeys(deps.providerKeys),
      bound: bound
        ? { provider: bound.provider as EmbedProvider, model: bound.model, dim: bound.dim }
        : null,
    })
    if (resolved.status === 'unconfigured') {
      return { success: false, error: resolved.reason }
    }
    if (resolved.status === 'stuck') {
      return { success: false, error: resolved.reason }
    }

    // Vector store may be empty / unbound — return [] gracefully.
    if (!bound) {
      return { success: true, data: [] }
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
    const hits = deps.vectorStore.search(queryVector, 'memory', {
      k,
      filter: scopedRoomId
        ? ({ metadata }) => metadata.roomId === scopedRoomId
        : undefined,
    })

    return {
      success: true,
      data: hits.map(h => ({
        text: h.text,
        roomName: h.metadata.roomName ?? h.metadata.roomId,
        senderName: h.metadata.senderName,
        timestamp: typeof h.metadata.ts === 'number'
          ? new Date(h.metadata.ts).toISOString()
          : null,
        score: Math.round(h.score * 1000) / 1000,
      })),
    }
  },
})
