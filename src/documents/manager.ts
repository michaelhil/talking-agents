// ============================================================================
// Document manager — orchestrates upload, extraction, chunking, embedding,
// and deletion for the per-instance document corpus.
//
// In-memory state mirrors what's on disk. createDocumentManager(rootDir)
// builds it; load() scans the directory and rebuilds metadata + resumes
// pending indexing jobs (a process restart mid-index leaves a .pending
// marker; load() re-enqueues those documents).
//
// All state-changing operations are awaitable. The indexer runs as
// fire-and-forget after upload — caller doesn't await it; the UI/agent
// polls metadata via list() to see status transitions, or subscribes
// to onStatusChange for WS broadcasting.
// ============================================================================

import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { ALLOWED_EXTENSIONS, MAX_UPLOAD_BYTES, type DocumentMetadata, type AllowedExtension } from './types.ts'
import { extractFromBytes, ExtractError } from './extractor.ts'
import { chunkText } from './chunker.ts'
import { embedTextsBatched, type EmbedProvider } from '../embed/embedder.ts'
import { resolveEmbedder } from '../embed/embed-resolver.ts'
import { buildEmbeddingProvidersFromKeys } from '../embed/memory-indexer.ts'
import type { VectorStore, VectorRecord } from '../embed/vector-store.ts'
import type { ProviderKeys } from '../llm/provider-keys.ts'

export interface DocumentManagerDeps {
  readonly rootDir: string                    // <instance>/documents/
  readonly vectorStore: VectorStore
  readonly providerKeys: ProviderKeys
  readonly onStatusChange?: (meta: DocumentMetadata) => void
  readonly log?: (msg: string) => void
}

export interface DocumentManager {
  readonly load: () => Promise<void>
  readonly list: () => DocumentMetadata[]
  readonly get: (docId: string) => DocumentMetadata | undefined
  readonly upload: (filename: string, bytes: Uint8Array, mimetype: string) => Promise<DocumentMetadata>
  readonly remove: (docId: string) => Promise<boolean>
}

const isAllowed = (ext: string): ext is AllowedExtension =>
  (ALLOWED_EXTENSIONS as ReadonlyArray<string>).includes(ext)

const docDir = (root: string, docId: string): string => join(root, docId)

const readJSON = async <T>(path: string): Promise<T | null> => {
  try {
    const txt = await readFile(path, 'utf-8')
    return JSON.parse(txt) as T
  } catch {
    return null
  }
}

const writeJSON = async (path: string, data: unknown): Promise<void> => {
  await writeFile(path, JSON.stringify(data, null, 2), 'utf-8')
}

const fileExists = async (path: string): Promise<boolean> => {
  try { await stat(path); return true } catch { return false }
}

