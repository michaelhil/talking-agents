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
