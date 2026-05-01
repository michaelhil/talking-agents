import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { categoryStats, listCategory, lookupInCategory, removeFeature, upsertFeature } from './store.ts'
import type { GeoFeature } from './types.ts'

let prevHome: string | undefined
let testDir: string

const makeFeature = (overrides: Partial<GeoFeature['properties']> & {
  name: string
  lat: number
  lng: number
}): GeoFeature => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [overrides.lng, overrides.lat] },
  properties: {
    id: overrides.id ?? overrides.name.toLowerCase().replace(/\s+/g, '-'),
    name: overrides.name,
    category: overrides.category ?? 'city',
    verified: overrides.verified ?? false,
    source: overrides.source ?? 'local',
    ...(overrides.aliases ? { aliases: overrides.aliases } : {}),
  },
})

beforeEach(() => {
  prevHome = process.env.SAMSINN_HOME
  testDir = mkdtempSync(join(tmpdir(), 'samsinn-geo-test-'))
  process.env.SAMSINN_HOME = testDir
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.SAMSINN_HOME
  else process.env.SAMSINN_HOME = prevHome
  rmSync(testDir, { recursive: true, force: true })
})

describe('store — basic CRUD', () => {
  test('upsert + lookup roundtrip (verified)', async () => {
    const f = makeFeature({ name: 'Bergen', lat: 60.39, lng: 5.32, verified: true })
    await upsertFeature(f)
    const hit = await lookupInCategory('city', 'Bergen')
    expect(hit?.properties.name).toBe('Bergen')
  })

  test('lookup returns null for unverified by default', async () => {
    const f = makeFeature({ name: 'Bergen', lat: 60.39, lng: 5.32, verified: false })
    await upsertFeature(f)
    expect(await lookupInCategory('city', 'Bergen')).toBeNull()
  })

  test('lookup includeUnverified opt returns the feature', async () => {
    const f = makeFeature({ name: 'Bergen', lat: 60.39, lng: 5.32, verified: false })
    await upsertFeature(f)
    const hit = await lookupInCategory('city', 'Bergen', { includeUnverified: true })
    expect(hit?.properties.name).toBe('Bergen')
  })

  test('canonical-form match (diacritic + case)', async () => {
    const f = makeFeature({ name: 'Tromsø', lat: 69.65, lng: 18.96, verified: true })
    await upsertFeature(f)
    expect((await lookupInCategory('city', 'tromso'))?.properties.name).toBe('Tromsø')
    expect((await lookupInCategory('city', 'TROMSØ'))?.properties.name).toBe('Tromsø')
  })

  test('alias match', async () => {
    const f = makeFeature({
      name: 'Oslo Lufthavn', lat: 60.19, lng: 11.10, verified: true,
      category: 'airport', aliases: ['Gardermoen', 'OSL', 'ENGM'],
    })
    await upsertFeature(f)
    expect((await lookupInCategory('airport', 'gardermoen'))?.properties.name).toBe('Oslo Lufthavn')
    expect((await lookupInCategory('airport', 'ENGM'))?.properties.name).toBe('Oslo Lufthavn')
  })
})

describe('store — verified protection', () => {
  test('unverified upsert does not overwrite verified', async () => {
    const curated = makeFeature({ name: 'Bergen', lat: 60.39, lng: 5.32, verified: true, id: 'curated' })
    await upsertFeature(curated)
    const agent = makeFeature({ name: 'Bergen', lat: 0, lng: 0, verified: false, id: 'agent-bad' })
    const result = await upsertFeature(agent)
    expect(result.replaced).toBe(false)
    const hit = await lookupInCategory('city', 'Bergen')
    expect(hit?.properties.id).toBe('curated')
    expect(hit?.geometry.coordinates).toEqual([5.32, 60.39])
  })

  test('verified upsert overwrites verified', async () => {
    const v1 = makeFeature({ name: 'Bergen', lat: 60.39, lng: 5.32, verified: true, id: 'v1' })
    await upsertFeature(v1)
    const v2 = makeFeature({ name: 'Bergen', lat: 60.40, lng: 5.33, verified: true, id: 'v2' })
    await upsertFeature(v2)
    const hit = await lookupInCategory('city', 'Bergen')
    expect(hit?.properties.id).toBe('v2')
  })

  test('unverified overwrites unverified (cache refresh case)', async () => {
    const u1 = makeFeature({ name: 'Karl Johans gate', lat: 59.91, lng: 10.74, verified: false })
    await upsertFeature(u1)
    const u2 = makeFeature({ name: 'Karl Johans gate', lat: 59.92, lng: 10.75, verified: false })
    const result = await upsertFeature(u2)
    expect(result.replaced).toBe(true)
  })
})

describe('store — remove', () => {
  test('remove by (source, id)', async () => {
    const f = makeFeature({ name: 'Bergen', lat: 60.39, lng: 5.32, verified: false })
    await upsertFeature(f)
    const r = await removeFeature('city', 'local', f.properties.id)
    expect(r.removed).toBe(true)
    expect(await lookupInCategory('city', 'Bergen', { includeUnverified: true })).toBeNull()
  })

  test('remove with wrong source is a noop', async () => {
    const f = makeFeature({ name: 'Bergen', lat: 60.39, lng: 5.32, verified: false, source: 'local' })
    await upsertFeature(f)
    const r = await removeFeature('city', 'bundled', f.properties.id)
    expect(r.removed).toBe(false)
  })
})

describe('store — concurrency', () => {
  test('parallel upserts to same category serialize correctly', async () => {
    const writes = Array.from({ length: 20 }, (_, i) =>
      upsertFeature(makeFeature({ name: `City${i}`, lat: 60 + i * 0.01, lng: 10 + i * 0.01, verified: true })),
    )
    await Promise.all(writes)
    const list = await listCategory('city')
    expect(list.length).toBe(20)
  })

  test('parallel upserts of same name dedupe to single entry', async () => {
    const writes = Array.from({ length: 10 }, (_, i) =>
      upsertFeature(makeFeature({ name: 'Bergen', lat: 60 + i * 0.001, lng: 5, verified: true, id: `v${i}` })),
    )
    await Promise.all(writes)
    const list = await listCategory('city')
    expect(list.length).toBe(1)
  })
})

describe('store — stats', () => {
  test('counts verified vs unverified', async () => {
    await upsertFeature(makeFeature({ name: 'A', lat: 60, lng: 5, verified: true }))
    await upsertFeature(makeFeature({ name: 'B', lat: 60, lng: 5, verified: true }))
    await upsertFeature(makeFeature({ name: 'C', lat: 60, lng: 5, verified: false }))
    const stats = await categoryStats('city')
    expect(stats.total).toBe(3)
    expect(stats.verified).toBe(2)
    expect(stats.unverified).toBe(1)
  })

  test('missing file → zeros, no throw', async () => {
    const stats = await categoryStats('airport')
    expect(stats.total).toBe(0)
  })
})
