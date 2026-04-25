import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, stat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSystemRegistry, type SystemRegistry } from './system-registry.ts'
import { createSharedRuntime } from './shared-runtime.ts'
import { instancePaths } from './paths.ts'
import { generateInstanceId } from '../api/instance-cookie.ts'

// Phase D registry tests use the SAMSINN_HOME env var to redirect all paths
// into a per-test tmpdir. The shared runtime is built with no providers
// (single-Ollama mode, but Ollama URL never hit) so tests are network-free.

describe('SystemRegistry', () => {
  let originalHome: string | undefined
  let homeDir: string
  let registry: SystemRegistry

  beforeEach(async () => {
    originalHome = process.env.SAMSINN_HOME
    homeDir = await mkdtemp(join(tmpdir(), 'samsinn-registry-'))
    process.env.SAMSINN_HOME = homeDir
    // PROVIDER=ollama keeps shared runtime quiet — no cloud gateways built.
    process.env.PROVIDER = 'ollama'
    const shared = createSharedRuntime()
    registry = createSystemRegistry({ shared, idleMs: 1_000_000 })  // long idle so no auto-evict in unit tests
  })

  afterEach(async () => {
    await registry.shutdown()
    if (originalHome === undefined) delete process.env.SAMSINN_HOME
    else process.env.SAMSINN_HOME = originalHome
    delete process.env.PROVIDER
    await rm(homeDir, { recursive: true, force: true })
  })

  // --- Validity ---

  it('rejects invalid instance ids', async () => {
    await expect(registry.getOrLoad('bad')).rejects.toThrow(/invalid instance id/)
    await expect(registry.getOrLoad('UPPERCASE12345AB')).rejects.toThrow(/invalid instance id/)
    await expect(registry.getOrLoad('../etc/passwd000')).rejects.toThrow(/invalid instance id/)
  })

  // --- Round-trip + caching ---

  it('round-trip: same id returns same system', async () => {
    const id = generateInstanceId()
    const a = await registry.getOrLoad(id)
    const b = await registry.getOrLoad(id)
    expect(a).toBe(b)
  })

  it('different ids return different systems', async () => {
    const a = await registry.getOrLoad(generateInstanceId())
    const b = await registry.getOrLoad(generateInstanceId())
    expect(a).not.toBe(b)
  })

  // --- Concurrency ---

  it('concurrent getOrLoad on same id resolves to one system (pendingLoads dedupe)', async () => {
    const id = generateInstanceId()
    const [a, b, c] = await Promise.all([
      registry.getOrLoad(id),
      registry.getOrLoad(id),
      registry.getOrLoad(id),
    ])
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  // --- Eviction round-trip ---

  it('evicts then lazy-reloads with state preserved', async () => {
    const id = generateInstanceId()
    const sys1 = await registry.getOrLoad(id)
    sys1.house.createRoomSafe({ name: 'evict-test-room', createdBy: 'system' })
    expect(sys1.house.listAllRooms().some(r => r.name ==='evict-test-room')).toBe(true)

    // Snapshot file shouldn't exist yet (autosaver debounced 5 s).
    // Eviction's flush forces a save.
    await registry.evictOne(id)
    expect(registry.list().some(m => m.id === id)).toBe(false)

    // Snapshot file should exist on disk now.
    const stats = await stat(instancePaths(id).snapshot)
    expect(stats.size).toBeGreaterThan(0)

    // Lazy reload — fresh system, but room restored from disk.
    const sys2 = await registry.getOrLoad(id)
    expect(sys2).not.toBe(sys1)
    expect(sys2.house.listAllRooms().some(r => r.name ==='evict-test-room')).toBe(true)
  })

  // --- Evict-while-active race ---

  it('request mid-eviction awaits the eviction then loads fresh from disk', async () => {
    const id = generateInstanceId()
    const sys1 = await registry.getOrLoad(id)
    sys1.house.createRoomSafe({ name: 'race-room', createdBy: 'system' })

    // Kick off evict but don't await yet.
    const evicting = registry.evictOne(id)

    // Concurrent request — must await the eviction, then return a fresh
    // instance loaded from the just-flushed snapshot.
    const [, sys2] = await Promise.all([evicting, registry.getOrLoad(id)])

    expect(sys2).not.toBe(sys1)
    expect(sys2.house.listAllRooms().some(r => r.name ==='race-room')).toBe(true)
  })

  // --- Idempotent eviction ---

  it('evictOne is idempotent for unknown id', async () => {
    await registry.evictOne('aaaaaaaaaaaaaaaa')   // never created
    // No throw, no side effects.
    expect(registry.list().length).toBe(0)
  })

  it('two concurrent evictOne calls share a single eviction', async () => {
    const id = generateInstanceId()
    await registry.getOrLoad(id)
    const [a, b] = await Promise.all([registry.evictOne(id), registry.evictOne(id)])
    expect(a).toBeUndefined()
    expect(b).toBeUndefined()
    expect(registry.list().some(m => m.id === id)).toBe(false)
  })

  // --- Idle eviction ---

  it('evictIdle drops instances older than idleMs', async () => {
    const reg = createSystemRegistry({
      shared: createSharedRuntime(),
      idleMs: 50,
    })
    const idA = generateInstanceId()
    const idB = generateInstanceId()
    await reg.getOrLoad(idA)
    await new Promise(r => setTimeout(r, 80))
    await reg.getOrLoad(idB)        // freshly touched

    const evictedCount = await reg.evictIdle(Date.now())
    expect(evictedCount).toBe(1)
    expect(reg.list().some(m => m.id === idA)).toBe(false)
    expect(reg.list().some(m => m.id === idB)).toBe(true)
    await reg.shutdown()
  })

  // --- exists ---

  it('exists is true after disk persistence', async () => {
    const id = generateInstanceId()
    const sys = await registry.getOrLoad(id)
    sys.house.createRoomSafe({ name: 'exists-test', createdBy: 'system' })
    await registry.evictOne(id)
    expect(await registry.exists(id)).toBe(true)
  })

  it('exists is false for never-created id', async () => {
    expect(await registry.exists('aaaaaaaaaaaaaaaa')).toBe(false)
  })

  // --- Reset ---

  it('resetInstance moves files to trash; same id is reusable for fresh House', async () => {
    const id = generateInstanceId()
    const sys = await registry.getOrLoad(id)
    sys.house.createRoomSafe({ name: 'reset-test', createdBy: 'system' })
    await registry.evictOne(id)
    expect(await registry.exists(id)).toBe(true)

    await registry.resetInstance(id)
    expect(await registry.exists(id)).toBe(false)

    // Trash entry created.
    const trashEntries = await readdir(join(homeDir, 'instances', '.trash'))
    expect(trashEntries.some(e => e.startsWith(id + '-'))).toBe(true)

    // Same id is now usable for a fresh empty House.
    const sys2 = await registry.getOrLoad(id)
    expect(sys2.house.listAllRooms().length).toBe(0)
  })

  it('resetInstance is safe for nonexistent id (ENOENT swallowed)', async () => {
    await registry.resetInstance('aaaaaaaaaaaaaaaa')
    // Should not throw; nothing to do.
  })

  // --- list / meta ---

  it('list reflects current in-memory state', async () => {
    const id = generateInstanceId()
    expect(registry.list()).toEqual([])
    await registry.getOrLoad(id)
    const meta = registry.list()
    expect(meta.length).toBe(1)
    expect(meta[0]?.id).toBe(id)
    expect(meta[0]?.state).toBe('active')
  })

  // --- Shutdown ---

  it('shutdown flushes every active instance', async () => {
    const idA = generateInstanceId()
    const idB = generateInstanceId()
    const sa = await registry.getOrLoad(idA)
    const sb = await registry.getOrLoad(idB)
    sa.house.createRoomSafe({ name: 'shut-a', createdBy: 'system' })
    sb.house.createRoomSafe({ name: 'shut-b', createdBy: 'system' })

    await registry.shutdown()
    expect(registry.list()).toEqual([])
    await stat(instancePaths(idA).snapshot)
    await stat(instancePaths(idB).snapshot)
  })

  // --- Hooks ---

  it('onSystemCreated fires once per fresh load', async () => {
    const calls: string[] = []
    const reg = createSystemRegistry({
      shared: createSharedRuntime(),
      onSystemCreated: (_sys, id) => calls.push(id),
    })
    const id = generateInstanceId()
    await reg.getOrLoad(id)
    await reg.getOrLoad(id)        // same instance — no second hook
    expect(calls).toEqual([id])
    await reg.evictOne(id)
    await reg.getOrLoad(id)        // post-evict reload — second hook
    expect(calls).toEqual([id, id])
    await reg.shutdown()
  })

  it('onSystemEvicted fires before the system is dropped', async () => {
    const calls: string[] = []
    const reg = createSystemRegistry({
      shared: createSharedRuntime(),
      onSystemEvicted: (_sys, id) => calls.push(id),
    })
    const id = generateInstanceId()
    await reg.getOrLoad(id)
    await reg.evictOne(id)
    expect(calls).toEqual([id])
    await reg.shutdown()
  })
})
