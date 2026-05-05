// ============================================================================
// One-shot filesystem migration: move drop-in dirs into the local pack.
//
// Old layout (pre-commit P):
//   ~/.samsinn/tools/*.ts              ← drop-in tools
//   ~/.samsinn/skills/<name>/SKILL.md  ← drop-in skills
//   ~/.samsinn/scripts/*.md            ← drop-in scripts
//   ~/.samsinn/geodata/*.geojson       ← user-paste geodata
//
// New layout:
//   ~/.samsinn/packs/local/tools/*.ts
//   ~/.samsinn/packs/local/skills/<name>/SKILL.md
//   ~/.samsinn/packs/local/scripts/*.md
//   ~/.samsinn/packs/local/geodata/*.geojson
//
// Why: aligns the local pack with all other packs (~/.samsinn/packs/<ns>/...).
// Operator can `cd ~/.samsinn/packs/local/` and see their stuff alongside
// installed packs. No behavior change — files load + tag identically.
//
// Safety:
//   - Idempotent: a sentinel file (.local-pack-migrated) prevents repeat runs.
//   - Tarball backup of all four dirs before any moves.
//   - Refuses to migrate if BOTH old and new dirs have files (would risk
//     clobbering — operator must resolve manually).
//   - Cache subdirs (geodata/.bundled/) stay at the OLD path; they're not
//     user data and rebuild themselves on demand.
// ============================================================================

import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { $ } from 'bun'
import { formatShellError } from './redact.ts'

const SENTINEL_FILENAME = '.local-pack-migrated'
const BACKUP_PREFIX = '.backup-pre-local-pack-'

// Subdirs to leave behind in the old location (cache data, not user data).
// `geodata/.bundled/` is the snapshot cache from samsinn-geodata discovery.
const CACHE_SUBDIRS_TO_KEEP: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  ['geodata', ['.bundled']],
])

interface DirMigration {
  readonly dir: 'tools' | 'skills' | 'scripts' | 'geodata'
  readonly oldPath: string
  readonly newPath: string
  readonly entries: ReadonlyArray<string>   // entries to move (excludes cache subdirs)
}

export interface MigrationResult {
  readonly status: 'skipped' | 'migrated' | 'failed'
  readonly reason?: string
  readonly backupPath?: string
  readonly moved?: ReadonlyArray<{ readonly dir: string; readonly count: number }>
}

const isEntryMovable = (dir: string, entry: string): boolean => {
  if (entry.startsWith('.')) {
    // Hidden files / cache dirs explicitly listed stay put.
    const cacheList = CACHE_SUBDIRS_TO_KEEP.get(dir) ?? []
    if (cacheList.includes(entry)) return false
    // Other dotfiles (e.g. .DS_Store) move along with everything else.
  }
  return true
}

const listMovable = async (dir: string, dirPath: string): Promise<ReadonlyArray<string>> => {
  if (!existsSync(dirPath)) return []
  try {
    const entries = await readdir(dirPath)
    return entries.filter(e => isEntryMovable(dir, e))
  } catch { return [] }
}

const detectConflict = async (planned: ReadonlyArray<DirMigration>): Promise<string | null> => {
  // Conflict iff old has movable entries AND new already exists with content.
  // The migration would clobber or interleave; refuse and ask operator to
  // resolve manually.
  for (const m of planned) {
    if (m.entries.length === 0) continue
    if (existsSync(m.newPath)) {
      try {
        const existing = await readdir(m.newPath)
        if (existing.length > 0) {
          return `${m.newPath} already has content; refusing to merge with ${m.oldPath}/. Move or delete one set manually.`
        }
      } catch { /* unreadable — let it through, mkdir below will fail loudly */ }
    }
  }
  return null
}

