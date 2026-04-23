import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanPacks } from './scanner.ts'

describe('scanPacks', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'packs-scanner-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('returns [] when root is missing', async () => {
    expect(await scanPacks(join(root, 'nope'))).toEqual([])
  })

  it('returns [] when root is empty', async () => {
    expect(await scanPacks(root)).toEqual([])
  })

  it('finds packs with and without manifests', async () => {
    await mkdir(join(root, 'atc'))
    await writeFile(join(root, 'atc', 'pack.json'), JSON.stringify({
      name: 'ATC', description: 'air traffic',
    }))
    await mkdir(join(root, 'driving'))

    const packs = await scanPacks(root)
    expect(packs.length).toBe(2)
    const byNs = new Map(packs.map(p => [p.namespace, p]))
    expect(byNs.get('atc')?.manifest).toEqual({ name: 'ATC', description: 'air traffic' })
    expect(byNs.get('driving')?.manifest).toEqual({})
  })

  it('skips hidden and underscore-prefixed dirs', async () => {
    await mkdir(join(root, '.git'))
    await mkdir(join(root, '_scratch'))
    await mkdir(join(root, 'real'))

    const packs = await scanPacks(root)
    expect(packs.map(p => p.namespace)).toEqual(['real'])
  })

  it('skips files at root', async () => {
    await writeFile(join(root, 'not-a-pack.txt'), 'x')
    await mkdir(join(root, 'real'))

    const packs = await scanPacks(root)
    expect(packs.map(p => p.namespace)).toEqual(['real'])
  })

  it('skips directories with invalid namespace characters', async () => {
    await mkdir(join(root, 'has.dot'))
    await mkdir(join(root, 'ok-name'))

    const packs = await scanPacks(root)
    expect(packs.map(p => p.namespace)).toEqual(['ok-name'])
  })
})
