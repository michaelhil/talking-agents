// Pack-source geodata loader tests. Exercises the on-disk scan + parse,
// pack tagging, and the room-aware filter in store.listCategoryForRoom.

import { describe, expect, test, afterEach, beforeEach } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { refreshPackGeodata, getPackFeatures, getAllPackFeatures, __resetPackGeodataCache } from './pack-source.ts'
import { listCategoryForRoom } from './store.ts'

const fc = (features: ReadonlyArray<unknown>): string =>
  JSON.stringify({ type: 'FeatureCollection', features })

// Realistic pack-author shape: no `verified` or `source` set (the loader
// stamps pack=<ns>, source='pack', verified=true defaults). isValidGeoFeature
// requires id/name/category/Point — that's what tests exercise.
const feature = (id: string, name: string, category: string, lat: number, lng: number) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lng, lat] },
  properties: { id, name, category },
})

describe('pack-source geodata loader', () => {
  let packsDir: string

  beforeEach(async () => {
    __resetPackGeodataCache()
    packsDir = await mkdtemp(join(tmpdir(), 'samsinn-pack-geo-'))
  })

  afterEach(async () => {
    await rm(packsDir, { recursive: true, force: true })
    __resetPackGeodataCache()
  })

  test('loads features from <pack>/geodata/*.geojson and tags them', async () => {
    await mkdir(join(packsDir, 'aviation', 'geodata'), { recursive: true })
    await writeFile(
      join(packsDir, 'aviation', 'geodata', 'airports.geojson'),
      fc([feature('osl', 'Oslo Airport', 'airports', 60.19, 11.10)]),
      'utf-8',
    )
    await writeFile(join(packsDir, 'aviation', 'pack.json'), JSON.stringify({ name: 'aviation' }))

    const state = await refreshPackGeodata(packsDir)
    expect(state.errors).toEqual([])
    expect(state.perPackFeatureCounts.get('aviation')).toBe(1)

    const airports = getPackFeatures('airports')
    expect(airports).toHaveLength(1)
    expect(airports[0]?.properties.source).toBe('pack')
    expect(airports[0]?.properties.pack).toBe('aviation')
    expect(airports[0]?.properties.verified).toBe(true)   // pack default
  })

  test('multiple files per pack merge into the category map', async () => {
    await mkdir(join(packsDir, 'aviation', 'geodata'), { recursive: true })
    await writeFile(
      join(packsDir, 'aviation', 'geodata', 'airports.geojson'),
      fc([feature('osl', 'Oslo', 'airports', 60.19, 11.10)]),
    )
    await writeFile(
      join(packsDir, 'aviation', 'geodata', 'navaids.geojson'),
      fc([feature('osd-vor', 'OSD VOR', 'navaids', 60.0, 11.0)]),
    )

    await refreshPackGeodata(packsDir)
    expect(getPackFeatures('airports')).toHaveLength(1)
    expect(getPackFeatures('navaids')).toHaveLength(1)
    expect(getAllPackFeatures()).toHaveLength(2)
  })

  test('two packs contribute to the same category, both visible', async () => {
    await mkdir(join(packsDir, 'aviation', 'geodata'), { recursive: true })
    await mkdir(join(packsDir, 'cafes', 'geodata'), { recursive: true })
    await writeFile(
      join(packsDir, 'aviation', 'geodata', 'airports.geojson'),
      fc([feature('osl', 'Oslo', 'airports', 60.19, 11.10)]),
    )
    await writeFile(
      join(packsDir, 'cafes', 'geodata', 'cafes.geojson'),
      fc([feature('java', 'Java House', 'cafes', 59.91, 10.74)]),
    )

    const state = await refreshPackGeodata(packsDir)
    expect(state.perPackFeatureCounts.get('aviation')).toBe(1)
    expect(state.perPackFeatureCounts.get('cafes')).toBe(1)
  })

  test('malformed files are skipped with a structured error; siblings still load', async () => {
    await mkdir(join(packsDir, 'aviation', 'geodata'), { recursive: true })
    await writeFile(join(packsDir, 'aviation', 'geodata', 'broken.geojson'), '{ not json')
    await writeFile(
      join(packsDir, 'aviation', 'geodata', 'good.geojson'),
      fc([feature('osl', 'Oslo', 'airports', 60.19, 11.10)]),
    )

    const state = await refreshPackGeodata(packsDir)
    expect(state.errors.some(e => e.file === 'broken.geojson')).toBe(true)
    expect(getPackFeatures('airports')).toHaveLength(1)
  })

  test('non-Feature entries dropped silently, kept in error log when id missing', async () => {
    await mkdir(join(packsDir, 'aviation', 'geodata'), { recursive: true })
    await writeFile(
      join(packsDir, 'aviation', 'geodata', 'airports.geojson'),
      fc([
        feature('osl', 'Oslo', 'airports', 60.19, 11.10),
        // missing id — should be skipped + counted in errors
        { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { name: 'X', category: 'airports' } },
      ]),
    )
    const state = await refreshPackGeodata(packsDir)
    expect(state.errors.some(e => /missing properties.id/.test(e.reason))).toBe(true)
    expect(getPackFeatures('airports')).toHaveLength(1)
  })

  test('listCategoryForRoom filters pack features by activePacks', async () => {
    await mkdir(join(packsDir, 'aviation', 'geodata'), { recursive: true })
    await mkdir(join(packsDir, 'cafes', 'geodata'), { recursive: true })
    await writeFile(
      join(packsDir, 'aviation', 'geodata', 'airports.geojson'),
      fc([feature('osl', 'Oslo Airport', 'airports', 60.19, 11.10)]),
    )
    // 'cafes' contributes to a DIFFERENT category — useful for asserting
    // that activation gates per-namespace, not per-category.
    await writeFile(
      join(packsDir, 'cafes', 'geodata', 'cafes.geojson'),
      fc([feature('java', 'Java House', 'cafes', 59.91, 10.74)]),
    )
    await refreshPackGeodata(packsDir)

    // Active set with 'aviation' only: cafes should be hidden.
    const aviationOnly = await listCategoryForRoom('cafes', new Set(['core', 'local', 'aviation']))
    expect(aviationOnly.filter(f => f.properties.source === 'pack')).toHaveLength(0)

    const aviationOnlyAirports = await listCategoryForRoom('airports', new Set(['core', 'local', 'aviation']))
    expect(aviationOnlyAirports.find(f => f.properties.pack === 'aviation')).toBeDefined()

    // Both active: both visible.
    const both = await listCategoryForRoom('cafes', new Set(['core', 'local', 'aviation', 'cafes']))
    expect(both.find(f => f.properties.pack === 'cafes')).toBeDefined()

    // Neither active: pack features hidden.
    const neither = await listCategoryForRoom('airports', new Set(['core', 'local']))
    expect(neither.filter(f => f.properties.source === 'pack')).toHaveLength(0)
  })
})