const buildBackup = async (home: string, dirs: ReadonlyArray<string>): Promise<string> => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = join(home, `${BACKUP_PREFIX}${stamp}.tar.gz`)
  // Build relative-path args so tar entries don't carry absolute paths.
  // Skip entries that don't actually exist; tar would error otherwise.
  const realDirs = dirs.filter(d => existsSync(join(home, d)))
  if (realDirs.length === 0) return backupPath
  const result = await $`tar -czf ${backupPath} -C ${home} ${realDirs}`.quiet().nothrow()
  if (result.exitCode !== 0) {
    throw new Error(`tar backup failed (exit ${result.exitCode}): ${formatShellError(result, 'tar')}`)
  }
  return backupPath
}

const moveEntries = async (m: DirMigration): Promise<number> => {
  await mkdir(m.newPath, { recursive: true })
  let moved = 0
  for (const entry of m.entries) {
    const from = join(m.oldPath, entry)
    const to = join(m.newPath, entry)
    // Cross-filesystem rename can fail with EXDEV; fall back to copy+rm.
    // In practice ~/.samsinn/ lives on one filesystem so rename works, but
    // operators with $SAMSINN_HOME pointing at a different mount need the
    // fallback path.
    try {
      await rename(from, to)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EXDEV') {
        const cp = await $`cp -R ${from} ${to}`.quiet().nothrow()
        if (cp.exitCode !== 0) {
          throw new Error(`cross-fs copy failed for ${from}: ${formatShellError(cp, 'cp -R')}`)
        }
        const rm = await $`rm -rf ${from}`.quiet().nothrow()
        if (rm.exitCode !== 0) {
          throw new Error(`source cleanup failed for ${from}: ${formatShellError(rm, 'rm -rf')}`)
        }
      } else {
        throw err
      }
    }
    moved++
  }
  return moved
}

export const migrateLocalPack = async (home: string): Promise<MigrationResult> => {
  const sentinel = join(home, SENTINEL_FILENAME)
  if (existsSync(sentinel)) return { status: 'skipped', reason: 'sentinel present' }

  // Plan: which subdirs have files to move?
  const dirs = ['tools', 'skills', 'scripts', 'geodata'] as const
  const planned: DirMigration[] = []
  for (const dir of dirs) {
    const oldPath = join(home, dir)
    const newPath = join(home, 'packs', 'local', dir)
    const entries = await listMovable(dir, oldPath)
    planned.push({ dir, oldPath, newPath, entries })
  }

  const totalToMove = planned.reduce((n, m) => n + m.entries.length, 0)
  if (totalToMove === 0) {
    // Nothing to do — but write the sentinel so the next boot doesn't
    // re-scan. Cheap insurance against future drift.
    try {
      await mkdir(home, { recursive: true })
      await writeFile(sentinel, `${new Date().toISOString()} no-op\n`)
    } catch (err) {
      console.warn('[migrate] sentinel write failed (no-op path):', err)
    }
    return { status: 'skipped', reason: 'no drop-in files to migrate' }
  }

  // Conflict check before any destructive work.
  const conflict = await detectConflict(planned)
  if (conflict) {
    return { status: 'failed', reason: conflict }
  }

  // Backup tarball first. If this fails, abort — we will not move
  // a single file without a recovery path.
  let backupPath: string
  try {
    backupPath = await buildBackup(home, dirs.map(d => d))
  } catch (err) {
    return { status: 'failed', reason: `backup failed: ${(err as Error).message}` }
  }

  // Execute moves. Track what completed for the result report.
  const moved: { dir: string; count: number }[] = []
  for (const m of planned) {
    if (m.entries.length === 0) continue
    try {
      const count = await moveEntries(m)
      moved.push({ dir: m.dir, count })
    } catch (err) {
      // Partial migration. The sentinel is NOT written, so the next boot
      // will see the conflict (some files in old, some in new) and
      // refuse with a clear error. Operator restores from the backup
      // tarball at backupPath.
      return {
        status: 'failed',
        reason: `move failed for ${m.dir}: ${(err as Error).message}. Backup at ${backupPath}.`,
        backupPath,
        moved,
      }
    }
  }

  // Sentinel + return.
  try {
    await writeFile(sentinel, `${new Date().toISOString()} migrated\n`)
  } catch (err) {
    console.warn('[migrate] sentinel write failed after migration:', err)
  }

  return { status: 'migrated', backupPath, moved }
}
