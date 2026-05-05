// ============================================================================
// Script store — filesystem-backed loader (v3, markdown-native).
//
// Layout:
//   $SAMSINN_HOME/scripts/<name>/script.md      ← preferred
//   $SAMSINN_HOME/scripts/<name>.md             ← flat-form (single file)
//
// The on-disk format is markdown (see docs/scripts.md). Each .md file is
// parsed into a Script via parseScriptMd. The same shape drives runtime
// state and the living-document view.
// ============================================================================

import { readdir, readFile, stat, writeFile, mkdir, rm, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Script } from '../types/script.ts'
import { parseScriptMd, VALID_NAME } from './script-md-parser.ts'

// Hard cap on script source size. Scripts are markdown — the largest realistic
// hand-written one is a few KB. 256 KB is well above that and small enough
// that an agent can't DoS the parser/UI by writing a multi-MB file via
// write_script. Counted in UTF-16 code units (string.length); close enough
// for the purpose.
export const MAX_SCRIPT_SOURCE_BYTES = 256 * 1024

export interface ScriptStore {
  readonly get: (name: string) => Script | undefined
  readonly list: () => ReadonlyArray<Script>
  readonly reload: () => Promise<ReadonlyArray<string>>
  readonly upsert: (name: string, source: string) => Promise<Script>
  readonly remove: (name: string) => Promise<boolean>
  readonly onChange: (fn: () => void) => () => void
}

export const createScriptStore = (baseDir: string): ScriptStore => {
  const scripts = new Map<string, Script>()
  const listeners = new Set<() => void>()

  const fireChange = (): void => {
    for (const fn of listeners) {
      try { fn() } catch { /* listener errors must not break the store */ }
    }
  }

  const reload = async (): Promise<ReadonlyArray<string>> => {
    scripts.clear()
    const loaded = await scanScriptDir(baseDir)
    for (const s of loaded) scripts.set(s.name, s)
    fireChange()
    return loaded.map(s => s.name)
  }

  const upsert = async (name: string, source: string): Promise<Script> => {
    if (!VALID_NAME.test(name)) {
      throw new Error(`script name must match ${VALID_NAME} (got "${name}")`)
    }
    if (source.length > MAX_SCRIPT_SOURCE_BYTES) {
      throw new Error(`script source too large: ${source.length} bytes (max ${MAX_SCRIPT_SOURCE_BYTES})`)
    }
    parseScriptMd(name, source)   // validate before write
    const dir = join(baseDir, name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'script.md'), source, 'utf-8')
    await reload()
    const reloaded = scripts.get(name)
    if (!reloaded) throw new Error(`upsert: script "${name}" did not reload`)
    return reloaded
  }

  const remove = async (name: string): Promise<boolean> => {
    if (!VALID_NAME.test(name)) return false
    const dir = join(baseDir, name)
    const flat = join(baseDir, `${name}.md`)
    let removed = false
    try { await rm(dir, { recursive: true, force: true }); removed = true } catch { /* may not exist */ }
    try { await rm(flat, { force: true }); removed = removed || true } catch { /* may not exist */ }
    if (removed) await reload()
    return scripts.get(name) === undefined && removed
  }

  const onChange = (fn: () => void): (() => void) => {
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }

  return {
    get: (name) => scripts.get(name),
    list: () => [...scripts.values()],
    reload,
    upsert,
    remove,
    onChange,
  }
}

// === Filesystem scan ===

const scanScriptDir = async (baseDir: string): Promise<ReadonlyArray<Script>> => {
  let entries: string[]
  try {
    entries = await readdir(baseDir)
  } catch {
    return []
  }

  const out: Script[] = []
  for (const entry of entries) {
    const full = join(baseDir, entry)
    let info
    try { info = await stat(full) } catch { continue }

    let name: string
    let raw: string
    if (info.isDirectory()) {
      if (!VALID_NAME.test(entry)) {
        console.warn(`[scripts] "${entry}": directory name not a valid script name — skipping`)
        continue
      }
      try {
        raw = await readFile(join(full, 'script.md'), 'utf-8')
      } catch {
        continue
      }
      name = entry
    } else if (info.isFile() && entry.endsWith('.md')) {
      const stem = entry.slice(0, -'.md'.length)
      if (!VALID_NAME.test(stem)) {
        console.warn(`[scripts] "${entry}": filename not a valid script name — skipping`)
        continue
      }
      try {
        raw = await readFile(full, 'utf-8')
      } catch (err) {
        console.warn(`[scripts] "${entry}": read failed — ${err instanceof Error ? err.message : err}`)
        continue
      }
      name = stem
    } else {
      continue
    }

    try {
      const parsed = parseScriptMd(name, raw)
      out.push(parsed)
    } catch (err) {
      console.warn(`[scripts] "${name}": invalid — ${err instanceof Error ? err.message : err}`)
    }
  }

  console.log(`[scripts] ${baseDir}: ${out.length} loaded`)
  return out
}

