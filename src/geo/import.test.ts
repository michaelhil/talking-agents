import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyImport } from './import.ts'
import { getCategory, __resetCategoryRegistryState } from './categories.ts'
import { listCategory } from './store.ts'

let prevHome: string | undefined
let testDir: string

beforeEach(() => {
  prevHome = process.env.SAMSINN_HOME
  testDir = mkdtempSync(join(tmpdir(), 'samsinn-import-test-'))
  process.env.SAMSINN_HOME = testDir
  __resetCategoryRegistryState()
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.SAMSINN_HOME
  else process.env.SAMSINN_HOME = prevHome
  rmSync(testDir, { recursive: true, force: true })
})

const cat = (overrides: Record<string, unknown> = {}) => ({
  id: 'wind-farm', displayName: 'Wind Farm', icon: 'pin', ...overrides,
})

const f = (id: string, lat = 60, lng = 5) => ({ id, name: id, lat, lng })

describe('applyImport — happy paths', () => {
  test('object form on new id creates category + writes features', async () => {
    const r = await applyImport({ category: cat(), features: [f('horns-rev-1')] })
    expect(r.ok).toBe(true)
    expect(r.categoryAction).toBe('created')
    expect(r.featuresAdded).toBe(1)
    expect(await getCategory('wind-farm')).not.toBeNull()
    const stored = await listCategory('wind-farm')
    expect(stored.length).toBe(1)
    expect(stored[0]?.properties.verified).toBe(true)
    expect(stored[0]?.properties.source).toBe('local')
  })

  test('object form on existing id replaces metadata', async () => {
    await applyImport({ category: cat({ icon: 'pin' }), features: [f('a')] })
    const r = await applyImport({ category: cat({ icon: 'platform' }), features: [f('b')] })
    expect(r.categoryAction).toBe('metadata-replaced')
    expect((await getCategory('wind-farm'))?.icon).toBe('platform')
    expect((await listCategory('wind-farm')).length).toBe(2)
  })

  test('shorthand string appends to existing', async () => {
    await applyImport({ category: cat(), features: [f('a')] })
    const r = await applyImport({ category: 'wind-farm', features: [f('b'), f('c')] })
    expect(r.categoryAction).toBe('append-only')
    expect(r.featuresAdded).toBe(2)
    expect((await listCategory('wind-farm')).length).toBe(3)
  })
})

describe('applyImport — failure modes', () => {
  test('shorthand on unknown id is fatal', async () => {
    const r = await applyImport({ category: 'unknown-cat', features: [f('a')] })
    expect(r.ok).toBe(false)
    expect(r.categoryAction).toBe('aborted')
    expect(r.errors[0]?.message).toMatch(/not registered/)
  })

  test('invalid category metadata aborts', async () => {
    const r = await applyImport({ category: { id: 'BAD ID', displayName: 'X', icon: 'pin' }, features: [f('a')] })
    expect(r.ok).toBe(false)
    expect(r.categoryAction).toBe('aborted')
  })

  test('zero surviving features aborts; registry untouched', async () => {
    const r = await applyImport({
      category: cat(),
      features: [{ id: 'bad', name: '', lat: 200, lng: 0 }, { id: 'also-bad', name: 'X', lat: 0 }],
    })
    expect(r.ok).toBe(false)
    expect(r.featuresAdded).toBe(0)
    expect(await getCategory('wind-farm')).toBeNull()
  })

  test('duplicate id within paste is fatal', async () => {
    const r = await applyImport({ category: cat(), features: [f('a'), f('a', 50, 10)] })
    expect(r.ok).toBe(false)
    expect(r.errors[0]?.message).toMatch(/duplicate/)
    // No partial writes.
    expect(await getCategory('wind-farm')).toBeNull()
  })

  test('partial-success: bad rows reported, good rows imported', async () => {
    const r = await applyImport({
      category: cat(),
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
