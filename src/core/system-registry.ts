// ============================================================================
// SystemRegistry — per-tenant House lifecycle keyed by instance ID.
//
// One process holds many instances; each is a System bound to its own
// snapshot file. The registry lazy-loads from disk on first request,
// keeps the System in memory while active, and evicts idle ones after
// SAMSINN_IDLE_MS (default 30 min) by flushing snapshot + dropping the
// in-memory reference. Subsequent requests lazy-reload from disk.
//
// Concurrency contract:
//   - `pendingLoads` dedupes concurrent first-time loads of the same id.
//   - In-map entries can be in `state: 'active' | 'evicting'`.
//     New requests during eviction await the eviction completion, then
//     load fresh from disk.
//   - All maps are mutated only on the event loop thread (single-threaded
//     JS); no locks needed. The discipline is: never `await` between a
//     state read and a state write that depends on it.
//
// Public surface:
//   getOrLoad(id)           — single source of truth; touches lastTouchedAt
//   evictOne(id)            — graceful: drain → flush → drop. Idempotent.
//   evictIdle(now, idleMs)  — periodic sweep
//   resetInstance(id)       — wipe state, return new id (for /api/system/reset)
//   exists(id)              — disk OR memory
//   list()                  — readonly meta for admin
//   shutdown()              — flush all + clear
//
// What lives outside the registry's concern:
//   - Snapshot path resolution (uses instancePaths from core/paths.ts)
//   - Per-instance event-callback wiring (Phase F: wireSystemEvents)
//   - Janitor (Phase E: instance-cleanup.ts) — operates on disk only
// ============================================================================

