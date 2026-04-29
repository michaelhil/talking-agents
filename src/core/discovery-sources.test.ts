import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDiscoverySources, saveDiscoverySources, mergeSources } from './discovery-sources.ts'

describe('discovery-sources store', () => {
  test('load missing file → empty default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ds-test-'))
    try {
      const data = await loadDiscoverySources(join(dir, 'missing.json'))
      expect(data.packs).toEqual([])
      expect(data.wikis).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('round-trip save → load preserves entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ds-test-'))
    try {
      const path = join(dir, 'd.json')
      await saveDiscoverySources(path, {
        version: 1,
        packs: ['acme-packs', 'me/my-pack'],
        wikis: ['my-org-wikis'],
      })
      const loaded = await loadDiscoverySources(path)
      expect(loaded.packs).toEqual(['acme-packs', 'me/my-pack'])
      expect(loaded.wikis).toEqual(['my-org-wikis'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('load drops non-string entries + trims', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ds-test-'))
    try {
      const path = join(dir, 'd.json')
      // Write malformed JSON manually (saveDiscoverySources won't produce this).
      const { writeFile } = await import('node:fs/promises')
      await writeFile(path, JSON.stringify({
        version: 1,
        packs: ['  ok  ', 42, null, '', 'me/repo'],
        wikis: 'not-an-array',
      }), 'utf-8')
      const loaded = await loadDiscoverySources(path)
      expect(loaded.packs).toEqual(['ok', 'me/repo'])
      expect(loaded.wikis).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('mergeSources', () => {
  test('env first, then stored, then fallback — fallback is always appended', () => {
    const out = mergeSources('a, b, c', ['c', 'd'], ['fallback'])
    expect(out).toEqual(['a', 'b', 'c', 'd', 'fallback'])
  })

  test('env empty → stored + fallback', () => {
    const out = mergeSources(undefined, ['a', 'b'], ['fallback'])
    expect(out).toEqual(['a', 'b', 'fallback'])
  })

  test('both empty → fallback', () => {
    const out = mergeSources(undefined, [], ['canonical-org'])
    expect(out).toEqual(['canonical-org'])
  })

  test('all empty → empty', () => {
    const out = mergeSources('', [], [])
    expect(out).toEqual([])
  })

  test('env whitespace + commas tolerated; fallback still appears', () => {
    const out = mergeSources('  a , ,b , ', [], ['x'])
    expect(out).toEqual(['a', 'b', 'x'])
  })

  test('canonical fallback is deduped if user adds it explicitly', () => {
    const out = mergeSources('samsinn-packs', ['acme-packs'], ['samsinn-packs'])
    expect(out).toEqual(['samsinn-packs', 'acme-packs'])
  })
})
