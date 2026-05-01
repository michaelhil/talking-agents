import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, mkdir, writeFile, utimes, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runJanitorOnce } from './instance-cleanup.ts'
import { sharedPaths } from '../paths.ts'

const HOUR = 60 * 60_000
const DAY = 24 * HOUR

const setMtime = async (path: string, msAgo: number): Promise<void> => {
  const t = (Date.now() - msAgo) / 1000
  await utimes(path, t, t)
}

describe('runJanitorOnce', () => {
  let originalHome: string | undefined
  let homeDir: string

  beforeEach(async () => {
    originalHome = process.env.SAMSINN_HOME
    homeDir = await mkdtemp(join(tmpdir(), 'samsinn-janitor-'))
    process.env.SAMSINN_HOME = homeDir
    await mkdir(join(homeDir, 'instances'), { recursive: true })
    await mkdir(join(homeDir, 'instances', '.trash'), { recursive: true })
  })

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.SAMSINN_HOME
    else process.env.SAMSINN_HOME = originalHome
    await rm(homeDir, { recursive: true, force: true })
  })

  // --- Demote ---

  it('demotes instances older than idleToTrashMs into .trash/', async () => {
    const old = 'aaaaaaaaaaaaaaaa'
    const fresh = 'bbbbbbbbbbbbbbbb'
    await mkdir(join(sharedPaths.instancesRoot(), old), { recursive: true })
    await mkdir(join(sharedPaths.instancesRoot(), fresh), { recursive: true })
    await writeFile(join(sharedPaths.instancesRoot(), old, 'snapshot.json'), '{"version":11}')
    await writeFile(join(sharedPaths.instancesRoot(), fresh, 'snapshot.json'), '{"version":11}')

    await setMtime(join(sharedPaths.instancesRoot(), old, 'snapshot.json'), 2 * DAY)
    // fresh has default mtime (now)

    const result = await runJanitorOnce({
      isActive: () => false,
      idleToTrashMs: DAY,
      trashToPurgeMs: 7 * DAY,
    })

    expect(result.demoted).toEqual([old])
    expect(result.errors).toEqual([])
    const trashEntries = await readdir(sharedPaths.trashRoot())
    expect(trashEntries.some(e => e.startsWith(old + '-'))).toBe(true)
    // Fresh instance still in place.
    const stillThere = await readdir(sharedPaths.instancesRoot())
    expect(stillThere).toContain(fresh)
    expect(stillThere).not.toContain(old)
  })

  it('skips active instances even if old', async () => {
    const id = 'aaaaaaaaaaaaaaaa'
    await mkdir(join(sharedPaths.instancesRoot(), id), { recursive: true })
    await writeFile(join(sharedPaths.instancesRoot(), id, 'snapshot.json'), '{"version":11}')
    await setMtime(join(sharedPaths.instancesRoot(), id, 'snapshot.json'), 2 * DAY)

    const result = await runJanitorOnce({
      isActive: (x) => x === id,
      idleToTrashMs: DAY,
      trashToPurgeMs: 7 * DAY,
    })

    expect(result.demoted).toEqual([])
    expect(await readdir(sharedPaths.instancesRoot())).toContain(id)
  })

  it('ignores non-conforming directory names', async () => {
    await mkdir(join(sharedPaths.instancesRoot(), 'notavalidid'), { recursive: true })
    await mkdir(join(sharedPaths.instancesRoot(), '.hidden'), { recursive: true })
    const result = await runJanitorOnce({
      isActive: () => false,
      idleToTrashMs: 1,        // expire-fast — but invalid IDs are skipped
      trashToPurgeMs: 7 * DAY,
    })
    expect(result.demoted).toEqual([])
  })

  // --- Purge ---

  it('purges trash entries older than trashToPurgeMs', async () => {
    const old = 'aaaaaaaaaaaaaaaa-1234'
    const fresh = 'bbbbbbbbbbbbbbbb-5678'
    await mkdir(join(sharedPaths.trashRoot(), old), { recursive: true })
    await mkdir(join(sharedPaths.trashRoot(), fresh), { recursive: true })
    await setMtime(join(sharedPaths.trashRoot(), old), 8 * DAY)
    // fresh has default mtime (now)

    const result = await runJanitorOnce({
      isActive: () => false,
      idleToTrashMs: DAY,
      trashToPurgeMs: 7 * DAY,
    })

    expect(result.purged).toEqual([old])
    const trashEntries = await readdir(sharedPaths.trashRoot())
    expect(trashEntries).toContain(fresh)
    expect(trashEntries).not.toContain(old)
  })

  // --- Idempotency / safety ---

  it('handles missing instances/ dir without throwing', async () => {
    await rm(join(homeDir, 'instances'), { recursive: true })
    const result = await runJanitorOnce({
      isActive: () => false,
      idleToTrashMs: DAY,
      trashToPurgeMs: 7 * DAY,
    })
    expect(result.errors).toEqual([])
  })

  it('handles missing .trash/ dir without throwing', async () => {
    await rm(sharedPaths.trashRoot(), { recursive: true })
    const result = await runJanitorOnce({
      isActive: () => false,
      idleToTrashMs: DAY,
      trashToPurgeMs: 7 * DAY,
    })
    expect(result.errors).toEqual([])
  })

  it('falls back to dir mtime when snapshot.json is missing', async () => {
    const id = 'aaaaaaaaaaaaaaaa'
    const dir = join(sharedPaths.instancesRoot(), id)
    await mkdir(dir, { recursive: true })
    // No snapshot.json — janitor falls back to dir mtime.
    await setMtime(dir, 2 * DAY)

    const result = await runJanitorOnce({
      isActive: () => false,
      idleToTrashMs: DAY,
      trashToPurgeMs: 7 * DAY,
    })
    expect(result.demoted).toContain(id)
  })

  it('logs each demote and purge', async () => {
    const id = 'aaaaaaaaaaaaaaaa'
    const trashName = 'bbbbbbbbbbbbbbbb-9999'
    await mkdir(join(sharedPaths.instancesRoot(), id), { recursive: true })
    await writeFile(join(sharedPaths.instancesRoot(), id, 'snapshot.json'), '{}')
    await setMtime(join(sharedPaths.instancesRoot(), id, 'snapshot.json'), 2 * DAY)
    await mkdir(join(sharedPaths.trashRoot(), trashName), { recursive: true })
    await setMtime(join(sharedPaths.trashRoot(), trashName), 8 * DAY)

    const lines: string[] = []
    await runJanitorOnce({
      isActive: () => false,
      idleToTrashMs: DAY,
      trashToPurgeMs: 7 * DAY,
      log: (m) => lines.push(m),
    })
    expect(lines.some(l => l.includes('demoted'))).toBe(true)
    expect(lines.some(l => l.includes('purged'))).toBe(true)
  })

  // --- Sanity: trashed dirs are accessible afterwards (file content intact) ---

  it('preserves snapshot content through demote', async () => {
    const id = 'aaaaaaaaaaaaaaaa'
    await mkdir(join(sharedPaths.instancesRoot(), id), { recursive: true })
    await writeFile(join(sharedPaths.instancesRoot(), id, 'snapshot.json'), '{"hello":"world"}')
    await setMtime(join(sharedPaths.instancesRoot(), id, 'snapshot.json'), 2 * DAY)

    await runJanitorOnce({
      isActive: () => false,
      idleToTrashMs: DAY,
      trashToPurgeMs: 7 * DAY,
    })

    const trashEntries = await readdir(sharedPaths.trashRoot())
    const trashedDir = trashEntries.find(e => e.startsWith(id + '-'))!
    const snap = await Bun.file(join(sharedPaths.trashRoot(), trashedDir, 'snapshot.json')).text()
    expect(snap).toBe('{"hello":"world"}')
  })
})
