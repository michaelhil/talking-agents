import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGeoAddTool, createGeoListCategoriesTool, createGeoListFeaturesTool, createGeoLookupTool, createGeoRemoveTool } from './geo-tools.ts'
import { upsertFeature } from '../../geo/store.ts'
import type { GeoFeature, MarkerIcon } from '../../geo/types.ts'

let prevHome: string | undefined
let testDir: string

const fakeContext = { callerId: 'agent-x', callerName: 'Agent X' }

// Under the derived-categories model, a category exists iff a feature
// carries that id. Most tests just write the features they care about
// and the category emerges. This helper is for tests that need a
// category to exist WITHOUT pinning the test to a specific feature
// (e.g. "errors when categoryHint is missing" — needs *some* category).
// Returns the seed feature's id so the test can ignore it in assertions.
const seedEmptyCategory = async (id: string, icon: MarkerIcon = 'pin'): Promise<void> => {
  await upsertFeature({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [0, 0] },
    properties: {
      id: `__seed-${id}__`,
      name: `__seed-${id}__`,
      category: id,
      verified: true,
      source: 'local',
      category_display: id,
      category_icon: icon,
    },
  })
}
const seedCategory = seedEmptyCategory

const makeFeature = (name: string, lat: number, lng: number, verified: boolean, category = 'city'): GeoFeature => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lng, lat] },
  properties: {
    id: `local-${name.toLowerCase()}`,
    name,
    category,
    verified,
    source: 'local',
  },
})

beforeEach(() => {
  prevHome = process.env.SAMSINN_HOME
  testDir = mkdtempSync(join(tmpdir(), 'samsinn-geo-tools-test-'))
  process.env.SAMSINN_HOME = testDir
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.SAMSINN_HOME
  else process.env.SAMSINN_HOME = prevHome
  rmSync(testDir, { recursive: true, force: true })
})

describe('geo_lookup', () => {
  const tool = createGeoLookupTool()

  test('finds verified local feature in registered category', async () => {
    await seedCategory('city')
    await upsertFeature(makeFeature('Bergen', 60.39, 5.32, true))
    const r = await tool.execute({ query: 'Bergen', category: 'city' }, fakeContext as never)
    expect(r.success).toBe(true)
    if (r.success) {
      const data = r.data as { features: { lat: number; lng: number; label: string; icon?: string }[]; source: string }
      expect(data.features[0]?.label).toBe('Bergen')
      expect(data.features[0]?.icon).toBe('pin')
      expect(data.source).toBe('local')
    }
  })

  test('hard-refuses unknown category', async () => {
    const r = await tool.execute({ query: 'Bergen', category: 'unknown-cat' }, fakeContext as never)
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error).toMatch(/not registered/)
  })

  test('rejects empty query', async () => {
    await seedCategory('city')
    const r = await tool.execute({ query: '   ', category: 'city' }, fakeContext as never)
    expect(r.success).toBe(false)
  })
})

describe('geo_add + geo_remove', () => {
  const addTool = createGeoAddTool()
  const removeTool = createGeoRemoveTool()

  test('add then remove roundtrip', async () => {
    await seedCategory('landmark')
    const r = await addTool.execute({
      name: 'Test Place', lat: 60.0, lng: 5.0, category: 'landmark',
    }, fakeContext as never)
    expect(r.success).toBe(true)
    if (!r.success) throw new Error('expected success')
    const id = (r.data as { id: string }).id
    const rem = await removeTool.execute({ id, category: 'landmark' }, fakeContext as never)
    expect(rem.success).toBe(true)
    if (rem.success) expect((rem.data as { removed: boolean }).removed).toBe(true)
  })

  test('geo_add hard-refuses unknown category', async () => {
    const r = await addTool.execute({
      name: 'Test', lat: 60, lng: 5, category: 'unknown-cat',
    }, fakeContext as never)
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error).toMatch(/not registered/)
  })

  test('geo_remove refuses curated entries', async () => {
    await seedCategory('city')
    await upsertFeature(makeFeature('Bergen', 60.39, 5.32, true))
    const r = await removeTool.execute({ id: 'local-bergen', category: 'city' }, fakeContext as never)
    expect(r.success).toBe(false)
  })

  test('geo_add blocked by curated entry returns added=false', async () => {
    await seedCategory('city')
    await upsertFeature(makeFeature('Bergen', 60.39, 5.32, true))
    const r = await addTool.execute({
      name: 'Bergen', lat: 0, lng: 0, category: 'city',
    }, fakeContext as never)
    expect(r.success).toBe(true)
    if (r.success) expect((r.data as { added: boolean }).added).toBe(false)
  })
})

