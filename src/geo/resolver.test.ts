import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveLocation, type SourceFn } from './resolver.ts'
import { listCategory, upsertFeature } from './store.ts'
import type { GeoFeature, GeoSource } from './types.ts'

let prevHome: string | undefined
let testDir: string

const f = (name: string, lat: number, lng: number, source: GeoSource = 'local'): GeoFeature => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lng, lat] },
  properties: {
    id: `${source}-${name.toLowerCase().replace(/\s+/g, '-')}`,
    name,
    category: 'city',
    verified: source !== 'overpass' && source !== 'nominatim',
    source,
  },
})

beforeEach(() => {
  prevHome = process.env.SAMSINN_HOME
  testDir = mkdtempSync(join(tmpdir(), 'samsinn-geo-resolver-test-'))
  process.env.SAMSINN_HOME = testDir
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.SAMSINN_HOME
  else process.env.SAMSINN_HOME = prevHome
  rmSync(testDir, { recursive: true, force: true })
})

describe('resolver — strict-match short-circuit', () => {
  test('first source wins', async () => {
    const localFn: SourceFn = async () => f('Bergen', 60.39, 5.32, 'local')
    const bundledFn: SourceFn = async () => f('Bergen', 0, 0, 'overpass')
    const r = await resolveLocation('Bergen', 'city', {
      sources: [
        { name: 'local', fn: localFn },
        { name: 'overpass', fn: bundledFn },
      ],
      cacheUpstream: false,
    })
    expect(r?.source).toBe('local')
    expect(r?.features[0]?.geometry.coordinates).toEqual([5.32, 60.39])
  })

  test('cascade falls through nulls', async () => {
    const localFn: SourceFn = async () => null
    const bundledFn: SourceFn = async () => null
    const overpassFn: SourceFn = async () => f('Bergen', 60.39, 5.32, 'overpass')
    const r = await resolveLocation('Bergen', 'city', {
      sources: [
        { name: 'local', fn: localFn },
        { name: 'overpass', fn: bundledFn },
        { name: 'overpass', fn: overpassFn },
      ],
      cacheUpstream: false,
    })
    expect(r?.source).toBe('overpass')
  })

  test('all sources null → null result', async () => {
    const r = await resolveLocation('Atlantis', 'city', {
      sources: [
        { name: 'local', fn: async () => null },
        { name: 'overpass', fn: async () => null },
      ],
      cacheUpstream: false,
    })
    expect(r).toBeNull()
  })

  test('empty query returns null without calling sources', async () => {
    let called = false
    const localFn: SourceFn = async () => { called = true; return null }
    const r = await resolveLocation('   ', 'city', {
      sources: [{ name: 'local', fn: localFn }],
    })
    expect(r).toBeNull()
    expect(called).toBe(false)
  })
})

describe('resolver — upstream cache write-back', () => {
  test('upstream hit writes to local store', async () => {
    const overpassFn: SourceFn = async () => f('Bergen', 60.39, 5.32, 'overpass')
    const r = await resolveLocation('Bergen', 'city', {
      sources: [{ name: 'overpass', fn: overpassFn }],
    })
    expect(r?.source).toBe('overpass')
    // Allow the fire-and-forget write to settle.
    await new Promise((res) => setTimeout(res, 50))
    const list = await listCategory('city')
    expect(list.length).toBe(1)
    expect(list[0]?.properties.source).toBe('overpass')
    expect(list[0]?.properties.verified).toBe(false)
  })

  test('local-source hit does NOT trigger write-back', async () => {
    // Pre-seed the store. Resolver should hit local and not duplicate.
    await upsertFeature(f('Bergen', 60.39, 5.32, 'local'))
    const r = await resolveLocation('Bergen', 'city', {
      sources: [
        { name: 'local', fn: async (q, c) => (await import('./store.ts')).lookupInCategory(c, q) },
      ],
    })
    expect(r?.source).toBe('local')
    const list = await listCategory('city')
    expect(list.length).toBe(1)
  })

  test('cacheUpstream=false skips write-back', async () => {
    const overpassFn: SourceFn = async () => f('Bergen', 60.39, 5.32, 'overpass')
    await resolveLocation('Bergen', 'city', {
      sources: [{ name: 'overpass', fn: overpassFn }],
      cacheUpstream: false,
    })
    await new Promise((res) => setTimeout(res, 50))
    const list = await listCategory('city')
    expect(list.length).toBe(0)
  })
})

describe('resolver — error handling', () => {
  test('source throwing non-cap error → cascade continues', async () => {
    const r = await resolveLocation('Bergen', 'city', {
      sources: [
        { name: 'overpass', fn: async () => { throw new Error('network exploded') } },
        { name: 'nominatim', fn: async () => f('Bergen', 60.39, 5.32, 'nominatim') },
      ],
      cacheUpstream: false,
    })
    expect(r?.source).toBe('nominatim')
  })

  test('daily-cap error propagates', async () => {
    const capFn: SourceFn = async () => { throw new Error('Nominatim daily cap exceeded') }
    await expect(resolveLocation('Bergen', 'city', {
      sources: [{ name: 'nominatim', fn: capFn }],
      cacheUpstream: false,
    })).rejects.toThrow(/daily cap/)
  })
})
