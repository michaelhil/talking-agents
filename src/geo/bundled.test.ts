import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __resetBundledCache, bundledStats, lookupBundled } from './bundled.ts'

let prevHome: string | undefined
let testDir: string

beforeEach(() => {
  prevHome = process.env.SAMSINN_HOME
  testDir = mkdtempSync(join(tmpdir(), 'samsinn-geo-bundled-test-'))
  process.env.SAMSINN_HOME = testDir
  __resetBundledCache()
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.SAMSINN_HOME
  else process.env.SAMSINN_HOME = prevHome
  rmSync(testDir, { recursive: true, force: true })
  __resetBundledCache()
})

describe('bundled — unset version (0.0.0)', () => {
  test('lookupBundled returns null without network', async () => {
    // Default geodataVersion in package.json is "0.0.0" — bundle is treated
    // as empty and no fetch fires. Test passes only because we never hit
    // the network; would fail with a fetch attempt if version were != 0.0.0.
    expect(await lookupBundled('city', 'Bergen')).toBeNull()
    expect(await lookupBundled('airport', 'OSL')).toBeNull()
  })

  test('bundledStats reports zero count for unset version', async () => {
    const stats = await bundledStats('city')
    expect(stats.count).toBe(0)
    expect(stats.version).toBe('0.0.0')
  })
})