describe('geo_list_categories', () => {
  const tool = createGeoListCategoriesTool()
  test('empty on fresh install', async () => {
    const r = await tool.execute({}, fakeContext as never)
    expect(r.success).toBe(true)
    if (r.success) expect((r.data as unknown[]).length).toBe(0)
  })

  test('returns registered categories with counts', async () => {
    await upsertFeature(makeFeature('Horns Rev 1', 55.49, 7.84, true, 'wind-farm'))
    const r = await tool.execute({}, fakeContext as never)
    expect(r.success).toBe(true)
    if (r.success) {
      const rows = r.data as Array<{ id: string; featureCount: number }>
      expect(rows.length).toBe(1)
      expect(rows[0]?.id).toBe('wind-farm')
      expect(rows[0]?.featureCount).toBe(1)
    }
  })
})

describe('geo_list_features', () => {
  const tool = createGeoListFeaturesTool()

  const seedFeature = async (name: string, lat: number, lng: number, props: Partial<GeoFeature['properties']> = {}): Promise<void> => {
    await upsertFeature({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
      properties: {
        id: `local-${name.toLowerCase().replace(/\s+/g, '-')}`,
        name,
        category: 'oil-platforms',
        verified: true,
        source: 'local',
        ...props,
      },
    })
  }

  test('errors when no categories registered', async () => {
    const r = await tool.execute({ category: 'oil-platforms' }, fakeContext as never)
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error).toMatch(/no geo categories/)
  })

  test('errors when neither category nor categoryHint given', async () => {
    await seedCategory('oil-platforms')
    const r = await tool.execute({}, fakeContext as never)
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error).toMatch(/category.*or.*categoryHint/i)
  })

  test('exact category id returns all features as map envelope', async () => {
    await seedFeature('Statfjord A', 61.25, 1.85, { country: 'NO', operator: 'Equinor' })
    await seedFeature('Snorre B', 61.45, 2.16, { country: 'NO', operator: 'Equinor' })
    const r = await tool.execute({ category: 'oil-platforms' }, fakeContext as never)
    expect(r.success).toBe(true)
    if (r.success) {
      const d = r.data as { features: unknown[]; count: number; source: string }
      expect(d.count).toBe(2)
      expect(d.features.length).toBe(2)
      expect(d.source).toBe('merged')
    }
  })

  test('country filter narrows results', async () => {
    await seedFeature('Statfjord A', 61.25, 1.85, { country: 'NO' })
    await seedFeature('Brent C', 61.0, 1.7, { country: 'GB' })
    const r = await tool.execute({ category: 'oil-platforms', country: 'NO' }, fakeContext as never)
    expect(r.success).toBe(true)
    if (r.success) {
      const d = r.data as { count: number }
      expect(d.count).toBe(1)
    }
  })

  test('country filter accepts adjectival form ("norwegian")', async () => {
    // LLMs reliably pass adjectival forms instead of ISO codes. Pre-fix,
    // these returned 0 features and triggered retry loops. Normalisation
    // maps norwegian → NO so the filter still works.
    await seedFeature('Statfjord A', 61.25, 1.85, { country: 'NO' })
    await seedFeature('Brent C', 61.0, 1.7, { country: 'GB' })
    const r = await tool.execute({ category: 'oil-platforms', country: 'norwegian' }, fakeContext as never)
    expect(r.success).toBe(true)
    if (r.success) {
      const d = r.data as { count: number }
      expect(d.count).toBe(1)
    }
  })

  test('country filter accepts full country name ("Norway")', async () => {
    await seedFeature('Statfjord A', 61.25, 1.85, { country: 'NO' })
    await seedFeature('Brent C', 61.0, 1.7, { country: 'GB' })
    const r = await tool.execute({ category: 'oil-platforms', country: 'Norway' }, fakeContext as never)
    expect(r.success).toBe(true)
    if (r.success) {
      const d = r.data as { count: number }
      expect(d.count).toBe(1)
    }
  })

  test('country filter still works with raw ISO code', async () => {
    // Regression: alpha-2 short-circuit doesn't break legitimate ISO usage.
    await seedFeature('Brent C', 61.0, 1.7, { country: 'GB' })
    const r = await tool.execute({ category: 'oil-platforms', country: 'gb' }, fakeContext as never)
    expect(r.success).toBe(true)
    if (r.success) {
      const d = r.data as { count: number }
      expect(d.count).toBe(1)
    }
  })

  test('categoryHint matches by displayName substring', async () => {
    // Seed a feature with explicit category metadata so the projection
    // picks up "Oil Platforms" as the displayName.
    await upsertFeature({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [1.85, 61.25] },
      properties: {
        id: 'no-statfjord-a',
        name: 'Statfjord A',
        category: 'oil-platforms',
        verified: true,
        source: 'local',
        country: 'NO',
        category_display: 'Oil Platforms',
        category_icon: 'pin',
      },
    })
    const r = await tool.execute({ categoryHint: 'oil platform' }, fakeContext as never)
    expect(r.success).toBe(true)
    if (r.success) {
      const d = r.data as { category: string }
      expect(d.category).toBe('oil-platforms')
    }
  })

  test('categoryHint surfaces ambiguity with candidates', async () => {
    // Two categories with overlapping displayName substrings ("oil").
    await upsertFeature({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: {
        id: 'plat-1', name: 'Plat 1', category: 'oil-platforms',
        verified: true, source: 'local',
        category_display: 'Oil Platforms', category_icon: 'pin',
      },
    })
    await upsertFeature({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: {
        id: 'rig-1', name: 'Rig 1', category: 'oil-rigs',
        verified: true, source: 'local',
        category_display: 'Oil Rigs (legacy)', category_icon: 'pin',
      },
    })
    const r = await tool.execute({ categoryHint: 'oil' }, fakeContext as never)
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error).toMatch(/ambiguous/)
      const e = r as unknown as { candidates: Array<{ id: string }> }
      expect(e.candidates.length).toBe(2)
    }
  })

  test('limit caps results and reports truncation', async () => {
    for (let i = 0; i < 5; i++) {
      await seedFeature(`Platform ${i}`, 60 + i * 0.1, 1 + i * 0.1)
    }
    const r = await tool.execute({ category: 'oil-platforms', limit: 3 }, fakeContext as never)
    expect(r.success).toBe(true)
    if (r.success) {
      const d = r.data as { count: number; truncated: boolean; totalMatched: number }
      expect(d.count).toBe(3)
      expect(d.truncated).toBe(true)
      expect(d.totalMatched).toBe(5)
    }
  })

  test('view fits multi-point bbox', async () => {
    await seedFeature('A', 60, 1)
    await seedFeature('B', 62, 3)
    const r = await tool.execute({ category: 'oil-platforms' }, fakeContext as never)
    expect(r.success).toBe(true)
    if (r.success) {
      const d = r.data as { view?: { center: [number, number]; zoom: number } }
      expect(d.view).toBeDefined()
      expect(d.view!.center[0]).toBeCloseTo(61, 0)
      expect(d.view!.center[1]).toBeCloseTo(2, 0)
    }
  })
})
