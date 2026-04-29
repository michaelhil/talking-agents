import { describe, it, expect } from 'bun:test'
import { createWikiRegistry } from './registry.ts'
import type { WikiAdapter } from './github-adapter.ts'
import type { MergedWikiEntry } from './types.ts'

const wiki: MergedWikiEntry = {
  id: 'test',
  owner: 'o',
  repo: 'r',
  ref: 'main',
  displayName: 'Test',
  apiKey: '',
  maskedKey: '',
  enabled: true,
}

const fakeAdapter = (pages: Record<string, string>, indexMd: string, scopeMd?: string): WikiAdapter => ({
  fetchIndex: async () => indexMd,
  fetchScope: async () => scopeMd,
  fetchPage: async (slug) => {
    const body = pages[slug]
    if (body === undefined) throw new Error(`not found: ${slug}`)
    return { path: `wiki/${slug}.md`, body }
  },
  listWikiTree: async () => Object.keys(pages).map((s) => `wiki/${s}.md`),
})

describe('createWikiRegistry', () => {
  it('warm fetches index, scope, and indexed pages', async () => {
    const indexMd = `# Index\n- [[alpha]]\n- [[beta]]\n`
    const adapter = fakeAdapter({
      alpha: `---\ntitle: Alpha\ntags: [s1]\n---\nAlpha body about reactor.`,
      beta: `---\ntitle: Beta\n---\nBeta body links to [[alpha]].`,
    }, indexMd, '# Scope')
    const reg = createWikiRegistry({ wikis: [wiki], adapterFactory: () => adapter })
    const { pageCount, warnings } = await reg.warm('test')
    expect(pageCount).toBe(2)
    expect(warnings).toEqual([])
    expect(reg.getIndex('test')).toContain('[[alpha]]')
    expect(reg.getScope('test')).toBe('# Scope')
    expect(reg.list()[0]?.pageCount).toBe(2)
  })

  it('search finds by title, slug, and body', async () => {
    const indexMd = `- [[reactor-startup]]\n- [[scram]]\n`
    const adapter = fakeAdapter({
      'reactor-startup': `---\ntitle: Reactor Startup\ntype: scenario\n---\nDescribes startup.`,
      scram: `---\ntitle: SCRAM Procedure\ntype: scenario\ntags: [safety]\n---\nEmergency reactor shutdown.`,
    }, indexMd)
    const reg = createWikiRegistry({ wikis: [wiki], adapterFactory: () => adapter })
    await reg.warm('test')
    const hits = reg.search('reactor')
    expect(hits.length).toBeGreaterThanOrEqual(2)
    expect(hits[0]?.slug).toBe('reactor-startup') // exact slug match wins
    const safety = reg.search('', { tag: 'safety' })
    expect(safety.map((h) => h.slug)).toEqual(['scram'])
    const filtered = reg.search('', { type: 'scenario', wikiId: 'test' })
    expect(filtered).toHaveLength(2)
  })

  it('getPage uses cache after warm', async () => {
    let fetches = 0
    const indexMd = `- [[a]]\n`
    const adapter: WikiAdapter = {
      fetchIndex: async () => indexMd,
      fetchScope: async () => undefined,
      fetchPage: async (slug) => { fetches += 1; return { path: `wiki/${slug}.md`, body: `---\ntitle: A\n---\nbody` } },
      listWikiTree: async () => [`wiki/a.md`],
    }
    const reg = createWikiRegistry({ wikis: [wiki], adapterFactory: () => adapter })
    await reg.warm('test')
    expect(fetches).toBe(1)
    const p1 = await reg.getPage('test', 'a')
    const p2 = await reg.getPage('test', 'a')
    expect(p1?.frontmatter.title).toBe('A')
    expect(p2?.slug).toBe('a')
    expect(fetches).toBe(1) // cached
  })

  it('getPage falls back to network on cache miss', async () => {
    let fetches = 0
    const adapter: WikiAdapter = {
      fetchIndex: async () => '',
      fetchScope: async () => undefined,
      fetchPage: async (slug) => { fetches += 1; return { path: `wiki/${slug}.md`, body: `---\ntitle: ${slug}\n---\nbody` } },
      listWikiTree: async () => [],
    }
    const reg = createWikiRegistry({ wikis: [wiki], adapterFactory: () => adapter })
    const page = await reg.getPage('test', 'orphan')
    expect(page?.slug).toBe('orphan')
    expect(fetches).toBe(1)
  })

  it('warm is per-wiki', async () => {
    const reg = createWikiRegistry({
      wikis: [wiki, { ...wiki, id: 'other' }],
      adapterFactory: () => fakeAdapter({ x: '---\ntitle: x\n---\n' }, `- [[x]]\n`),
    })
    await reg.warm('test')
    expect(reg.list().find((w) => w.id === 'test')?.pageCount).toBe(1)
    expect(reg.list().find((w) => w.id === 'other')?.pageCount).toBe(0)
  })

  it('reconcile to empty clears state (eviction)', async () => {
    const reg = createWikiRegistry({
      wikis: [wiki],
      adapterFactory: () => fakeAdapter({ x: '---\ntitle: x\n---\n' }, `- [[x]]\n`),
    })
    await reg.warm('test')
    reg.reconcile([])
    expect(reg.getState('test')).toBeUndefined()
    expect(reg.list()).toEqual([])
  })

  it('reconcile is idempotent: same set of wikis is a no-op', () => {
    const reg = createWikiRegistry({
      wikis: [wiki],
      adapterFactory: () => fakeAdapter({}, ''),
    })
    const newWikiCalls: string[] = []
    reg.setOnNewWiki((id) => newWikiCalls.push(id))
    // Initial reconcile with the same wiki — already installed at construction
    // time, should NOT fire onNewWiki again.
    reg.reconcile([wiki])
    reg.reconcile([wiki])
    reg.reconcile([wiki])
    expect(newWikiCalls).toEqual([])
  })

  it('reconcile fires onNewWiki when a new id appears', () => {
    const reg = createWikiRegistry({
      wikis: [],
      adapterFactory: () => fakeAdapter({}, ''),
    })
    const newWikiCalls: string[] = []
    reg.setOnNewWiki((id) => newWikiCalls.push(id))
    reg.reconcile([wiki])
    expect(newWikiCalls).toEqual(['test'])
    // Second reconcile with same set: no extra fires.
    reg.reconcile([wiki])
    expect(newWikiCalls).toEqual(['test'])
  })

  it('reconcile fires onNewWiki when an existing id has a config swap', () => {
    const reg = createWikiRegistry({
      wikis: [wiki],
      adapterFactory: () => fakeAdapter({}, ''),
    })
    const newWikiCalls: string[] = []
    reg.setOnNewWiki((id) => newWikiCalls.push(id))
    // Same id, different ref → re-install + fire.
    const swapped: MergedWikiEntry = { ...wiki, ref: 'develop' }
    reg.reconcile([swapped])
    expect(newWikiCalls).toEqual(['test'])
  })

  it('reconcile evicts removed ids and keeps survivors', async () => {
    const wikiA: MergedWikiEntry = { ...wiki, id: 'a' }
    const wikiB: MergedWikiEntry = { ...wiki, id: 'b' }
    const reg = createWikiRegistry({
      wikis: [wikiA, wikiB],
      adapterFactory: () => fakeAdapter({ x: '---\ntitle: x\n---\n' }, `- [[x]]\n`),
    })
    await reg.warm('a')
    await reg.warm('b')
    expect(reg.list().map((w) => w.id).sort()).toEqual(['a', 'b'])
    reg.reconcile([wikiA])  // drop b
    expect(reg.list().map((w) => w.id)).toEqual(['a'])
    expect(reg.getState('b')).toBeUndefined()
    expect(reg.getState('a')?.pages.size).toBe(1)
  })
})
