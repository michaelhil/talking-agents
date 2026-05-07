import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createVectorStore, VectorStoreBindingError } from './vector-store.ts'

const tempStorePath = async (): Promise<{ path: string; cleanup: () => Promise<void> }> => {
  const dir = await mkdtemp(join(tmpdir(), 'vector-store-test-'))
  return {
    path: join(dir, 'vectors.jsonl'),
    cleanup: async () => { await rm(dir, { recursive: true, force: true }) },
  }
}

const fakeVec = (seed: number, dim: number): number[] => {
  // Deterministic non-zero vector
  const out = new Array<number>(dim)
  let s = seed
  for (let i = 0; i < dim; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    out[i] = ((s & 0xffff) / 0xffff) - 0.5
  }
  return out
}

describe('vector-store', () => {
  test('first add commits binding; second add with mismatched dim throws', async () => {
    const { path, cleanup } = await tempStorePath()
    try {
      const store = createVectorStore(path)
      await store.add(
        [{ id: 'a', namespace: 'memory', text: 'hello', metadata: {}, vector: fakeVec(1, 8) }],
        { provider: 'openai', model: 'text-embedding-3-small', dim: 8 },
      )
      const b = store.getBinding()
      expect(b).toEqual({ provider: 'openai', model: 'text-embedding-3-small', dim: 8 })

      // Mismatched provider
      await expect(store.add(
        [{ id: 'b', namespace: 'memory', text: 'world', metadata: {}, vector: fakeVec(2, 8) }],
        { provider: 'gemini', model: 'text-embedding-004', dim: 8 },
      )).rejects.toThrow(VectorStoreBindingError)

      // Mismatched dim on a same-binding write
      await expect(store.add(
        [{ id: 'c', namespace: 'memory', text: 'oops', metadata: {}, vector: fakeVec(3, 16) }],
        { provider: 'openai', model: 'text-embedding-3-small', dim: 16 },
      )).rejects.toThrow(VectorStoreBindingError)
    } finally {
      await cleanup()
    }
  })

  test('search returns top-K within namespace; respects filter', async () => {
    const { path, cleanup } = await tempStorePath()
    try {
      const store = createVectorStore(path)
      const binding = { provider: 'openai', model: 'text-embedding-3-small', dim: 8 }
      const recs = [
        { id: 'm1', namespace: 'memory' as const, text: 'memory one',     metadata: { roomId: 'r1' }, vector: fakeVec(1, 8) },
        { id: 'm2', namespace: 'memory' as const, text: 'memory two',     metadata: { roomId: 'r2' }, vector: fakeVec(2, 8) },
        { id: 'd1', namespace: 'document' as const, text: 'document one', metadata: { docId: 'da' }, vector: fakeVec(3, 8) },
      ]
      await store.add(recs, binding)

      // Query close to m1
      const hits = store.search(fakeVec(1, 8), 'memory', { k: 5 })
      expect(hits.length).toBe(2)
      expect(hits[0]!.id).toBe('m1')  // self-match top
      expect(hits[0]!.score).toBeGreaterThan(0.99)

      // Filter to just r1
      const filtered = store.search(fakeVec(1, 8), 'memory', {
        k: 5,
        filter: ({ metadata }) => metadata.roomId === 'r1',
      })
      expect(filtered.length).toBe(1)
      expect(filtered[0]!.id).toBe('m1')

      // Document namespace returns only document records
      const docHits = store.search(fakeVec(3, 8), 'document', { k: 5 })
      expect(docHits.length).toBe(1)
      expect(docHits[0]!.id).toBe('d1')
    } finally {
      await cleanup()
    }
  })

  test('delete tombstones records; search excludes them', async () => {
    const { path, cleanup } = await tempStorePath()
    try {
      const store = createVectorStore(path)
      const binding = { provider: 'openai', model: 'text-embedding-3-small', dim: 8 }
      await store.add([
        { id: 'a', namespace: 'memory', text: 'a', metadata: {}, vector: fakeVec(10, 8) },
        { id: 'b', namespace: 'memory', text: 'b', metadata: {}, vector: fakeVec(20, 8) },
      ], binding)

      const before = store.search(fakeVec(10, 8), 'memory', { k: 5 })
      expect(before.map(h => h.id)).toContain('a')

      const deleted = await store.delete(['a'])
      expect(deleted).toBe(1)

      const after = store.search(fakeVec(10, 8), 'memory', { k: 5 })
      expect(after.map(h => h.id)).not.toContain('a')

      const stats = store.count()
      expect(stats.tombstoned).toBe(1)
      expect(stats.live).toBe(1)
    } finally {
      await cleanup()
    }
  })

  test('persists to disk and loads back; binding survives restart', async () => {
    const { path, cleanup } = await tempStorePath()
    try {
      // First store: write some records
      const s1 = createVectorStore(path)
      const binding = { provider: 'openai', model: 'text-embedding-3-small', dim: 8 }
      await s1.add([
        { id: 'a', namespace: 'memory', text: 'persisted', metadata: { foo: 'bar' }, vector: fakeVec(7, 8) },
      ], binding)
      await s1.delete(['nonexistent'])  // no-op tombstone (id not present)

      // Inspect raw file
      const raw = await readFile(path, 'utf-8')
      const lines = raw.split('\n').filter(l => l.length > 0)
      expect(lines.length).toBeGreaterThanOrEqual(2)  // header + vector

      // Second store: load and search
      const s2 = createVectorStore(path)
      await s2.load()
      const b = s2.getBinding()
      expect(b).toEqual(binding)
      const hits = s2.search(fakeVec(7, 8), 'memory', { k: 1 })
      expect(hits.length).toBe(1)
      expect(hits[0]!.id).toBe('a')
      expect(hits[0]!.metadata.foo).toBe('bar')
    } finally {
      await cleanup()
    }
  })

  test('compactIfNeeded rewrites file when dead-rate > 50%', async () => {
    const { path, cleanup } = await tempStorePath()
    try {
      const store = createVectorStore(path)
      const binding = { provider: 'openai', model: 'text-embedding-3-small', dim: 8 }
      await store.add([
        { id: 'a', namespace: 'memory', text: 'a', metadata: {}, vector: fakeVec(1, 8) },
        { id: 'b', namespace: 'memory', text: 'b', metadata: {}, vector: fakeVec(2, 8) },
        { id: 'c', namespace: 'memory', text: 'c', metadata: {}, vector: fakeVec(3, 8) },
      ], binding)
      // Tombstone 2/3
      await store.delete(['a', 'b'])

      const result = await store.compactIfNeeded()
      expect(result.rewrote).toBe(true)
      expect(result.before).toBe(3)
      expect(result.after).toBe(1)

      const stats = store.count()
      expect(stats.tombstoned).toBe(0)
      expect(stats.live).toBe(1)
    } finally {
      await cleanup()
    }
  })

  test('compactIfNeeded skips when dead-rate <= 50%', async () => {
    const { path, cleanup } = await tempStorePath()
    try {
      const store = createVectorStore(path)
      const binding = { provider: 'openai', model: 'text-embedding-3-small', dim: 8 }
      await store.add([
        { id: 'a', namespace: 'memory', text: 'a', metadata: {}, vector: fakeVec(1, 8) },
        { id: 'b', namespace: 'memory', text: 'b', metadata: {}, vector: fakeVec(2, 8) },
      ], binding)
      await store.delete(['a'])  // 1/2 dead — exactly 50%, should NOT rewrite

      const result = await store.compactIfNeeded()
      expect(result.rewrote).toBe(false)
    } finally {
      await cleanup()
    }
  })
})
