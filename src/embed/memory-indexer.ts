// ============================================================================
// Memory indexer — captures compression batches into the per-instance
// vector store so agents can later `recall` them.
//
// Wired into SummaryEngineDeps.onCompressionStart. Fires right before the
// room splices the raw messages out of its delivery stream — this is the
// only point where we have the full Message objects.
//
// Each chat message in the batch becomes one vector record:
//   namespace: 'memory'
//   text:      message content
//   metadata:  { roomId, roomName, foldId, messageId, senderName, ts, batchSize }
//
// foldId is shared across all records produced by one compression call,
// so future queries can group results by fold.
// ============================================================================

import type { Message } from '../core/types/messaging.ts'
import { embedTextsBatched, type EmbedProvider } from './embedder.ts'
import { resolveEmbedder } from './embed-resolver.ts'
import type { VectorStore, VectorRecord } from './vector-store.ts'
import type { MergedProviders } from '../llm/providers-store.ts'

export interface MemoryIndexerDeps {
  readonly vectorStore: VectorStore
  readonly getProviders: () => MergedProviders
  readonly getRoomName: (roomId: string) => string | undefined
  readonly log?: (msg: string) => void
}

export interface MemoryIndexer {
  readonly handleCompressionStart: (
    roomId: string,
    candidates: ReadonlyArray<Message>,
    newSummaryText: string,
  ) => Promise<void>
}

export const createMemoryIndexer = (deps: MemoryIndexerDeps): MemoryIndexer => {
  const log = deps.log ?? ((msg: string) => console.warn(`[memory-indexer] ${msg}`))

  const handleCompressionStart = async (
    roomId: string,
    candidates: ReadonlyArray<Message>,
    _newSummaryText: string,
  ): Promise<void> => {
    // Only embed chat messages — skip prior room_summary entries (they
    // would re-embed compressed-of-compressed text, which is fine in
    // theory but rarely useful for recall — recall wants original speech).
    const chatMsgs = candidates.filter(m => m.type === 'chat')
    if (chatMsgs.length === 0) return

    // Resolve embedder. Honour the existing binding if present.
    const bound = deps.vectorStore.getBinding()
    const resolved = resolveEmbedder({
      providers: deps.getProviders(),
      bound: bound
        ? { provider: bound.provider as EmbedProvider, model: bound.model, dim: bound.dim }
        : null,
    })
    if (resolved.status !== 'ok') {
      // Don't throw — compression should still proceed; we just lose this
      // batch's recall data. Log loudly so the user can fix the config.
      log(`embedder unresolved (${resolved.status}): ${resolved.reason}`)
      return
    }

    const texts = chatMsgs.map(m => m.content)
    let result
    try {
      result = await embedTextsBatched({
        texts,
        provider: resolved.provider,
        model: resolved.model,
        apiKey: resolved.apiKey,
      })
    } catch (err) {
      log(`embedding failed for room ${roomId}: ${(err as Error).message}`)
      return
    }

    const foldId = crypto.randomUUID()
    const ts = Date.now()
    const roomName = deps.getRoomName(roomId)
    const records: VectorRecord[] = chatMsgs.map((msg, i): VectorRecord => ({
      id: `mem:${msg.id}`,
      namespace: 'memory',
      text: msg.content,
      metadata: {
        roomId,
        roomName: roomName ?? roomId,
        foldId,
        messageId: msg.id,
        senderName: msg.senderName ?? msg.senderId,
        ts: msg.timestamp,
        batchSize: chatMsgs.length,
      },
      vector: result.vectors[i]!,
    }))

    try {
      await deps.vectorStore.add(records, {
        provider: resolved.provider,
        model: resolved.model,
        dim: result.dim,
      })
    } catch (err) {
      log(`vector-store write failed for room ${roomId}: ${(err as Error).message}`)
      // No retry — next compression of the same room will pick up new
      // messages. The lost batch is acceptable; corrupting the store
      // would not be.
    }
    log(`indexed ${records.length} message(s) from room ${roomId} (fold ${foldId.slice(0, 8)}, ts ${new Date(ts).toISOString()})`)
  }

  return { handleCompressionStart }
}

// --- Helper: build a MergedProviders snapshot from ProviderKeys ---------- //
// memory-indexer + recall tool both need to know "which embedding provider
// is currently configured", but ProviderKeys (the in-memory mutable key
// store) doesn't track stored embeddingModel preferences. This helper
// merges what ProviderKeys has with env-var overrides for embeddingModel,
// producing the shape resolveEmbedder expects.
//
// Note: stored embeddingModel from providers.json is intentionally NOT
// consulted here — keeps the indexer state-free. Honoured only via env
// override (PROVIDER_EMBEDDING_MODEL) at this layer. UI / API can still
// persist the stored value; v1 just doesn't read it back without a
// process restart. Lift this if it becomes important.

import type { ProviderKeys } from '../llm/provider-keys.ts'
import { maskKey } from '../llm/providers-store.ts'

export const buildEmbeddingProvidersFromKeys = (
  providerKeys: ProviderKeys,
  env: Record<string, string | undefined> = process.env,
): MergedProviders => {
  const mkEntry = (name: 'openai' | 'gemini') => {
    const apiKey = providerKeys.get(name)
    const enabled = providerKeys.isEnabled(name)
    const envModel = env[`${name.toUpperCase()}_EMBEDDING_MODEL`]?.trim()
    return {
      apiKey,
      source: apiKey ? 'env' as const : 'none' as const,
      enabled,
      maxConcurrent: undefined,
      maskedKey: maskKey(apiKey),
      pinnedModels: [] as ReadonlyArray<string>,
      baseUrl: undefined,
      embeddingModel: (envModel && envModel.length > 0) ? envModel : undefined,
    }
  }
  return {
    cloud: { openai: mkEntry('openai'), gemini: mkEntry('gemini') },
    ollama: { enabled: false, maxConcurrent: undefined },
  }
}