export const createDocumentManager = (deps: DocumentManagerDeps): DocumentManager => {
  const log = deps.log ?? ((msg: string) => console.warn(`[doc-manager] ${msg}`))
  const docs = new Map<string, DocumentMetadata>()

  // Internal: persist metadata + notify subscriber.
  const updateMeta = async (meta: DocumentMetadata): Promise<void> => {
    docs.set(meta.docId, meta)
    const dir = docDir(deps.rootDir, meta.docId)
    await mkdir(dir, { recursive: true })
    await writeJSON(join(dir, 'metadata.json'), meta)
    deps.onStatusChange?.(meta)
  }

  const writePendingMarker = async (docId: string): Promise<void> => {
    await writeFile(join(docDir(deps.rootDir, docId), '.pending'), '', 'utf-8')
  }
  const clearPendingMarker = async (docId: string): Promise<void> => {
    try { await rm(join(docDir(deps.rootDir, docId), '.pending'), { force: true }) } catch { /* ignore */ }
  }

  // Index a single document. Errors transition status to 'failed'.
  // Designed to be idempotent on the same docId — re-running clears
  // partial vectors first and re-attempts.
  const indexDocument = async (docId: string): Promise<void> => {
    const meta = docs.get(docId)
    if (!meta) return
    const dir = docDir(deps.rootDir, docId)
    const ext = extname(meta.filename).toLowerCase()
    if (!isAllowed(ext)) {
      await updateMeta({ ...meta, status: 'failed', errorMessage: `unsupported extension '${ext}'` })
      await clearPendingMarker(docId)
      return
    }

    // Resolve embedder up front so we fail fast if unconfigured.
    const bound = deps.vectorStore.getBinding()
    const resolved = resolveEmbedder({
      providers: buildEmbeddingProvidersFromKeys(deps.providerKeys),
      bound: bound
        ? { provider: bound.provider as EmbedProvider, model: bound.model, dim: bound.dim }
        : null,
    })
    if (resolved.status !== 'ok') {
      await updateMeta({ ...meta, status: 'failed', errorMessage: resolved.reason })
      await clearPendingMarker(docId)
      return
    }

    // Read original + extract
    let extractedText: string
    let pageCount: number | undefined
    try {
      const bytes = await readFile(join(dir, `original${ext}`))
      const r = await extractFromBytes(new Uint8Array(bytes), ext)
      extractedText = r.text
      pageCount = r.pageCount
      await writeFile(join(dir, 'extracted.txt'), extractedText, 'utf-8')
    } catch (err) {
      const msg = err instanceof ExtractError ? err.message : `read/extract failed: ${(err as Error).message}`
      await updateMeta({ ...meta, status: 'failed', errorMessage: msg })
      await clearPendingMarker(docId)
      return
    }

    // Chunk
    const chunks = chunkText(extractedText)
    if (chunks.length === 0) {
      await updateMeta({ ...meta, status: 'failed', errorMessage: 'no extractable content (zero chunks)' })
      await clearPendingMarker(docId)
      return
    }

    // Wipe any prior partial vectors for this doc (re-index path).
    // We do this by tombstoning chunk IDs predictably named `doc:<docId>:<idx>`.
    // load() doesn't track them; rely on the vector store filter on read.
    const existingIds = chunks.map((_, i) => `doc:${docId}:${i}`)
    await deps.vectorStore.delete(existingIds)

    // Embed
    let result
    try {
      result = await embedTextsBatched({
        texts: chunks.map(c => c.text),
        provider: resolved.provider,
        model: resolved.model,
        apiKey: resolved.apiKey,
      })
    } catch (err) {
      await updateMeta({ ...meta, status: 'failed', errorMessage: `embedding failed: ${(err as Error).message}` })
      await clearPendingMarker(docId)
      return
    }

    // Write vectors
    const records: VectorRecord[] = chunks.map((c, i): VectorRecord => ({
      id: `doc:${docId}:${i}`,
      namespace: 'document',
      text: c.text,
      metadata: {
        docId,
        filename: meta.filename,
        chunkIdx: c.chunkIdx,
        approxTokens: c.approxTokens,
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
      await updateMeta({ ...meta, status: 'failed', errorMessage: `vector-store write: ${(err as Error).message}` })
      await clearPendingMarker(docId)
      return
    }

    await updateMeta({
      ...meta,
      status: 'indexed',
      ...(pageCount !== undefined ? { pageCount } : {}),
      chunkCount: chunks.length,
    })
    await clearPendingMarker(docId)
    log(`indexed ${meta.filename} (${docId.slice(0, 8)}): ${chunks.length} chunk(s)`)
  }

  const load = async (): Promise<void> => {
    docs.clear()
    let entries: string[]
    try {
      entries = await readdir(deps.rootDir)
    } catch {
      return  // dir doesn't exist yet — empty corpus
    }
    const pendingResume: string[] = []
    for (const name of entries) {
      const dir = join(deps.rootDir, name)
      try {
        const s = await stat(dir)
        if (!s.isDirectory()) continue
      } catch {
        continue
      }
      const meta = await readJSON<DocumentMetadata>(join(dir, 'metadata.json'))
      if (!meta) continue
      docs.set(meta.docId, meta)
      // If a .pending marker remains, the indexer didn't finish — re-enqueue
      // (only if status is pending; failed/indexed should not have markers).
      const hasMarker = await fileExists(join(dir, '.pending'))
      if (hasMarker && meta.status === 'pending') pendingResume.push(meta.docId)
    }
    for (const docId of pendingResume) {
      log(`resuming indexing for ${docId.slice(0, 8)} after restart`)
      void indexDocument(docId)
    }
  }

  const list = (): DocumentMetadata[] =>
    [...docs.values()].sort((a, b) => b.uploadTs - a.uploadTs)

  const get = (docId: string): DocumentMetadata | undefined => docs.get(docId)

  const upload = async (
    filename: string,
    bytes: Uint8Array,
    mimetype: string,
  ): Promise<DocumentMetadata> => {
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      throw new Error(`file exceeds ${MAX_UPLOAD_BYTES} byte limit`)
    }
    const ext = extname(filename).toLowerCase()
    if (!isAllowed(ext)) {
      throw new Error(`unsupported extension '${ext}'. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`)
    }
    const docId = crypto.randomUUID()
    const dir = docDir(deps.rootDir, docId)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `original${ext}`), bytes)
    await writePendingMarker(docId)

    const meta: DocumentMetadata = {
      docId,
      filename,
      mimetype,
      sizeBytes: bytes.byteLength,
      uploadTs: Date.now(),
      status: 'pending',
    }
    await updateMeta(meta)

    // Fire-and-forget indexing. Failures are surfaced via metadata.status,
    // not by throwing. The .pending marker stays until indexDocument
    // explicitly removes it — providing a recoverable state on restart.
    void indexDocument(docId)
    return meta
  }

  const remove = async (docId: string): Promise<boolean> => {
    const meta = docs.get(docId)
    if (!meta) return false
    // Tombstone any vectors this doc may have written. We don't track the
    // exact chunk count separately — read it from metadata if indexed,
    // else from a generous range (chunkCount stays undefined for failed
    // docs so we use a large upper bound).
    const upperBound = meta.chunkCount ?? 4096
    const ids = Array.from({ length: upperBound }, (_, i) => `doc:${docId}:${i}`)
    await deps.vectorStore.delete(ids)
    // Remove the on-disk directory.
    try { await rm(docDir(deps.rootDir, docId), { recursive: true, force: true }) } catch { /* ignore */ }
    docs.delete(docId)
    return true
  }

  return { load, list, get, upload, remove }
}