// === Seed-on-startup: hash-tracked smart seeder. ===
//
// State machine per bundled example:
//
//   File missing on disk
//     → seed. Record bundled hash + timestamp in sidecar.
//
//   File present, current-on-disk hash == sidecar's lastBundledHash
//     → user hasn't edited; bundled has advanced; safely overwrite.
//       Update sidecar with new hash.
//
//   File present, hash mismatch
//     → user edited; LEAVE ALONE. Log a one-line hint pointing at
//       SAMSINN_RESEED_EXAMPLES so the operator can opt into update.
//
//   File present, no sidecar (first migration on existing install)
//     → take a no-overwrite baseline: hash current file as if it were
//       bundled, write to sidecar. From here on, future bundled updates
//       flow naturally. Existing prod files are NOT touched on this boot.
//
// One-shot escape hatch:
//
//   SAMSINN_RESEED_EXAMPLES=<value>
//
// Stored in sidecar as `lastReseedTrigger`. When env value differs from
// stored value, force-overwrite all bundled examples; record env value.
// Subsequent boots with the same value → skip. To re-trigger after another
// bundled update, bump the value (e.g. set to today's date or a version).
// Forgotten env vars are safe — same value = no-op.
// ============================================================================

import { createHash } from 'node:crypto'

const SEED_SIDECAR_NAME = '.seeded.json'
const SEED_SIDECAR_VERSION = 1

interface SeedSidecar {
  readonly version: number
  // Per-example record. Key is the script name (filename without .md).
  readonly examples: Record<string, { lastBundledHash: string; seededAt: number }>
  // Last value of SAMSINN_RESEED_EXAMPLES env that triggered a force overwrite.
  readonly lastReseedTrigger?: string
}

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf-8').digest('hex')

