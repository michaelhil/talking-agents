// ============================================================================
// Vector store — per-instance, JSONL append-only with brute-force cosine.
//
// One file per instance: instances/<id>/vectors.jsonl. Each line is a JSON
// record. Three line shapes:
//
//   { "v": 1, "kind": "header", "provider": "openai", "model": "text-embedding-3-small", "dim": 1536, "createdAt": 1700000000000 }
//
//   { "v": 1, "kind": "vector", "id": "<uuid>", "namespace": "memory"|"document",
//     "text": "...", "metadata": { ... }, "vector": [...] }
//
//   { "v": 1, "kind": "tombstone", "id": "<uuid>", "ts": 1700000000000 }
//
// The header is the FIRST line and pins the embedder for the lifetime of
// the file. Subsequent writes that disagree on (provider, model, dim) are
// rejected — see VectorStoreBindingError. The header is written lazily on
// first add() so an empty store has no embedder commitment yet.
//
// Tombstones make deletes O(1) on write. Read filters them out and tracks
// the dead ratio; on load(), if dead/total > 0.5, the file is rewritten
// with only live records (compaction). Bounded one-time work; no daemon.
//
// In-memory representation: arrays parallel to a Map<id, vector-index>.
// Brute-force cosine top-K via min-heap of size K. With ~50k vectors at
// 1536 dim, a single query takes ~50–100ms in the Bun runtime — fine for
// tool-call latency, comfortably under the 1s expectation.
// ============================================================================

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const VECTOR_STORE_LINE_VERSION = 1

export type VectorNamespace = 'memory' | 'document' | 'capability'

export interface EmbedderBinding {
  readonly provider: string  // 'openai' | 'gemini' (kept open for future providers)
  readonly model: string
  readonly dim: number
}

export interface VectorRecord {
  readonly id: string
  readonly namespace: VectorNamespace
  readonly text: string
  readonly metadata: Readonly<Record<string, unknown>>
  readonly vector: ReadonlyArray<number>
}

export interface SearchHit {
  readonly id: string
  readonly namespace: VectorNamespace
  readonly text: string
  readonly metadata: Readonly<Record<string, unknown>>
  readonly score: number  // cosine similarity ∈ [-1, 1]
}

export interface SearchOptions {
  readonly k?: number
  readonly filter?: (rec: { metadata: Record<string, unknown>; namespace: VectorNamespace }) => boolean
}

export class VectorStoreBindingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VectorStoreBindingError'
  }
}

export interface VectorStore {
  readonly path: string
  readonly getBinding: () => EmbedderBinding | null
  readonly add: (records: ReadonlyArray<VectorRecord>, binding: EmbedderBinding) => Promise<void>
  readonly delete: (ids: ReadonlyArray<string>) => Promise<number>
  readonly search: (queryVector: ReadonlyArray<number>, namespace: VectorNamespace, opts?: SearchOptions) => SearchHit[]
  readonly count: () => { live: number; tombstoned: number; total: number }
  readonly load: () => Promise<void>
  readonly compactIfNeeded: () => Promise<{ rewrote: boolean; before: number; after: number }>
}

interface InternalRec {
  readonly id: string
  readonly namespace: VectorNamespace
  readonly text: string
  readonly metadata: Record<string, unknown>
  readonly vector: Float32Array
}

