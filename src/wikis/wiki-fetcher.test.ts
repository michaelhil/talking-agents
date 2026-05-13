import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { createWikiSource, extractProcedureIds } from './wiki-fetcher.ts'
import type { WikiSourceBinding } from '../packs/types.ts'

const BINDING: WikiSourceBinding = {
  org: 'samsinn-wikis',
  repo: 'pwr-eops',
  branch: 'main',
  procedureDir: 'wiki/procedures',
  indexFile: 'wiki/index.md',
  citationBase: 'https://samsinn-wikis.github.io/pwr-eops/procedures/',
}

const installFetchMock = (responder: (url: string) => Response | Promise<Response>): () => void => {
  const original = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString()
    return Promise.resolve(responder(url))
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

describe('createWikiSource', () => {
  let restore: () => void
  beforeEach(() => { restore = () => {} })
  afterEach(() => restore())

  test('builds citation + raw URLs from the binding', () => {
    const src = createWikiSource(BINDING)
    expect(src.citationUrl('E-0')).toBe('https://samsinn-wikis.github.io/pwr-eops/procedures/E-0/')
    expect(src.rawUrl('E-0')).toBe('https://raw.githubusercontent.com/samsinn-wikis/pwr-eops/main/wiki/procedures/E-0.md')
  })

  test('fetchProcedure hits raw.githubusercontent with the right path', async () => {
    const calls: string[] = []
    restore = installFetchMock((url) => {
      calls.push(url)
      return new Response('# E-0 content', { status: 200 })
    })
    const src = createWikiSource(BINDING)
    const got = await src.fetchProcedure('E-0')
    expect(got).toBe('# E-0 content')
    expect(calls[0]).toBe('https://raw.githubusercontent.com/samsinn-wikis/pwr-eops/main/wiki/procedures/E-0.md')
  })

  test('second call within TTL uses the buffer (no re-fetch)', async () => {
    let hits = 0
    restore = installFetchMock(() => { hits += 1; return new Response('cached', { status: 200 }) })
    const src = createWikiSource(BINDING, 60_000)
    await src.fetchProcedure('E-0')
    await src.fetchProcedure('E-0')
    expect(hits).toBe(1)
  })

  test('call past TTL re-fetches', async () => {
    let hits = 0
    restore = installFetchMock(() => { hits += 1; return new Response('fresh', { status: 200 }) })
    const src = createWikiSource(BINDING, 1)
    await src.fetchProcedure('E-0')
    await new Promise(r => setTimeout(r, 5))
    await src.fetchProcedure('E-0')
    expect(hits).toBe(2)
  })

  test('HTTP error throws with id + status', async () => {
    restore = installFetchMock(() => new Response('not found', { status: 404 }))
    const src = createWikiSource(BINDING)
    await expect(src.fetchProcedure('XYZ-99')).rejects.toThrow(/HTTP 404/)
    await expect(src.fetchProcedure('XYZ-99')).rejects.toThrow(/samsinn-wikis\/pwr-eops/)
  })
})

describe('extractProcedureIds', () => {
  test('finds [[ID]] wikilinks, dedupes, preserves order', () => {
    const md = `
# Index
- [[E-0]] Reactor Trip
- [[E-1]] LOCA
- See also [[E-0]] (referenced again)
- [[ECA-0.0]] Loss of AC
- [[FR-S.1]] ATWS
`
    expect(extractProcedureIds(md)).toEqual(['E-0', 'E-1', 'ECA-0.0', 'FR-S.1'])
  })

  test('ignores non-procmd wikilinks (lowercase, starts-with-digit)', () => {
    const md = `[[foo-bar]] [[123-abc]] [[E-0]]`
    expect(extractProcedureIds(md)).toEqual(['E-0'])
  })

  test('empty when no wikilinks', () => {
    expect(extractProcedureIds('# Nothing here')).toEqual([])
  })
})

describe('wiki-fetcher — GitHub Pages fallback for manifest', () => {
  const BINDING = {
    org: 'samsinn-wikis',
    repo: 'pwr-eops',
    branch: 'main',
    procedureDir: 'wiki/procedures',
    indexFile: 'wiki/index.md',
    manifestFile: 'wiki/_manifest.json',
    citationBase: 'https://samsinn-wikis.github.io/pwr-eops/procedures/',
  }

  test('falls back to GitHub Pages mirror when raw.githubusercontent 404s', async () => {
    const MANIFEST = JSON.stringify({ version: 1, wiki: 'pwr-eops', procedures: [{ id: 'X-1' }] })
    const original = globalThis.fetch
    let rawCalls = 0
    let pagesCalls = 0
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.startsWith('https://raw.githubusercontent.com/')) {
        rawCalls += 1
        return Promise.resolve(new Response('rate limited', { status: 429 }))
      }
      if (url === 'https://samsinn-wikis.github.io/pwr-eops/_manifest.json') {
        pagesCalls += 1
        return Promise.resolve(new Response(MANIFEST, { status: 200 }))
      }
      return Promise.resolve(new Response('404', { status: 404 }))
    }) as typeof fetch

    try {
      const src = createWikiSource(BINDING)
      const manifest = await src.fetchManifest()
      expect(manifest).not.toBeNull()
      expect(manifest!.procedures[0]!.id).toBe('X-1')
      expect(rawCalls).toBe(1)
      expect(pagesCalls).toBe(1)
    } finally {
      globalThis.fetch = original
    }
  })

  test('procedure markdown does NOT have a Pages fallback (no sidecar published)', async () => {
    const original = globalThis.fetch
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.startsWith('https://raw.githubusercontent.com/')) {
        return Promise.resolve(new Response('boom', { status: 503 }))
      }
      return Promise.resolve(new Response('404', { status: 404 }))
    }) as typeof fetch
    try {
      const src = createWikiSource(BINDING)
      await expect(src.fetchProcedure('E-0')).rejects.toThrow(/HTTP 503/)
    } finally {
      globalThis.fetch = original
    }
  })
})