const loadSidecar = async (path: string): Promise<SeedSidecar | null> => {
  try {
    const raw = await readFile(path, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<SeedSidecar>
    if (parsed.version !== SEED_SIDECAR_VERSION) return null
    if (!parsed.examples || typeof parsed.examples !== 'object') return null
    return { version: SEED_SIDECAR_VERSION, examples: parsed.examples, ...(parsed.lastReseedTrigger ? { lastReseedTrigger: parsed.lastReseedTrigger } : {}) }
  } catch {
    return null
  }
}

const saveSidecar = async (path: string, data: SeedSidecar): Promise<void> => {
  await writeFile(path, JSON.stringify(data, null, 2), 'utf-8')
}

export interface SeedResult {
  readonly seeded: ReadonlyArray<string>
  readonly updated: ReadonlyArray<string>
  readonly skipped: ReadonlyArray<string>      // files present, content identical to last seed (no-op)
  readonly preserved: ReadonlyArray<string>    // user-edited; left alone
  readonly forceReseeded: boolean              // SAMSINN_RESEED_EXAMPLES triggered
}

export const seedExampleScripts = async (
  examplesDir: string,
  scriptsDir: string,
): Promise<SeedResult> => {
  let entries: string[]
  try {
    entries = await readdir(examplesDir)
  } catch {
    return { seeded: [], updated: [], skipped: [], preserved: [], forceReseeded: false }
  }

  await mkdir(scriptsDir, { recursive: true })
  const sidecarPath = join(scriptsDir, SEED_SIDECAR_NAME)
  const existingSidecar = await loadSidecar(sidecarPath)
  const reseedEnv = (process.env.SAMSINN_RESEED_EXAMPLES ?? '').trim() || undefined
  const forceReseed = !!reseedEnv && reseedEnv !== existingSidecar?.lastReseedTrigger

  const seeded: string[] = []
  const updated: string[] = []
  const skipped: string[] = []
  const preserved: string[] = []

  // Build the next sidecar incrementally so a partial run still leaves
  // recorded state for the files we did process.
  const nextExamples: Record<string, { lastBundledHash: string; seededAt: number }> =
    { ...(existingSidecar?.examples ?? {}) }

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const stem = entry.slice(0, -'.md'.length)
    if (!VALID_NAME.test(stem)) continue
    const srcPath = join(examplesDir, entry)
    const dstFlat = join(scriptsDir, entry)
    const dstDir = join(scriptsDir, stem, 'script.md')

    let bundled: string
    try {
      bundled = await readFile(srcPath, 'utf-8')
      parseScriptMd(stem, bundled)
    } catch (err) {
      console.warn(`[scripts] example "${entry}": skipped — ${err instanceof Error ? err.message : err}`)
      continue
    }
    const bundledHash = sha256(bundled)

    // Detect existing on-disk file in either layout.
    let existingPath: string | null = null
    let existingContent: string | null = null
    for (const candidate of [dstFlat, dstDir]) {
      try {
        const raw = await readFile(candidate, 'utf-8')
        existingPath = candidate
        existingContent = raw
        break
      } catch { /* not present */ }
    }

    if (!existingPath) {
      // Missing → seed.
      try {
        await copyFile(srcPath, dstFlat)
        nextExamples[stem] = { lastBundledHash: bundledHash, seededAt: Date.now() }
        seeded.push(stem)
      } catch (err) {
        console.warn(`[scripts] example "${entry}": seed failed — ${err instanceof Error ? err.message : err}`)
      }
      continue
    }

    const onDiskHash = sha256(existingContent ?? '')
    const recorded = nextExamples[stem]

    // No sidecar entry → first-migration baseline. Record current hash;
    // do NOT overwrite even if bundled differs. Next bundled update flows
    // naturally on subsequent boots.
    if (!recorded && !forceReseed) {
      nextExamples[stem] = { lastBundledHash: onDiskHash, seededAt: Date.now() }
      preserved.push(stem)
      continue
    }

    // Already up to date.
    if (onDiskHash === bundledHash) {
      // Ensure sidecar reflects current bundled hash even if we somehow
      // ended up here with a stale entry.
      if (!recorded || recorded.lastBundledHash !== bundledHash) {
        nextExamples[stem] = { lastBundledHash: bundledHash, seededAt: recorded?.seededAt ?? Date.now() }
      }
      skipped.push(stem)
      continue
    }

    // Force-reseed via env trumps user-edit detection.
    if (forceReseed) {
      try {
        await writeFile(existingPath, bundled, 'utf-8')
        nextExamples[stem] = { lastBundledHash: bundledHash, seededAt: Date.now() }
        updated.push(stem)
      } catch (err) {
        console.warn(`[scripts] example "${entry}": force-reseed write failed — ${err instanceof Error ? err.message : err}`)
      }
      continue
    }

    // User hasn't touched it (matches recorded hash) → safely update.
    if (recorded && onDiskHash === recorded.lastBundledHash) {
      try {
        await writeFile(existingPath, bundled, 'utf-8')
        nextExamples[stem] = { lastBundledHash: bundledHash, seededAt: Date.now() }
        updated.push(stem)
      } catch (err) {
        console.warn(`[scripts] example "${entry}": update write failed — ${err instanceof Error ? err.message : err}`)
      }
      continue
    }

    // Diverged from recorded → user edited. Leave alone.
    preserved.push(stem)
    if (recorded?.lastBundledHash !== bundledHash) {
      console.log(
        `[scripts] example "${stem}" has user edits — bundled version advanced ` +
        `but on-disk file is preserved. To overwrite with the bundled version, ` +
        `set SAMSINN_RESEED_EXAMPLES=<any-new-value> and restart.`,
      )
    }
  }

  // Write sidecar reflecting the final state, including the trigger we
  // applied (if any) so subsequent boots with the same value no-op.
  const nextSidecar: SeedSidecar = {
    version: SEED_SIDECAR_VERSION,
    examples: nextExamples,
    ...(reseedEnv ? { lastReseedTrigger: reseedEnv } : (existingSidecar?.lastReseedTrigger ? { lastReseedTrigger: existingSidecar.lastReseedTrigger } : {})),
  }
  try {
    await saveSidecar(sidecarPath, nextSidecar)
  } catch (err) {
    console.warn(`[scripts] failed to write seed sidecar: ${err instanceof Error ? err.message : err}`)
  }

  return { seeded, updated, skipped, preserved, forceReseeded: forceReseed }
}
