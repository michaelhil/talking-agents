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

  it('parses wikis array of valid {name, url} entries', async () => {
    await writeFile(join(dir, 'pack.json'), JSON.stringify({
      name: 'aviation',
      wikis: [
        { name: 'ICAO Wiki', url: 'https://samsinn-wikis.github.io/icao/' },
        { name: 'NavAids', url: 'https://example.com/navaids' },
      ],
    }))
    const m = await readManifest(dir)
    expect(m.name).toBe('aviation')
    expect(m.wikis).toEqual([
      { name: 'ICAO Wiki', url: 'https://samsinn-wikis.github.io/icao/' },
      { name: 'NavAids', url: 'https://example.com/navaids' },
    ])
  })

  it('drops wikis entries with missing name or url', async () => {
    await writeFile(join(dir, 'pack.json'), JSON.stringify({
      wikis: [
        { name: 'Good', url: 'https://example.com/' },
        { name: '', url: 'https://example.com/empty-name' },
        { name: 'NoUrl' },
        'not-an-object',
      ],
    }))
    const m = await readManifest(dir)
    expect(m.wikis).toEqual([{ name: 'Good', url: 'https://example.com/' }])
  })

  it('drops wikis entries with non-http(s) url', async () => {
    await writeFile(join(dir, 'pack.json'), JSON.stringify({
      wikis: [
        { name: 'Good', url: 'https://ok.example/' },
        { name: 'FileScheme', url: 'file:///etc/passwd' },
        { name: 'JsScheme', url: 'javascript:alert(1)' },
        { name: 'Malformed', url: 'not a url' },
      ],
    }))
    const m = await readManifest(dir)
    expect(m.wikis).toEqual([{ name: 'Good', url: 'https://ok.example/' }])
  })

  it('returns no wikis field when array is missing or all entries invalid', async () => {
    await writeFile(join(dir, 'pack.json'), JSON.stringify({
      wikis: [{ name: 'Bad' }],   // no url
    }))
    const m = await readManifest(dir)
    expect(m.wikis).toBeUndefined()
  })

  it('returns no wikis field when wikis is not an array', async () => {
    await writeFile(join(dir, 'pack.json'), JSON.stringify({
      wikis: 'not an array',
    }))
    const m = await readManifest(dir)
    expect(m.wikis).toBeUndefined()
  })
})

describe('namespaceFor', () => {
  it('returns the directory basename', () => {
    expect(namespaceFor('/home/u/.samsinn/packs/atc')).toBe('atc')
    expect(namespaceFor('/tmp/pack-minimal')).toBe('pack-minimal')
  })
})
