import { describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Message } from '../core/types/messaging.ts'
import type { ProviderKeys } from '../llm/provider-keys.ts'
import { createVectorStore } from './vector-store.ts'
import { createMemoryIndexer, buildEmbeddingProvidersFromKeys } from './memory-indexer.ts'

const tempPath = async (): Promise<{ path: string; cleanup: () => Promise<void> }> => {
  const dir = await mkdtemp(join(tmpdir(), 'mem-indexer-test-'))
  return {
    path: join(dir, 'vectors.jsonl'),
    cleanup: async () => { await rm(dir, { recursive: true, force: true }) },
  }
}

const mkMsg = (overrides: Partial<Message> = {}): Message => ({
  id: overrides.id ?? crypto.randomUUID(),
  roomId: overrides.roomId ?? 'r1',
  senderId: overrides.senderId ?? 's1',
  senderName: overrides.senderName ?? 'Alice',
  content: overrides.content ?? 'hello world',
  timestamp: overrides.timestamp ?? 1_700_000_000_000,
  type: overrides.type ?? 'chat',
  ...overrides,
})

const mkProviderKeys = (keys: { openai?: string; gemini?: string }): ProviderKeys => {
  const state = new Map<string, { apiKey: string; userEnabled: boolean }>([
    ['openai', { apiKey: keys.openai ?? '', userEnabled: true }],
    ['gemini', { apiKey: keys.gemini ?? '', userEnabled: true }],
  ])
  return {
    get: (n) => state.get(n)?.apiKey ?? '',
    set: (n, k) => { const e = state.get(n); if (e) state.set(n, { ...e, apiKey: k }) },
    isEnabled: (n) => {
      const e = state.get(n); return !!e && e.apiKey.length > 0 && e.userEnabled
    },
    isUserEnabled: (n) => state.get(n)?.userEnabled ?? false,
    setEnabled: (n, en) => { const e = state.get(n); if (e) state.set(n, { ...e, userEnabled: en }) },
    list: () => [],
  }
}

// Stub fetch to return a deterministic vector for any embedTexts call.
const stubFetch = (dim: number): typeof globalThis.fetch => {
  const fn = (async (url: unknown, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}')
    const inputs: string[] = body.input ?? body.requests?.map((r: { content: { parts: { text: string }[] } }) => r.content.parts[0]!.text) ?? []
    const vectors = inputs.map((text, i) => {
      const seed = text.length + i * 7
      return Array.from({ length: dim }, (_, j) => Math.sin(seed + j * 0.1))
    })
    const isGemini = String(url).includes('googleapis.com')
    if (isGemini) {
      return new Response(JSON.stringify({ embeddings: vectors.map(v => ({ values: v })) }), { status: 200 })
    }
    return new Response(JSON.stringify({
      data: vectors.map((v, idx) => ({ embedding: v, index: idx })),
      model: 'text-embedding-3-small',
    }), { status: 200 })
  })
  return fn as unknown as typeof globalThis.fetch
}