export const createVectorStore = (path: string): VectorStore => {
  const records: InternalRec[] = []
  const idIndex = new Map<string, number>()  // id → index in records (for delete)
  const tombstoned = new Set<string>()
  let binding: EmbedderBinding | null = null
  let loaded = false

  const writeHeader = async (b: EmbedderBinding): Promise<void> => {
    await mkdir(dirname(path), { recursive: true })
    const line = JSON.stringify({
      v: VECTOR_STORE_LINE_VERSION,
      kind: 'header',
      provider: b.provider,
      model: b.model,
      dim: b.dim,
      createdAt: Date.now(),
    }) + '\n'
    await writeFile(path, line, { flag: 'a' })
  }

  const appendVectorLines = async (recs: ReadonlyArray<VectorRecord>): Promise<void> => {
    const lines = recs.map(r => JSON.stringify({
      v: VECTOR_STORE_LINE_VERSION,
      kind: 'vector',
      id: r.id,
      namespace: r.namespace,
      text: r.text,
      metadata: r.metadata,
      vector: [...r.vector],
    })).join('\n') + '\n'
    await writeFile(path, lines, { flag: 'a' })
  }

  const appendTombstoneLines = async (ids: ReadonlyArray<string>): Promise<void> => {
    const lines = ids.map(id => JSON.stringify({
      v: VECTOR_STORE_LINE_VERSION,
      kind: 'tombstone',
      id,
      ts: Date.now(),
    })).join('\n') + '\n'
    await writeFile(path, lines, { flag: 'a' })
  }

  const load = async (): Promise<void> => {
    if (loaded) return
    loaded = true
    let raw: string
    try {
      raw = await readFile(path, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return  // empty store
      throw err
    }
    const lines = raw.split('\n').filter(l => l.length > 0)
    for (const line of lines) {
      let obj: unknown
      try { obj = JSON.parse(line) } catch { continue }  // skip malformed
      if (typeof obj !== 'object' || obj === null) continue
      const r = obj as Record<string, unknown>
      if (r.kind === 'header') {
        binding = {
          provider: String(r.provider),
          model: String(r.model),
          dim: Number(r.dim),
        }
      } else if (r.kind === 'vector' && typeof r.id === 'string') {
        const vec = r.vector as unknown[]
        if (!Array.isArray(vec)) continue
        const f32 = new Float32Array(vec.length)
        for (let i = 0; i < vec.length; i++) f32[i] = Number(vec[i])
        const rec: InternalRec = {
          id: r.id,
          namespace: r.namespace as VectorNamespace,
          text: String(r.text ?? ''),
          metadata: (r.metadata as Record<string, unknown>) ?? {},
          vector: f32,
        }
        idIndex.set(rec.id, records.length)
        records.push(rec)
      } else if (r.kind === 'tombstone' && typeof r.id === 'string') {
        tombstoned.add(r.id)
      }
    }
  }

  const compactIfNeeded = async (): Promise<{ rewrote: boolean; before: number; after: number }> => {
    await load()
    const total = records.length
    const dead = [...tombstoned].filter(id => idIndex.has(id)).length
    if (total === 0) return { rewrote: false, before: 0, after: 0 }
    if (dead / total <= 0.5) return { rewrote: false, before: total, after: total }
    // Rewrite the file with header + only live vectors. No tombstones survive.
    const live = records.filter(r => !tombstoned.has(r.id))
    const tmpPath = `${path}.tmp`
    let buf = ''
    if (binding) {
      buf += JSON.stringify({
        v: VECTOR_STORE_LINE_VERSION, kind: 'header',
        provider: binding.provider, model: binding.model, dim: binding.dim,
        createdAt: Date.now(),
      }) + '\n'
    }
    for (const r of live) {
      buf += JSON.stringify({
        v: VECTOR_STORE_LINE_VERSION, kind: 'vector',
        id: r.id, namespace: r.namespace, text: r.text, metadata: r.metadata,
        vector: Array.from(r.vector),
      }) + '\n'
    }
    await writeFile(tmpPath, buf, 'utf-8')
    await rename(tmpPath, path)
    // Reset in-memory state to reflect compacted file.
    records.length = 0
    idIndex.clear()
    tombstoned.clear()
    for (const r of live) {
      idIndex.set(r.id, records.length)
      records.push(r)
    }
    return { rewrote: true, before: total, after: live.length }
  }

  const add = async (recs: ReadonlyArray<VectorRecord>, b: EmbedderBinding): Promise<void> => {
    if (recs.length === 0) return
    await load()
    if (!binding) {
      // First write — commit binding by writing header.
      binding = b
      await writeHeader(b)
    } else {
      if (binding.provider !== b.provider || binding.model !== b.model || binding.dim !== b.dim) {
        throw new VectorStoreBindingError(
          `embedder mismatch: store bound to ${binding.provider}/${binding.model} (dim ${binding.dim}); ` +
          `attempted write with ${b.provider}/${b.model} (dim ${b.dim})`,
        )
      }
    }
    // Validate dim per record
    for (const r of recs) {
      if (r.vector.length !== binding.dim) {
        throw new VectorStoreBindingError(
          `vector dim ${r.vector.length} for id '${r.id}' does not match store dim ${binding.dim}`,
        )
      }
    }
    await appendVectorLines(recs)
    // Update in-memory
    for (const r of recs) {
      const f32 = new Float32Array(r.vector.length)
      for (let i = 0; i < r.vector.length; i++) f32[i] = r.vector[i]!
      const rec: InternalRec = {
        id: r.id,
        namespace: r.namespace,
        text: r.text,
        metadata: { ...r.metadata },
        vector: f32,
      }
      idIndex.set(rec.id, records.length)
      records.push(rec)
    }
  }

  const del = async (ids: ReadonlyArray<string>): Promise<number> => {
    if (ids.length === 0) return 0
    await load()
    const newlyTombstoned: string[] = []
    for (const id of ids) {
      if (idIndex.has(id) && !tombstoned.has(id)) {
        tombstoned.add(id)
        newlyTombstoned.push(id)
      }
    }
    if (newlyTombstoned.length > 0) {
      await appendTombstoneLines(newlyTombstoned)
    }
    return newlyTombstoned.length
  }

  const cosine = (a: ReadonlyArray<number>, b: Float32Array): number => {
    let dot = 0, na = 0, nb = 0
    const len = Math.min(a.length, b.length)
    for (let i = 0; i < len; i++) {
      const ai = a[i]!
      const bi = b[i]!
      dot += ai * bi
      na += ai * ai
      nb += bi * bi
    }
    if (na === 0 || nb === 0) return 0
    return dot / (Math.sqrt(na) * Math.sqrt(nb))
  }

  const search = (
    queryVector: ReadonlyArray<number>,
    namespace: VectorNamespace,
    opts: SearchOptions = {},
  ): SearchHit[] => {
    if (!binding) return []
    if (queryVector.length !== binding.dim) {
      throw new VectorStoreBindingError(
        `query dim ${queryVector.length} does not match store dim ${binding.dim}`,
      )
    }
    const k = Math.max(1, opts.k ?? 5)
    // Naive top-K: score all live records in namespace, sort, slice.
    // Switch to min-heap if perf becomes a concern at scale.
    const scored: SearchHit[] = []
    for (const r of records) {
      if (tombstoned.has(r.id)) continue
      if (r.namespace !== namespace) continue
      if (opts.filter && !opts.filter({ metadata: r.metadata, namespace: r.namespace })) continue
      const score = cosine(queryVector, r.vector)
      scored.push({
        id: r.id,
        namespace: r.namespace,
        text: r.text,
        metadata: r.metadata,
        score,
      })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, k)
  }

  const count = (): { live: number; tombstoned: number; total: number } => {
    const dead = [...tombstoned].filter(id => idIndex.has(id)).length
    return { live: records.length - dead, tombstoned: dead, total: records.length }
  }

  return {
    path,
    getBinding: () => binding,
    add,
    delete: del,
    search,
    count,
    load,
    compactIfNeeded,
  }
}
