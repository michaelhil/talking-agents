import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readManifest, namespaceFor } from './manifest.ts'

describe('readManifest', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'packs-manifest-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns {} when pack.json is absent', async () => {
    expect(await readManifest(dir)).toEqual({})
  })

  it('parses name and description', async () => {
    await writeFile(join(dir, 'pack.json'), JSON.stringify({
      name: 'ATC Pack',
      description: 'Air traffic control bundle',
    }))
    expect(await readManifest(dir)).toEqual({
      name: 'ATC Pack',
      description: 'Air traffic control bundle',
    })
  })

  it('drops unknown fields', async () => {
    await writeFile(join(dir, 'pack.json'), JSON.stringify({
      name: 'x',
      version: '1.2.3',
      author: 'me',
    }))
    expect(await readManifest(dir)).toEqual({ name: 'x' })
  })

  it('ignores empty / whitespace-only strings', async () => {
    await writeFile(join(dir, 'pack.json'), JSON.stringify({
      name: '   ',
      description: '',
    }))
    expect(await readManifest(dir)).toEqual({})
  })

  it('returns {} on invalid JSON without throwing', async () => {
    await writeFile(join(dir, 'pack.json'), '{not json')
    expect(await readManifest(dir)).toEqual({})
  })

  it('returns {} on non-object JSON', async () => {
    await writeFile(join(dir, 'pack.json'), '"just a string"')
    expect(await readManifest(dir)).toEqual({})
  })
})

describe('namespaceFor', () => {
  it('returns the directory basename', () => {
    expect(namespaceFor('/home/u/.samsinn/packs/atc')).toBe('atc')
    expect(namespaceFor('/tmp/pack-minimal')).toBe('pack-minimal')
  })
})
