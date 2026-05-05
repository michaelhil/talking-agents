import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyImport } from './import.ts'
import { getCategory } from './categories.ts'
import { listCategory } from './store.ts'

let prevHome: string | undefined
let testDir: string

beforeEach(() => {
  prevHome = process.env.SAMSINN_HOME
  testDir = mkdtempSync(join(tmpdir(), 'samsinn-import-test-'))
  process.env.SAMSINN_HOME = testDir
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.SAMSINN_HOME
  else process.env.SAMSINN_HOME = prevHome
  rmSync(testDir, { recursive: true, force: true })
})

const f = (id: string, lat = 60, lng = 5) => ({ id, name: id, lat, lng })

describe('applyImport — happy paths', () => {
  test('full metadata creates category + writes features', async () => {
    const r = await applyImport({
      categoryId: 'wind-farm',
      categoryDisplay: 'Wind Farm',
      categoryIcon: 'pin',
      features: [f('horns-rev-1')],
    })
    expect(r.ok).toBe(true)
    expect(r.categoryId).toBe('wind-farm')
    expect(r.featuresAdded).toBe(1)
    expect(await getCategory('wind-farm')).not.toBeNull()
    const stored = await listCategory('wind-farm')
    expect(stored.length).toBe(1)
    expect(stored[0]?.properties.verified).toBe(true)
    expect(stored[0]?.properties.source).toBe('local')
    expect(stored[0]?.properties.category_display).toBe('Wind Farm')
    expect(stored[0]?.properties.category_icon).toBe('pin')
  })

  test('append: existing category accepts more features', async () => {
    await applyImport({ categoryId: 'wind-farm', categoryDisplay: 'Wind Farm', categoryIcon: 'pin', features: [f('a')] })
    const r = await applyImport({ categoryId: 'wind-farm', features: [f('b'), f('c')] })
    expect(r.ok).toBe(true)
    expect(r.featuresAdded).toBe(2)
    expect((await listCategory('wind-farm')).length).toBe(3)
  })

  test('only first feature carries category metadata', async () => {
    const r = await applyImport({
      categoryId: 'wind-farm',
      categoryDisplay: 'Wind Farm',
      categoryIcon: 'pin',
      features: [f('a'), f('b'), f('c')],
    })
    expect(r.ok).toBe(true)
    const stored = await listCategory('wind-farm')
    const withMeta = stored.filter(s => s.properties.category_display)
    expect(withMeta.length).toBe(1)
  })
})

describe('applyImport — failure modes', () => {
  test('missing categoryId fails', async () => {
    const r = await applyImport({ features: [f('a')] })
    expect(r.ok).toBe(false)
    expect(r.errors[0]?.message).toMatch(/categoryId/)
  })

  test('invalid categoryId pattern fails', async () => {
    const r = await applyImport({ categoryId: 'BAD ID', features: [f('a')] })
    expect(r.ok).toBe(false)
    expect(r.errors[0]?.message).toMatch(/category must match/)
  })

  test('invalid icon fails', async () => {
    const r = await applyImport({ categoryId: 'wind-farm', categoryIcon: 'rocket', features: [f('a')] })
    expect(r.ok).toBe(false)
  })

  test('invalid osm query fails', async () => {
    const r = await applyImport({
      categoryId: 'wind-farm',
      categoryOsmQuery: 'no placeholder here',
      features: [f('a')],
    })
    expect(r.ok).toBe(false)
  })

  test('zero surviving features aborts; nothing written', async () => {
    const r = await applyImport({
      categoryId: 'wind-farm',
      features: [{ id: 'bad', name: '', lat: 200, lng: 0 }, { id: 'also-bad', name: 'X', lat: 0 }],
    })
    expect(r.ok).toBe(false)
    expect(r.featuresAdded).toBe(0)
    expect(await getCategory('wind-farm')).toBeNull()
  })

  test('duplicate id within paste is fatal', async () => {
    const r = await applyImport({ categoryId: 'wind-farm', features: [f('a'), f('a', 50, 10)] })
    expect(r.ok).toBe(false)
    expect(r.errors[0]?.message).toMatch(/duplicate/)
    expect(await getCategory('wind-farm')).toBeNull()
  })

  test('partial-success: bad rows reported, good rows imported', async () => {
    const r = await applyImport({
      categoryId: 'wind-farm',
      features: [f('a'), { id: 'b', name: 'B', lat: 999, lng: 0 }, f('c')],
    })
    expect(r.ok).toBe(true)
    expect(r.featuresAdded).toBe(2)
    expect(r.errors.length).toBe(1)
    expect(r.errors[0]?.field).toBe('lat')
  })

  test('AI error envelope is rejected', async () => {
    const r = await applyImport({ error: 'Could not find sufficient data' })
    expect(r.ok).toBe(false)
    expect(r.errors[0]?.message).toMatch(/AI returned error/)
  })
})
