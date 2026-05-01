import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGeoAddTool, createGeoLookupTool, createGeoRemoveTool } from './geo-tools.ts'
import { upsertFeature } from '../../geo/store.ts'
import type { GeoFeature } from '../../geo/types.ts'

let prevHome: string | undefined
let testDir: string

const fakeContext = { callerId: 'agent-x', callerName: 'Agent X' }

const makeFeature = (name: string, lat: number, lng: number, verified: boolean): GeoFeature => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lng, lat] },
  properties: {
    id: `local-${name.toLowerCase()}`,
    name,
    category: 'city',
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

  test('finds verified local feature', async () => {
    await upsertFeature(makeFeature('Bergen', 60.39, 5.32, true))
    const r = await tool.execute({ query: 'Bergen', category: 'city' }, fakeContext as never)
    expect(r.success).toBe(true)
    if (r.success) {
      const data = r.data as { features: { lat: number; lng: number; label: string }[]; source: string }
      expect(data.features.length).toBe(1)
      expect(data.features[0]?.label).toBe('Bergen')
      expect(data.source).toBe('local')
    }
  })

  test('rejects invalid category', async () => {
    const r = await tool.execute({ query: 'Bergen', category: 'starship' }, fakeContext as never)
    expect(r.success).toBe(false)
  })

  test('rejects empty query', async () => {
    const r = await tool.execute({ query: '   ', category: 'city' }, fakeContext as never)
    expect(r.success).toBe(false)
  })
})

describe('geo_add + geo_remove', () => {
  const addTool = createGeoAddTool()
  const removeTool = createGeoRemoveTool()

  test('add then remove roundtrip', async () => {
    const r = await addTool.execute({
      name: 'Test Place',
      lat: 60.0,
      lng: 5.0,
      category: 'landmark',
    }, fakeContext as never)
    expect(r.success).toBe(true)
    if (!r.success) throw new Error('expected success')
    const id = (r.data as { id: string }).id
    const rem = await removeTool.execute({ id, category: 'landmark' }, fakeContext as never)
    expect(rem.success).toBe(true)
    if (rem.success) expect((rem.data as { removed: boolean }).removed).toBe(true)
  })

  test('add blocked by curated entry returns added=false', async () => {
    await upsertFeature(makeFeature('Bergen', 60.39, 5.32, true))
    const r = await addTool.execute({
      name: 'Bergen',
      lat: 0,
      lng: 0,
      category: 'city',
    }, fakeContext as never)
    expect(r.success).toBe(true)
    if (r.success) {
      const data = r.data as { added: boolean }
      expect(data.added).toBe(false)
    }
  })

  test('remove refuses to delete curated entry', async () => {
    await upsertFeature(makeFeature('Bergen', 60.39, 5.32, true))
    const r = await removeTool.execute({ id: 'local-bergen', category: 'city' }, fakeContext as never)
    expect(r.success).toBe(false)
  })
})
