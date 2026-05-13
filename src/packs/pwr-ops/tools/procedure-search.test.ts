import { describe, expect, test } from 'bun:test'
import { buildProcedureSearchTool } from './procedure-search.ts'

const FIXTURE_INDEX = JSON.stringify({
  version: 1,
  wiki: 'pwr-ops',
  avgLength: 22,
  docs: [
    {
      procedureId: 'E-0',
      title: 'Reactor Trip or Safety Injection',
      text: 'safety-injection-actuation reactor-trip-signal core-cooling subcooling pressurizer pressure tag-pt-455 tag-trip-bkr-a tag-trip-bkr-b verify reactor trip breakers',
      length: 22,
    },
    {
      procedureId: 'E-1',
      title: 'Loss of Reactor or Secondary Coolant',
      text: 'loca-symptoms core-cooling rcs-inventory subcooling lost pressurizer pressure tag-pt-455 falling rapidly containment pressure rising loca break',
      length: 21,
    },
    {
      procedureId: 'FR-S.2',
      title: 'Response to Loss of Core Shutdown',
      text: 'csf-orange-path subcriticality boron dilution source-range count rate tag-nis-sr alarm rising emergency boration tag-borate-flow',
      length: 18,
    },
  ],
})

const stubSource = {
  binding: {} as any,
  fetchIndex: async () => '',
  fetchManifest: async () => null,
  fetchProcedure: async () => '',
  fetchPage: async (path: string) => {
    if (path === 'wiki/_search-index.json') return FIXTURE_INDEX
    throw new Error(`unexpected path: ${path}`)
  },
  citationUrl: (id: string) => `https://example.com/${id}`,
  rawUrl: (id: string) => `https://example.com/raw/${id}`,
}

const context = { callerId: 'test', callerName: 'Test' } as any

const newTool = () => buildProcedureSearchTool({
  source: stubSource as any,
  wikiName: 'pwr-ops',
  wikiHomepage: 'https://example.com',
  telemetry: () => {},
})

describe('procedure_search — BM25 ranking', () => {
  test('"boron dilution" ranks FR-S.2 first', async () => {
    const t = newTool()
    const r = await t.execute({ query: 'boron dilution' }, context)
    expect(r.success).toBe(true)
    expect(r.data).toMatch(/FR-S\.2/)
    // FR-S.2 should be the top hit
    const data = String(r.data)
    const frPos = data.indexOf('FR-S.2')
    const eOnePos = data.indexOf('E-1')
    expect(frPos).toBeGreaterThan(-1)
    if (eOnePos > -1) expect(frPos).toBeLessThan(eOnePos)
  })

  test('"loca break pressure rising" ranks E-1 first', async () => {
    const t = newTool()
    const r = await t.execute({ query: 'loca break pressure rising' }, context)
    expect(r.success).toBe(true)
    const data = String(r.data)
    expect(data).toMatch(/E-1/)
    const eOnePos = data.indexOf('E-1')
    const fr = data.indexOf('FR-S.2')
    if (fr > -1) expect(eOnePos).toBeLessThan(fr)
  })

  test('tag-ref query «PT-455» matches procedures that reference it', async () => {
    const t = newTool()
    const r = await t.execute({ query: '«PT-455»' }, context)
    expect(r.success).toBe(true)
    const data = String(r.data)
    expect(data).toMatch(/E-0|E-1/)
  })

  test('all-stopword query returns the friendly hint', async () => {
    const t = newTool()
    const r = await t.execute({ query: 'the and of' }, context)
    expect(r.success).toBe(true)
    expect(String(r.data)).toMatch(/stopwords|searchable tokens/i)
  })

  test('empty query is rejected', async () => {
    const t = newTool()
    const r = await t.execute({ query: '' }, context)
    expect(r.success).toBe(false)
  })

  test('limit parameter clamps results', async () => {
    const t = newTool()
    const r = await t.execute({ query: 'pressure', limit: 1 }, context)
    expect(r.success).toBe(true)
    // Three procedures could match "pressure" but limit=1 means only one
    // result line should appear in the output
    const data = String(r.data)
    const matches = (data.match(/^- \*\*/gm) ?? []).length
    expect(matches).toBe(1)
  })

  test('query with no matches returns explanatory text', async () => {
    const t = newTool()
    const r = await t.execute({ query: 'banana xylophone' }, context)
    expect(r.success).toBe(true)
    expect(String(r.data)).toMatch(/no procedures matched/i)
  })

  test('factory exposes the expected Tool shape', () => {
    const t = newTool()
    expect(t.name).toBe('procedure_search')
    expect(t.parameters?.required).toEqual(['query'])
  })
})