describe('memory-indexer', () => {
  test('embeds chat messages and writes vectors with rich metadata', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = stubFetch(8)
    try {
      const { path, cleanup } = await tempPath()
      try {
        const store = createVectorStore(path)
        const indexer = createMemoryIndexer({
          vectorStore: store,
          getProviders: () => buildEmbeddingProvidersFromKeys(mkProviderKeys({ openai: 'sk-test' })),
          getRoomName: () => 'general',
          log: () => { /* silent */ },
        })

        await indexer.handleCompressionStart('r1', [
          mkMsg({ id: 'm1', content: 'first message', senderName: 'Alice' }),
          mkMsg({ id: 'm2', content: 'second message', senderName: 'Bob' }),
        ], 'summary text')

        const stats = store.count()
        expect(stats.live).toBe(2)
        const binding = store.getBinding()
        expect(binding?.provider).toBe('openai')
        expect(binding?.dim).toBe(8)

        // Confirm metadata round-trips correctly
        const hits = store.search(
          Array.from({ length: 8 }, (_, j) => Math.sin('first message'.length + j * 0.1)),
          'memory',
          { k: 5 },
        )
        expect(hits.length).toBe(2)
        const m1Hit = hits.find(h => h.metadata.messageId === 'm1')
        expect(m1Hit).toBeDefined()
        expect(m1Hit!.metadata.roomName).toBe('general')
        expect(m1Hit!.metadata.senderName).toBe('Alice')
        expect(m1Hit!.metadata.foldId).toBeDefined()
        // Both messages share the same foldId (same compression batch)
        expect(hits[0]!.metadata.foldId).toBe(hits[1]!.metadata.foldId)
      } finally {
        await cleanup()
      }
    } finally {
      globalThis.fetch = origFetch
    }
  })

  test('skips room_summary messages — only chat messages get indexed', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = stubFetch(8)
    try {
      const { path, cleanup } = await tempPath()
      try {
        const store = createVectorStore(path)
        const indexer = createMemoryIndexer({
          vectorStore: store,
          getProviders: () => buildEmbeddingProvidersFromKeys(mkProviderKeys({ openai: 'sk-test' })),
          getRoomName: () => 'r1',
          log: () => {},
        })

        await indexer.handleCompressionStart('r1', [
          mkMsg({ id: 'sum', type: 'room_summary', content: 'prior summary' }),
          mkMsg({ id: 'm1', type: 'chat', content: 'real message' }),
        ], 'new summary')

        expect(store.count().live).toBe(1)
      } finally {
        await cleanup()
      }
    } finally {
      globalThis.fetch = origFetch
    }
  })

  test('logs and returns when embedder is unconfigured (no key) — does not throw', async () => {
    const { path, cleanup } = await tempPath()
    try {
      const store = createVectorStore(path)
      const logCalls: string[] = []
      const indexer = createMemoryIndexer({
        vectorStore: store,
        getProviders: () => buildEmbeddingProvidersFromKeys(mkProviderKeys({})),  // no keys
        getRoomName: () => 'r1',
        log: (msg) => logCalls.push(msg),
      })

      // Should not throw — compression should still proceed.
      await indexer.handleCompressionStart('r1', [mkMsg({ content: 'x' })], 'sum')

      expect(store.count().live).toBe(0)
      expect(logCalls.some(m => m.includes('embedder unresolved'))).toBe(true)
    } finally {
      await cleanup()
    }
  })

  test('no chat messages → no embedding call, no write', async () => {
    let fetchCalls = 0
    const origFetch = globalThis.fetch
    globalThis.fetch = mock(async () => {
      fetchCalls++
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    }) as unknown as typeof globalThis.fetch
    try {
      const { path, cleanup } = await tempPath()
      try {
        const store = createVectorStore(path)
        const indexer = createMemoryIndexer({
          vectorStore: store,
          getProviders: () => buildEmbeddingProvidersFromKeys(mkProviderKeys({ openai: 'sk-test' })),
          getRoomName: () => 'r1',
          log: () => {},
        })

        await indexer.handleCompressionStart('r1', [
          mkMsg({ type: 'room_summary', content: 'summary only' }),
        ], 'new')

        expect(fetchCalls).toBe(0)
        expect(store.count().live).toBe(0)
      } finally {
        await cleanup()
      }
    } finally {
      globalThis.fetch = origFetch
    }
  })

  test('cross-instance isolation: two stores never see each other\'s data', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = stubFetch(8)
    try {
      const a = await tempPath()
      const b = await tempPath()
      try {
        const storeA = createVectorStore(a.path)
        const storeB = createVectorStore(b.path)
        const mkIndexer = (store: typeof storeA) => createMemoryIndexer({
          vectorStore: store,
          getProviders: () => buildEmbeddingProvidersFromKeys(mkProviderKeys({ openai: 'sk-test' })),
          getRoomName: () => 'r1',
          log: () => {},
        })

        await mkIndexer(storeA).handleCompressionStart('rA', [
          mkMsg({ content: 'instance A secret' }),
        ], 'sA')
        await mkIndexer(storeB).handleCompressionStart('rB', [
          mkMsg({ content: 'instance B unrelated' }),
        ], 'sB')

        expect(storeA.count().live).toBe(1)
        expect(storeB.count().live).toBe(1)

        // Search in A using B's seed shouldn't find B's content
        const aHits = storeA.search(
          Array.from({ length: 8 }, (_, j) => Math.sin('instance A secret'.length + j * 0.1)),
          'memory',
          { k: 5 },
        )
        expect(aHits.length).toBe(1)
        expect(aHits[0]!.text).toContain('instance A')
      } finally {
        await a.cleanup()
        await b.cleanup()
      }
    } finally {
      globalThis.fetch = origFetch
    }
  })
})
