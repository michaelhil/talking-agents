// ============================================================================
// resolveActiveWikis — covers the failure mode that the v0.9.x bug exposed:
// the registry was frozen at boot when discovery returned 0; later
// discovery picks up wikis but the registry didn't know about them, so
// hasWiki(id) returned false and refresh 404'd.
//
// The new contract: every read goes through resolveActiveWikis →
// registry.reconcile(merged) → registry sees the current set every time.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWikiRegistry } from './registry.ts'
import { invalidateDiscoveryCache } from './discovery.ts'
import { resolveActiveWikis } from './resolve-active.ts'

let dir: string
let storePath: string
const ORIG_SOURCES = process.env.SAMSINN_WIKI_SOURCES

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wiki-resolve-'))
  storePath = join(dir, 'wikis.json')
  invalidateDiscoveryCache()
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  invalidateDiscoveryCache()
  if (ORIG_SOURCES === undefined) delete process.env.SAMSINN_WIKI_SOURCES
  else process.env.SAMSINN_WIKI_SOURCES = ORIG_SOURCES
})

describe('resolveActiveWikis', () => {
  it('reconciles the registry on each call (no boot-freeze)', async () => {
    // Discovery source that doesn't exist → empty set.
    process.env.SAMSINN_WIKI_SOURCES = 'definitely-not-a-real-org-zxqwer1234'
    const registry = createWikiRegistry({ wikis: [] })

    // First call: empty store + empty discovery → registry is empty.
    let merged = await resolveActiveWikis(storePath, registry)
    expect(merged).toEqual([])
    expect(registry.list()).toEqual([])

    // Now the store gains a stored wiki. resolveActiveWikis should see it.
    await writeFile(storePath, JSON.stringify({
      version: 1,
      wikis: [{ id: 'late', owner: 'u', repo: 'r' }],
    }))
    merged = await resolveActiveWikis(storePath, registry)
    expect(merged.map((w) => w.id)).toEqual(['late'])
    // Reconcile installed the adapter — the registry now knows about it.
    expect(registry.getState('late')).toBeDefined()
  })

  it('drops ids no longer in the merged set', async () => {
    await writeFile(storePath, JSON.stringify({
      version: 1,
      wikis: [{ id: 'first', owner: 'u', repo: 'r' }],
    }))
    process.env.SAMSINN_WIKI_SOURCES = 'definitely-not-a-real-org-zxqwer1234'
    const registry = createWikiRegistry({ wikis: [] })

    await resolveActiveWikis(storePath, registry)
    expect(registry.getState('first')).toBeDefined()

    // Wipe the store. Next reconcile evicts.
    await writeFile(storePath, JSON.stringify({ version: 1, wikis: [] }))
    invalidateDiscoveryCache()
    await resolveActiveWikis(storePath, registry)
    expect(registry.getState('first')).toBeUndefined()
  })

  it('fires onNewWiki exactly once per new id across multiple resolve calls', async () => {
    process.env.SAMSINN_WIKI_SOURCES = 'definitely-not-a-real-org-zxqwer1234'
    const registry = createWikiRegistry({ wikis: [] })
    const newCalls: string[] = []
    registry.setOnNewWiki((id) => newCalls.push(id))

    await writeFile(storePath, JSON.stringify({
      version: 1,
      wikis: [{ id: 'one', owner: 'u', repo: 'r' }],
    }))

    await resolveActiveWikis(storePath, registry)
    await resolveActiveWikis(storePath, registry)
    await resolveActiveWikis(storePath, registry)
    expect(newCalls).toEqual(['one'])
  })
})
