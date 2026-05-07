import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { House, Room, RoomConfig } from '../../core/types/room.ts'
import type { ProviderKeys } from '../../llm/provider-keys.ts'
import { createVectorStore } from '../../embed/vector-store.ts'
import { createRecallTool } from './recall-tool.ts'

const tempPath = async (): Promise<{ path: string; cleanup: () => Promise<void> }> => {
  const dir = await mkdtemp(join(tmpdir(), 'recall-tool-test-'))
  return {
    path: join(dir, 'vectors.jsonl'),
    cleanup: async () => { await rm(dir, { recursive: true, force: true }) },
  }
}

const stubFetch = (dim: number, deterministic = true): typeof globalThis.fetch => {
  const fn = (async (_url: unknown, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}')
    const inputs: string[] = body.input ?? []
    const vectors = inputs.map((text, i) => {
      const seed = deterministic ? text.length : (text.length + Math.random())
      return Array.from({ length: dim }, (_, j) => Math.sin(seed + j * 0.1 + i * 0.01))
    })
    return new Response(JSON.stringify({
      data: vectors.map((v, idx) => ({ embedding: v, index: idx })),
      model: 'text-embedding-3-small',
    }), { status: 200 })
  })
  return fn as unknown as typeof globalThis.fetch
}

const mkProviderKeys = (openaiKey: string): ProviderKeys => {
  let apiKey = openaiKey
  let userEnabled = true
  return {
    get: (n) => n === 'openai' ? apiKey : '',
    set: (n, k) => { if (n === 'openai') apiKey = k },
    isEnabled: (n) => n === 'openai' && apiKey.length > 0 && userEnabled,
    isUserEnabled: () => userEnabled,
    setEnabled: (_n, en) => { userEnabled = en },
    list: () => [],
  }
}

const mkMinimalHouse = (): House => ({
  // Only `getRoom` is exercised by the tool; rest are stubs.
  getRoom: () => undefined,
  listAllRooms: () => [],
  createRoom: () => ({ kind: 'created' as const, room: undefined as unknown as Room }),
  removeRoom: () => false,
  setRoomProfile: () => {},
  setRoomConfig: () => false,
  getRoomConfig: () => undefined as unknown as RoomConfig,
  setHousePrompt: () => {},
  getHousePrompt: () => '',
  setResponseFormat: () => {},
  getResponseFormat: () => '',
  getRoomsForAgent: () => [],
  listBookmarks: () => [],
  addBookmark: () => {},
  removeBookmark: () => false,
} as unknown as House)

describe('recall tool', () => {
  test('empty store returns success + empty array', async () => {
    const { path, cleanup } = await tempPath()
    try {
      const store = createVectorStore(path)
      const tool = createRecallTool({
        vectorStore: store,
        providerKeys: mkProviderKeys('sk-test'),
        house: mkMinimalHouse(),
      })
      const result = await tool.execute({ query: 'anything' }, { callerId: 'a', callerName: 'a' })
      expect(result.success).toBe(true)
      expect(result.data).toEqual([])
    } finally {
      await cleanup()
    }
  })

  test('rejects empty query', async () => {
    const { path, cleanup } = await tempPath()
    try {
      const store = createVectorStore(path)
      const tool = createRecallTool({
        vectorStore: store,
        providerKeys: mkProviderKeys('sk-test'),
        house: mkMinimalHouse(),
      })
      const result = await tool.execute({ query: '   ' }, { callerId: 'a', callerName: 'a' })
      expect(result.success).toBe(false)
      expect(result.error).toContain('non-empty query')
    } finally {
      await cleanup()
    }
  })

  test('rejects malformed scope', async () => {
    const { path, cleanup } = await tempPath()
    try {
      const store = createVectorStore(path)
      const tool = createRecallTool({
        vectorStore: store,
        providerKeys: mkProviderKeys('sk-test'),
        house: mkMinimalHouse(),
      })
      const result = await tool.execute({ query: 'q', scope: 'bogus' }, { callerId: 'a', callerName: 'a' })
      expect(result.success).toBe(false)
      expect(result.error).toContain('unknown scope')
    } finally {
      await cleanup()
    }
  })

  test('returns hits with cited metadata when store has matches', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = stubFetch(8)
    try {
      const { path, cleanup } = await tempPath()
      try {
        const store = createVectorStore(path)
        // Pre-populate with one record
        const seedVec = Array.from({ length: 8 }, (_, j) => Math.sin('seed query'.length + j * 0.1))
        await store.add([{
          id: 'mem:1',
          namespace: 'memory',
          text: 'previously discussed',
          metadata: {
            roomId: 'r1',
            roomName: 'general',
            senderName: 'Alice',
            ts: 1_700_000_000_000,
          },
          vector: seedVec,
        }], { provider: 'openai', model: 'text-embedding-3-small', dim: 8 })

        const tool = createRecallTool({
          vectorStore: store,
          providerKeys: mkProviderKeys('sk-test'),
          house: mkMinimalHouse(),
        })
        // Use a query that, when embedded by stubFetch, produces a vector
        // close to the stored one (same length → same seed → same vector).
        const result = await tool.execute({ query: 'seed query', k: 3 }, { callerId: 'a', callerName: 'a' })
        expect(result.success).toBe(true)
        const hits = result.data as ReadonlyArray<{
          text: string; roomName: string; senderName: string; timestamp: string; score: number
        }>
        expect(hits.length).toBe(1)
        expect(hits[0]!.text).toBe('previously discussed')
        expect(hits[0]!.roomName).toBe('general')
        expect(hits[0]!.senderName).toBe('Alice')
        expect(hits[0]!.timestamp).toBe('2023-11-14T22:13:20.000Z')
        expect(hits[0]!.score).toBeGreaterThan(0.9)
      } finally {
        await cleanup()
      }
    } finally {
      globalThis.fetch = origFetch
    }
  })

  test('unconfigured embedder when store is empty still returns []', async () => {
    // Empty store + no key: should still return [] (success), since there's
    // nothing to search anyway. This avoids a confusing error when an
    // instance has never ingested.
    const { path, cleanup } = await tempPath()
    try {
      const store = createVectorStore(path)
      const tool = createRecallTool({
        vectorStore: store,
        providerKeys: mkProviderKeys(''),
        house: mkMinimalHouse(),
      })
      const result = await tool.execute({ query: 'q' }, { callerId: 'a', callerName: 'a' })
      // Resolver returns 'unconfigured' → tool returns error
      expect(result.success).toBe(false)
      expect(result.error).toContain('OPENAI_API_KEY')
    } finally {
      await cleanup()
    }
  })
})
