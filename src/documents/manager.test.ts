import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ProviderKeys } from '../llm/provider-keys.ts'
import { createVectorStore } from '../embed/vector-store.ts'
import { createDocumentManager } from './manager.ts'

const tempRoot = async (): Promise<{
  vectorsPath: string
  docsRoot: string
  cleanup: () => Promise<void>
}> => {
  const dir = await mkdtemp(join(tmpdir(), 'doc-mgr-test-'))
  return {
    vectorsPath: join(dir, 'vectors.jsonl'),
    docsRoot: join(dir, 'documents'),
    cleanup: async () => { await rm(dir, { recursive: true, force: true }) },
  }
}

const mkProviderKeys = (key: string): ProviderKeys => ({
  get: (n) => n === 'openai' ? key : '',
  set: () => {},
  isEnabled: (n) => n === 'openai' && key.length > 0,
  isUserEnabled: () => true,
  setEnabled: () => {},
  list: () => [],
})

const stubFetch = (dim: number): typeof globalThis.fetch => {
  const fn = (async (_url: unknown, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}')
    const inputs: string[] = body.input ?? []
    const vectors = inputs.map((text, i) => {
      const seed = text.length + i
      return Array.from({ length: dim }, (_, j) => Math.sin(seed + j * 0.1))
    })
    return new Response(JSON.stringify({
      data: vectors.map((v, idx) => ({ embedding: v, index: idx })),
      model: 'text-embedding-3-small',
    }), { status: 200 })
  })
  return fn as unknown as typeof globalThis.fetch
}

describe('document manager', () => {
  test('upload .txt → status indexed; vectors written; metadata persisted', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = stubFetch(8)
    try {
      const { vectorsPath, docsRoot, cleanup } = await tempRoot()
      try {
        const store = createVectorStore(vectorsPath)
        const statusEvents: string[] = []
        const mgr = createDocumentManager({
          rootDir: docsRoot,
          vectorStore: store,
          providerKeys: mkProviderKeys('sk-test'),
          onStatusChange: (m) => statusEvents.push(m.status),
          log: () => {},
        })
        await mgr.load()

        const text = 'paragraph one.\n\nparagraph two.\n\nparagraph three with more content.'
        const meta = await mgr.upload('notes.txt', new TextEncoder().encode(text), 'text/plain')
        expect(meta.status).toBe('pending')

        // Wait for indexing to complete (fire-and-forget)
        await new Promise(r => setTimeout(r, 50))
        const after = mgr.get(meta.docId)
        expect(after?.status).toBe('indexed')
        expect(after?.chunkCount).toBeGreaterThan(0)
        expect(statusEvents).toContain('indexed')

        // Vectors are queryable in the document namespace
        expect(store.count().live).toBeGreaterThan(0)

        // Metadata persisted to disk
        const persisted = JSON.parse(
          await readFile(join(docsRoot, meta.docId, 'metadata.json'), 'utf-8'),
        )
        expect(persisted.status).toBe('indexed')
      } finally {
        await cleanup()
      }
    } finally {
      globalThis.fetch = origFetch
    }
  })

  test('upload rejects oversized + unsupported extension', async () => {
    const { vectorsPath, docsRoot, cleanup } = await tempRoot()
    try {
      const store = createVectorStore(vectorsPath)
      const mgr = createDocumentManager({
        rootDir: docsRoot,
        vectorStore: store,
        providerKeys: mkProviderKeys('sk-test'),
        log: () => {},
      })
      await mgr.load()

      await expect(mgr.upload('foo.docx', new Uint8Array(10), 'app/x'))
        .rejects.toThrow('unsupported extension')
      const huge = new Uint8Array(26 * 1024 * 1024)
      await expect(mgr.upload('big.txt', huge, 'text/plain'))
        .rejects.toThrow('exceeds')
    } finally {
      await cleanup()
    }
  })

  test('remove tombstones vectors and deletes the doc directory', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = stubFetch(8)
    try {
      const { vectorsPath, docsRoot, cleanup } = await tempRoot()
      try {
        const store = createVectorStore(vectorsPath)
        const mgr = createDocumentManager({
          rootDir: docsRoot,
          vectorStore: store,
          providerKeys: mkProviderKeys('sk-test'),
          log: () => {},
        })
        await mgr.load()

        const meta = await mgr.upload(
          'a.txt',
          new TextEncoder().encode('hello\n\nworld'),
          'text/plain',
        )
        await new Promise(r => setTimeout(r, 50))
        expect(mgr.get(meta.docId)?.status).toBe('indexed')
        const liveBefore = store.count().live

        const ok = await mgr.remove(meta.docId)
        expect(ok).toBe(true)
        expect(mgr.get(meta.docId)).toBeUndefined()
        // Vectors tombstoned (live count drops)
        expect(store.count().live).toBeLessThan(liveBefore)
      } finally {
        await cleanup()
      }
    } finally {
      globalThis.fetch = origFetch
    }
  })

  test('upload with no embedder configured → status failed with clear message', async () => {
    const { vectorsPath, docsRoot, cleanup } = await tempRoot()
    try {
      const store = createVectorStore(vectorsPath)
      const mgr = createDocumentManager({
        rootDir: docsRoot,
        vectorStore: store,
        providerKeys: mkProviderKeys(''),  // no key
        log: () => {},
      })
      await mgr.load()

      const meta = await mgr.upload(
        'x.txt',
        new TextEncoder().encode('whatever'),
        'text/plain',
      )
      await new Promise(r => setTimeout(r, 50))
      const final = mgr.get(meta.docId)
      expect(final?.status).toBe('failed')
      expect(final?.errorMessage).toContain('OPENAI_API_KEY')
    } finally {
      await cleanup()
    }
  })

  test('load() resumes pending indexing after restart', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = stubFetch(8)
    try {
      const { vectorsPath, docsRoot, cleanup } = await tempRoot()
      try {
        // Simulate a half-finished upload: directory + metadata + .pending,
        // but no vectors written yet.
        const docId = 'simulated-id'
        const dir = join(docsRoot, docId)
        const { mkdir } = await import('node:fs/promises')
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, 'original.txt'), 'recovered content', 'utf-8')
        await writeFile(join(dir, '.pending'), '', 'utf-8')
        await writeFile(
          join(dir, 'metadata.json'),
          JSON.stringify({
            docId, filename: 'recovered.txt', mimetype: 'text/plain',
            sizeBytes: 17, uploadTs: Date.now(), status: 'pending',
          }),
          'utf-8',
        )

        const store = createVectorStore(vectorsPath)
        const mgr = createDocumentManager({
          rootDir: docsRoot,
          vectorStore: store,
          providerKeys: mkProviderKeys('sk-test'),
          log: () => {},
        })
        await mgr.load()

        // load() re-enqueued indexing; wait for it
        await new Promise(r => setTimeout(r, 50))
        const final = mgr.get(docId)
        expect(final?.status).toBe('indexed')
      } finally {
        await cleanup()
      }
    } finally {
      globalThis.fetch = origFetch
    }
  })
})
