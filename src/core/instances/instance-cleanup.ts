// ============================================================================
// Instance janitor — disk-side complement to the in-memory registry.
//
// Two responsibilities:
//   1. Demote: instances/<id>/ with snapshot.json mtime > IDLE_TO_TRASH_MS
//      AND not currently in the live registry → mv to instances/.trash/.
//      This is the "1 day on disk" rule from the multi-instance plan
//      (settled in stress-test Q4 = 1 day).
//   2. Purge: instances/.trash/<id>-<ts>/ with mtime > TRASH_TO_PURGE_MS
//      → rm -rf. Default 7 days — defends against clock skew and
//      reset-by-accident regret.
//
// Runs hourly. Idempotent. Logs each action via the provided log fn so
// the operator can see what's been demoted/purged.
// ============================================================================

import { readdir, stat, rename, rm, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { sharedPaths, isValidInstanceId, trashPath } from '../paths.ts'

const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS

const DEFAULT_IDLE_TO_TRASH_MS = 1 * DAY_MS    // 24 h
const DEFAULT_TRASH_TO_PURGE_MS = 7 * DAY_MS   // 7 days

const idleToTrashMsFromEnv = (): number => {
  const v = process.env.SAMSINN_INSTANCE_TTL_MS
  if (!v) return DEFAULT_IDLE_TO_TRASH_MS
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_IDLE_TO_TRASH_MS
}

const trashToPurgeMsFromEnv = (): number => {
  const v = process.env.SAMSINN_TRASH_TTL_MS
  if (!v) return DEFAULT_TRASH_TO_PURGE_MS
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TRASH_TO_PURGE_MS
}

export interface JanitorOptions {
  // Predicate: is this id currently active in the live registry?
  // Janitor refuses to touch active instances on disk.
  readonly isActive: (id: string) => boolean
  readonly idleToTrashMs?: number
  readonly trashToPurgeMs?: number
  // Log line per action. Default: console.log to stdout (journald in deploy).
  readonly log?: (msg: string) => void
  readonly now?: () => number
}

export interface JanitorRunResult {
  readonly demoted: ReadonlyArray<string>   // ids moved to trash
  readonly purged: ReadonlyArray<string>    // trash entries deleted
  readonly errors: ReadonlyArray<string>
}

// One janitor pass — exposed so tests can call it directly without timers.
export const runJanitorOnce = async (opts: JanitorOptions): Promise<JanitorRunResult> => {
  const idleToTrash = opts.idleToTrashMs ?? idleToTrashMsFromEnv()
  const trashToPurge = opts.trashToPurgeMs ?? trashToPurgeMsFromEnv()
  const now = opts.now?.() ?? Date.now()
  const log = opts.log ?? ((m: string) => console.log(m))

  const demoted: string[] = []
  const purged: string[] = []
  const errors: string[] = []

  // --- Demote: instances/<id>/ → instances/.trash/<id>-<ts>/ ---
  const instancesRoot = sharedPaths.instancesRoot()
  let entries: string[] = []
  try {
    entries = await readdir(instancesRoot)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') errors.push(`readdir instances: ${(err as Error).message}`)
    // Nothing to do if the dir doesn't exist yet.
    entries = []
  }

  for (const id of entries) {
    if (id === '.trash') continue
    if (!isValidInstanceId(id)) continue       // ignore non-conforming dirs
    if (opts.isActive(id)) continue             // never demote an active instance

    const instanceDir = join(instancesRoot, id)
    let mtime: number
    try {
      // Use the snapshot file mtime (written on every save). Falls back
      // to the directory mtime if snapshot.json is absent.
      const snapStat = await stat(join(instanceDir, 'snapshot.json'))
        .catch(() => stat(instanceDir))
      mtime = snapStat.mtimeMs
    } catch (err) {
      errors.push(`stat ${id}: ${(err as Error).message}`)
      continue
    }

    if (now - mtime <= idleToTrash) continue    // still fresh

    const target = trashPath(id, now)
    try {
      await mkdir(dirname(target), { recursive: true })
      await rename(instanceDir, target)
      demoted.push(id)
      log(`[janitor] demoted ${id} → trash (idle ${Math.round((now - mtime) / HOUR_MS)}h)`)
    } catch (err) {
      errors.push(`demote ${id}: ${(err as Error).message}`)
    }
  }

  // --- Purge: .trash/<id>-<ts>/ → rm -rf ---
  const trashRoot = sharedPaths.trashRoot()
  let trashEntries: string[] = []
  try {
    trashEntries = await readdir(trashRoot)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') errors.push(`readdir trash: ${(err as Error).message}`)
    trashEntries = []
  }

  for (const name of trashEntries) {
    const dir = join(trashRoot, name)
    let mtime: number
    try {
      const s = await stat(dir)
      if (!s.isDirectory()) continue
      mtime = s.mtimeMs
    } catch (err) {
      errors.push(`stat trash/${name}: ${(err as Error).message}`)
      continue
    }
    if (now - mtime <= trashToPurge) continue

    try {
      await rm(dir, { recursive: true, force: true })
      purged.push(name)
      log(`[janitor] purged ${name} (age ${Math.round((now - mtime) / DAY_MS)}d)`)
    } catch (err) {
      errors.push(`purge ${name}: ${(err as Error).message}`)
    }
  }

  return { demoted, purged, errors }
}

// Background janitor: hourly setInterval. Returns a stop fn so the caller
// can clean up on shutdown.
export interface JanitorRunner {
  readonly stop: () => void
}

export const startJanitor = (opts: JanitorOptions): JanitorRunner => {
  let stopped = false
  const tick = async (): Promise<void> => {
    if (stopped) return
    try { await runJanitorOnce(opts) } catch (err) {
      console.error(`[janitor] tick failed: ${(err as Error).message}`)
    }
  }
  // First tick after a short delay so boot doesn't pay the cost; then hourly.
  const initial = setTimeout(() => { void tick() }, 60_000)
  const interval = setInterval(() => { void tick() }, HOUR_MS)
  return {
    stop: () => {
      stopped = true
      clearTimeout(initial)
      clearInterval(interval)
    },
  }
}
