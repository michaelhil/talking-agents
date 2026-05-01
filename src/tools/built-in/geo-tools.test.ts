import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGeoAddTool, createGeoListCategoriesTool, createGeoLookupTool, createGeoRemoveTool } from './geo-tools.ts'
import { upsertCategory, validateCategoryMeta, __resetCategoryRegistryState } from '../../geo/categories.ts'
import { upsertFeature } from '../../geo/store.ts'
import type { GeoFeature } from '../../geo/types.ts'

let prevHome: string | undefined
let testDir: string

const fakeContext = { callerId: 'agent-x', callerName: 'Agent X' }

const seedCategory = async (id: string): Promise<void> => {
  const v = validateCategoryMeta({ id, displayName: id, icon: 'pin' })
  if (!v.ok) throw new Error('val')
  await upsertCategory(v.meta)
}

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
  __resetCategoryRegistryState()
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
    await seedCategory('wind-farm')
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
