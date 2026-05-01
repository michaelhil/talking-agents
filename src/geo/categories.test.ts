import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __resetCategoryRegistryState,
  deleteCategory,
  getCategory,
  listCategories,
  loadRegistry,
  upsertCategory,
  validateCategoryMeta,
} from './categories.ts'

let prevHome: string | undefined
let testDir: string

beforeEach(() => {
  prevHome = process.env.SAMSINN_HOME
  testDir = mkdtempSync(join(tmpdir(), 'samsinn-cat-test-'))
  process.env.SAMSINN_HOME = testDir
  __resetCategoryRegistryState()
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.SAMSINN_HOME
  else process.env.SAMSINN_HOME = prevHome
  rmSync(testDir, { recursive: true, force: true })
})

describe('validateCategoryMeta', () => {
  test('accepts well-formed meta', () => {
    const r = validateCategoryMeta({ id: 'wind-farm', displayName: 'Wind Farm', icon: 'pin' })
    expect(r.ok).toBe(true)
  })

  test('rejects bad id', () => {
    const r = validateCategoryMeta({ id: 'Bad ID!', displayName: 'X', icon: 'pin' })
    expect(r.ok).toBe(false)
  })

  test('rejects unknown icon', () => {
    const r = validateCategoryMeta({ id: 'x', displayName: 'X', icon: 'starship' })
    expect(r.ok).toBe(false)
  })

  test('rejects empty displayName', () => {
    const r = validateCategoryMeta({ id: 'x', displayName: '   ', icon: 'pin' })
    expect(r.ok).toBe(false)
  })

  test('osmQuery must contain {name} exactly once', () => {
    expect(validateCategoryMeta({ id: 'x', displayName: 'X', icon: 'pin', osmQuery: 'no placeholder' }).ok).toBe(false)
    expect(validateCategoryMeta({ id: 'x', displayName: 'X', icon: 'pin', osmQuery: '{name} {name}' }).ok).toBe(false)
    expect(validateCategoryMeta({ id: 'x', displayName: 'X', icon: 'pin', osmQuery: 'node[name="{name}"];' }).ok).toBe(true)
  })

  test('preserves addedAt when present, fills it when absent', () => {
    const r1 = validateCategoryMeta({ id: 'x', displayName: 'X', icon: 'pin' })
    if (!r1.ok) throw new Error('expected ok')
    expect(typeof r1.meta.addedAt).toBe('string')
    const r2 = validateCategoryMeta({ id: 'x', displayName: 'X', icon: 'pin', addedAt: '2024-01-01T00:00:00Z' })
    if (!r2.ok) throw new Error('expected ok')
    expect(r2.meta.addedAt).toBe('2024-01-01T00:00:00Z')
  })
})

describe('registry CRUD', () => {
  const meta = (id: string) => ({ id, displayName: id, icon: 'pin' as const })

  test('empty registry on fresh install', async () => {
    expect(await listCategories()).toEqual([])
  })

  test('upsert + get', async () => {
    const v = validateCategoryMeta(meta('wind-farm'))
    if (!v.ok) throw new Error('val failed')
    const r = await upsertCategory(v.meta)
    expect(r.created).toBe(true)
    const got = await getCategory('wind-farm')
    expect(got?.displayName).toBe('wind-farm')
  })

  test('upsert replaces by id, preserves addedAt', async () => {
    const v1 = validateCategoryMeta({ ...meta('x'), addedAt: '2020-01-01T00:00:00Z' })
    if (!v1.ok) throw new Error('val')
    await upsertCategory(v1.meta)
    const v2 = validateCategoryMeta({ id: 'x', displayName: 'X (updated)', icon: 'platform' })
    if (!v2.ok) throw new Error('val2')
    const r = await upsertCategory(v2.meta)
    expect(r.created).toBe(false)
    const got = await getCategory('x')
    expect(got?.displayName).toBe('X (updated)')
    expect(got?.icon).toBe('platform')
    expect(got?.addedAt).toBe('2020-01-01T00:00:00Z')
  })

  test('deleteCategory removes from registry and unlinks file', async () => {
    const v = validateCategoryMeta(meta('cell-tower'))
    if (!v.ok) throw new Error('val')
    await upsertCategory(v.meta)
    // Simulate a per-category file existing.
    mkdirSync(join(testDir, 'geodata'), { recursive: true })
    writeFileSync(join(testDir, 'geodata', 'cell-tower.geojson'), '{}')
    const r = await deleteCategory('cell-tower')
    expect(r.deleted).toBe(true)
    expect(r.fileUnlinked).toBe(true)
    expect(existsSync(join(testDir, 'geodata', 'cell-tower.geojson'))).toBe(false)
    expect(await getCategory('cell-tower')).toBeNull()
  })

  test('deleteCategory of unknown id returns deleted:false', async () => {
    const r = await deleteCategory('does-not-exist')
    expect(r.deleted).toBe(false)
  })

  test('deleteCategory tolerates missing per-category file', async () => {
    const v = validateCategoryMeta(meta('empty-cat'))
    if (!v.ok) throw new Error('val')
    await upsertCategory(v.meta)
    const r = await deleteCategory('empty-cat')
    expect(r.deleted).toBe(true)
    expect(r.fileUnlinked).toBe(false)
  })
})

describe('registry concurrency', () => {
  test('parallel upserts serialise', async () => {
    const writes = Array.from({ length: 10 }, (_, i) => {
      const v = validateCategoryMeta({ id: `cat-${i}`, displayName: `Cat ${i}`, icon: 'pin' })
      if (!v.ok) throw new Error('val')
      return upsertCategory(v.meta)
    })
    await Promise.all(writes)
    expect((await loadRegistry()).length).toBe(10)
  })

  test('rejects malformed registry file', async () => {
    mkdirSync(join(testDir, 'geodata'), { recursive: true })
    writeFileSync(join(testDir, 'geodata', 'categories.json'), JSON.stringify({ version: 99, categories: [] }))
    await expect(listCategories()).rejects.toThrow(/version 1/)
  })
})