import type { System } from '../main.ts'
import type { SharedRuntime } from './shared-runtime.ts'
import { createSystem } from '../main.ts'
import {
  loadSnapshot, restoreFromSnapshot, createAutoSaver, type AutoSaver,
} from './snapshot.ts'
import { instancePaths, isValidInstanceId, sharedPaths, trashPath } from './paths.ts'
import { mkdir, readdir, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { asAIAgent } from '../agents/shared.ts'
import { seedFreshInstance } from './seed-example.ts'

// --- Defaults & env ---

const DEFAULT_IDLE_MS = 30 * 60_000   // 30 min
const DEFAULT_DRAIN_MS = 5_000

const idleMsFromEnv = (): number => {
  const v = process.env.SAMSINN_IDLE_MS
  if (!v) return DEFAULT_IDLE_MS
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_IDLE_MS
}

// --- Types ---

export interface InstanceMeta {
  readonly id: string
  readonly lastTouchedAt: number
  readonly state: 'active' | 'evicting'
}

export interface InstanceOnDisk {
  readonly id: string
  readonly snapshotMtimeMs: number   // 0 if snapshot file is missing
  readonly snapshotSizeBytes: number // 0 if snapshot file is missing
}

interface InstanceEntry {
  readonly system: System
  readonly autoSaver: AutoSaver
  readonly onIdle: () => Promise<void>          // hook called by registry on evict
  lastTouchedAt: number
  state: 'active' | 'evicting'
  evictionPromise?: Promise<void>               // present iff state='evicting'
}

export interface SystemRegistryOptions {
  readonly shared: SharedRuntime
  readonly idleMs?: number                      // override default 30 min
  readonly drainMs?: number                     // override default 5s
  // Hook called immediately after a fresh System is constructed (either
  // first load or post-eviction reload). Phase F wires WS broadcasts here.
  // The autoSaver is passed in directly because the registry's map entry
  // isn't set until AFTER this hook returns — so registry.autoSaverFor(id)
  // would return null inside the hook. Subtle and was the source of a
  // long-running bug where streaming events never reached cookie-bound
  // instances.
  readonly onSystemCreated?: (system: System, id: string, autoSaver: AutoSaver) => void
  // Hook called immediately before a System is dropped from memory.
  // Phase F removes the WS callback wiring here.
  readonly onSystemEvicted?: (system: System, id: string) => void
}

export interface SystemRegistry {
  readonly getOrLoad: (id: string) => Promise<System>
  readonly evictOne: (id: string) => Promise<void>
  readonly evictIdle: (now?: number) => Promise<number>
  // Trash the instance's on-disk state and drop from memory. The same id
  // is preserved — browser keeps its cookie, next request lazy-creates a
  // fresh empty House under the same id.
  readonly resetInstance: (id: string) => Promise<void>
  readonly exists: (id: string) => Promise<boolean>
  readonly list: () => ReadonlyArray<InstanceMeta>
  // Enumerate every valid instance directory under SAMSINN_HOME/instances,
  // returning snapshot mtime + size. Includes instances not currently in
  // memory. Used by the Instances admin UI.
  readonly listOnDisk: () => Promise<ReadonlyArray<InstanceOnDisk>>
  readonly shutdown: () => Promise<void>
  // For tests + boundary handlers that need to know the configured timer.
  readonly idleMs: () => number
  // Boundary access to the in-memory autosaver for an active instance.
  // wireSystemEvents needs it to schedule saves from broadcast callbacks.
  // Returns null if the instance is not currently in memory.
  readonly autoSaverFor: (id: string) => AutoSaver | null
  // In-memory only lookup. Returns the live System for `id` if it is
  // currently loaded and active (not evicting), else undefined. Used by
  // boundary code that must NOT trigger a lazy-load — e.g. WS snapshot
  // building (caller already resolved the system to bind the session)
  // and late provider routing events for evicted instances.
  readonly tryGetLive: (id: string) => System | undefined
  // Agent → instance reverse index for provider routing events. Phase F4
  // wires shared.setProviderEventDispatcher to use this.
  readonly attachAgent: (agentId: string, instanceId: string) => void
  readonly detachAgent: (agentId: string) => void
  readonly instanceForAgent: (agentId: string) => string | undefined
}

// ============================================================================

export const createSystemRegistry = (opts: SystemRegistryOptions): SystemRegistry => {
  const idleMs = opts.idleMs ?? idleMsFromEnv()
  const drainMs = opts.drainMs ?? DEFAULT_DRAIN_MS
  const map = new Map<string, InstanceEntry>()
  const pendingLoads = new Map<string, Promise<System>>()
  // Reverse index for provider event routing. Populated when an agent
  // is spawned in an instance; cleared on agent removal or instance evict.
  const agentInstanceMap = new Map<string, string>()

  // --- Internals ---

  const drainAgents = async (system: System): Promise<void> => {
    const timeout = new Promise<void>(res => setTimeout(res, drainMs))
    const aiAgents = system.team.listAgents()
      .flatMap(a => { const ai = asAIAgent(a); return ai ? [ai] : [] })
    await Promise.all(aiAgents.map(a => Promise.race([a.whenIdle(), timeout])))
  }

  // Build the per-instance autosaver. Callback wiring (which schedules
  // save on each mutation) lives in src/api/wire-system-events.ts, which
  // gets the saver via autoSaverFor(id). Phase F's onSystemCreated hook
  // calls wireSystemEvents — that's the single source of save scheduling.
  const buildAutoSaver = (_system: System, snapshotPath: string): AutoSaver =>
    createAutoSaver(_system, snapshotPath)

  // Build a fresh System for `id`, restoring from snapshot if present.
  const buildSystem = async (id: string): Promise<{ system: System; autoSaver: AutoSaver }> => {
    const paths = instancePaths(id)
    await mkdir(dirname(paths.snapshot), { recursive: true })

    const system = createSystem({ shared: opts.shared, instanceLabel: id })

    // Restore snapshot if file exists. Corrupt snapshots get renamed
    // aside so the next save doesn't silently overwrite recoverable data.
    const snapshot = await loadSnapshot(paths.snapshot)
    if (snapshot) {
      try {
        await restoreFromSnapshot(system, snapshot)
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        console.error(`[registry] restore failed for ${id}: ${reason}`)
        // Move bad file aside, continue with empty house.
        const aside = `${paths.snapshot}.corrupt.${Date.now()}.json`
        try { await rename(paths.snapshot, aside) } catch { /* ignore */ }
      }
    }

    const autoSaver = buildAutoSaver(system, paths.snapshot)

    // Notify the registry's caller (e.g. WS broadcast wiring). autoSaver
    // is passed explicitly because the map entry isn't installed until
    // buildSystem returns; an autoSaverFor(id) lookup inside the hook
    // would return null.
    opts.onSystemCreated?.(system, id, autoSaver)

    // First-run seeding: when no snapshot existed, drop in a demo room +
    // Helper agent so an invitee lands on something they can immediately
    // try. Must run after onSystemCreated so the WS-broadcast wiring is in
    // place — otherwise the seed posts/spawns wouldn't reach connected
    // clients in race-condition cases. Failures are caught inside.
    if (!snapshot) {
      await seedFreshInstance(system)
      // Persist the seed so a refresh keeps it (without waiting for the
      // autosaver's debounce). Best-effort — autosaver will retry on its
      // own schedule if this throws.
      try { await autoSaver.flush() } catch { /* autosaver will retry */ }
    }

    return { system, autoSaver }
  }

  // --- Public API ---

  const getOrLoad = async (id: string): Promise<System> => {
    if (!isValidInstanceId(id)) {
      throw new Error(`[registry] invalid instance id: ${id}`)
    }

    // Fast path: in-map and not evicting.
    const existing = map.get(id)
    if (existing && existing.state === 'active') {
      existing.lastTouchedAt = Date.now()
      return existing.system
    }

    // Mid-eviction: wait for it to complete, then re-enter for a fresh load.
    if (existing && existing.state === 'evicting' && existing.evictionPromise) {
      await existing.evictionPromise
      return getOrLoad(id)
    }

    // Pending first-load by another caller: await same promise.
    const pending = pendingLoads.get(id)
    if (pending) return pending

    // Cold path: register the pending promise, do the work, transfer to map.
    const loadPromise = (async (): Promise<System> => {
      try {
        const { system, autoSaver } = await buildSystem(id)
        const entry: InstanceEntry = {
          system,
          autoSaver,
          lastTouchedAt: Date.now(),
          state: 'active',
          onIdle: async () => { /* set later if needed */ },
        }
        map.set(id, entry)
        return system
      } finally {
        pendingLoads.delete(id)
      }
    })()
    pendingLoads.set(id, loadPromise)
    return loadPromise
  }

  // Idempotent: calling evictOne twice (or while another caller is also
  // evicting) returns the same in-flight promise.
  const evictOne = async (id: string): Promise<void> => {
    const entry = map.get(id)
    if (!entry) return
    if (entry.state === 'evicting' && entry.evictionPromise) {
      return entry.evictionPromise
    }

    const evictionPromise = (async (): Promise<void> => {
      await drainAgents(entry.system).catch(err => {
        console.error(`[registry] evict ${id} drain failed (continuing): ${err instanceof Error ? err.message : String(err)}`)
      })

      // Bounded-retry flush. Originally this was a single try/catch that
      // dropped the entry from memory regardless — meaning a failed save
      // (disk full, perm flip) silently lost recent state on next load.
      // Retry with backoff; only force-evict (with ERROR log noting the
      // data-loss risk) if every attempt fails.
      const backoffMs = [5_000, 15_000, 60_000]
      let lastErr: unknown = null
      let flushed = false
      for (let attempt = 0; attempt < backoffMs.length; attempt++) {
        try {
          await entry.autoSaver.flush()
          flushed = true
          break
        } catch (err) {
          lastErr = err
          opts.shared.limitMetrics.inc('evictionFlushRetries')
          const reason = err instanceof Error ? err.message : String(err)
          console.error(`[registry] evict ${id} flush attempt ${attempt + 1}/${backoffMs.length} failed: ${reason}`)
          if (attempt < backoffMs.length - 1) {
            await new Promise(resolve => setTimeout(resolve, backoffMs[attempt]))
          }
        }
      }
      if (!flushed) {
        opts.shared.limitMetrics.inc('evictionForceEvicts')
        const reason = lastErr instanceof Error ? lastErr.message : String(lastErr)
        console.error(`[registry] evict ${id}: flush exhausted retries — FORCING EVICTION; recent state may be lost. last error: ${reason}`)
      }

      try { opts.onSystemEvicted?.(entry.system, id) } catch (err) {
        console.error(`[registry] evict ${id} hook threw: ${err instanceof Error ? err.message : String(err)}`)
      }
      entry.autoSaver.dispose()
      map.delete(id)
    })()

    entry.state = 'evicting'
    entry.evictionPromise = evictionPromise
    return evictionPromise
  }

  const evictIdle = async (now: number = Date.now()): Promise<number> => {
    const targets: string[] = []
    for (const [id, entry] of map) {
      if (entry.state === 'active' && now - entry.lastTouchedAt > idleMs) {
        targets.push(id)
      }
    }
    await Promise.all(targets.map(evictOne))
    return targets.length
  }

  const resetInstance = async (id: string): Promise<void> => {
    if (!isValidInstanceId(id)) {
      throw new Error(`[registry] invalid instance id: ${id}`)
    }
    // Drain + drop from memory.
    if (map.has(id)) await evictOne(id)
    // Move on disk to trash. Janitor purges after 7 days.
    const paths = instancePaths(id)
    const trash = trashPath(id, Date.now())
    try {
      await mkdir(dirname(trash), { recursive: true })
      await rename(paths.root, trash)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        console.error(`[registry] reset ${id} trash failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    // Same id is preserved. Browser cookie unchanged. Next request →
    // registry.getOrLoad(id) → no in-memory + no disk → fresh House.
  }

  const exists = async (id: string): Promise<boolean> => {
    if (!isValidInstanceId(id)) return false
    if (map.has(id)) return true
    try {
      await stat(instancePaths(id).snapshot)
      return true
    } catch {
      return false
    }
  }

  const list = (): ReadonlyArray<InstanceMeta> =>
    [...map.entries()].map(([id, e]) => ({
      id,
      lastTouchedAt: e.lastTouchedAt,
      state: e.state,
    }))

  const listOnDisk = async (): Promise<ReadonlyArray<InstanceOnDisk>> => {
    const root = sharedPaths.instancesRoot()
    let entries: string[]
    try {
      entries = await readdir(root)
    } catch {
      return []   // root doesn't exist yet — first boot
    }
    const out: InstanceOnDisk[] = []
    for (const name of entries) {
      // Skip .trash + anything that isn't a valid instance id.
      if (!isValidInstanceId(name)) continue
      let mtimeMs = 0
      let sizeBytes = 0
      try {
        const st = await stat(join(root, name, 'snapshot.json'))
        mtimeMs = st.mtimeMs
        sizeBytes = st.size
      } catch {
        // No snapshot yet (just-created instance) — directory exists, file doesn't.
      }
      out.push({ id: name, snapshotMtimeMs: mtimeMs, snapshotSizeBytes: sizeBytes })
    }
    return out
  }

  // Final flush of every active instance. Called from the SIGINT/SIGTERM
  // handler in bootstrap.ts (replaces the single-system flush).
  const shutdown = async (): Promise<void> => {
    const ids = [...map.keys()]
    await Promise.all(ids.map(evictOne))
  }

  const autoSaverFor = (id: string): AutoSaver | null => {
    const entry = map.get(id)
    return entry ? entry.autoSaver : null
  }

  const attachAgent = (agentId: string, instanceId: string): void => {
    agentInstanceMap.set(agentId, instanceId)
  }
  const detachAgent = (agentId: string): void => {
    agentInstanceMap.delete(agentId)
  }
  const instanceForAgent = (agentId: string): string | undefined =>
    agentInstanceMap.get(agentId)

  const tryGetLive = (id: string): System | undefined => {
    const entry = map.get(id)
    if (!entry || entry.state !== 'active') return undefined
    return entry.system
  }

  return {
    getOrLoad,
    evictOne,
    evictIdle,
    resetInstance,
    exists,
    list,
    listOnDisk,
    shutdown,
    idleMs: () => idleMs,
    autoSaverFor,
    tryGetLive,
    attachAgent,
    detachAgent,
    instanceForAgent,
  }
}
