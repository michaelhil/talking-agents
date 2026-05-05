// ============================================================================
// Script store — filesystem-backed loader (v3, markdown-native).
//
// Layout:
//   <baseDir>/<name>/script.md      ← preferred
//   <baseDir>/<name>.md             ← flat-form (single file)
//
// The store reads from `baseDir` (writable; user scripts live here) and any
// number of `extraSourceDirs` (read-only; bundled examples live here). All
// directories are merged into a single namespace at reload time. A name
// collision between two source directories throws — the operator must rename
// or delete one. No silent shadowing.
//
// `upsert` and `remove` operate on `baseDir` only — bundled examples are
// immutable from the API surface.
//
// The on-disk format is markdown (see docs/scripts.md). Each .md file is
// parsed into a Script via parseScriptMd.
// ============================================================================

import { readdir, readFile, stat, writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Script } from '../types/script.ts'
import { parseScriptMd, VALID_NAME } from './script-md-parser.ts'

// Hard cap on script source size. Scripts are markdown — the largest realistic
// hand-written one is a few KB. 256 KB is well above that and small enough
// that an agent can't DoS the parser/UI by writing a multi-MB file via
// write_script.
export const MAX_SCRIPT_SOURCE_BYTES = 256 * 1024

export interface ScriptStore {
  readonly get: (name: string) => Script | undefined
  readonly list: () => ReadonlyArray<Script>
  readonly reload: () => Promise<ReadonlyArray<string>>
  readonly upsert: (name: string, source: string) => Promise<Script>
  readonly remove: (name: string) => Promise<boolean>
  readonly onChange: (fn: () => void) => () => void
}

export interface ScriptStoreInit {
  readonly baseDir: string
  // Additional read-only source directories merged into the namespace at
  // reload. Bundled examples live here. Collisions across any source
  // directory throw — operator-visible, not silently shadowed.
  readonly extraSourceDirs?: ReadonlyArray<string>
}

export const createScriptStore = (init: ScriptStoreInit): ScriptStore => {
  const { baseDir, extraSourceDirs = [] } = init
  const scripts = new Map<string, Script>()
  const listeners = new Set<() => void>()

  const fireChange = (): void => {
    for (const fn of listeners) {
      try { fn() } catch { /* listener errors must not break the store */ }
    }
  }

  const reload = async (): Promise<ReadonlyArray<string>> => {
    // First-seen wins ONLY if no other directory has the same name. We track
    // (name → source path) so a collision can be reported with both paths.
    const seenAt = new Map<string, string>()
    const merged = new Map<string, Script>()

    const ingest = async (dir: string): Promise<void> => {
      const loaded = await scanScriptDir(dir)
      for (const { script, sourcePath } of loaded) {
        const prior = seenAt.get(script.name)
        if (prior) {
          throw new Error(
            `[scripts] name collision for "${script.name}" between ` +
            `${prior} and ${sourcePath} — rename or delete one of these files.`,
          )
        }
        seenAt.set(script.name, sourcePath)
        merged.set(script.name, script)
      }
    }

    await ingest(baseDir)
    for (const extra of extraSourceDirs) await ingest(extra)

    scripts.clear()
    for (const [name, script] of merged) scripts.set(name, script)
    fireChange()
    return [...scripts.keys()]
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

interface ScanEntry {
  readonly script: Script
  readonly sourcePath: string  // for collision diagnostics
}

const scanScriptDir = async (baseDir: string): Promise<ReadonlyArray<ScanEntry>> => {
  let entries: string[]
  try {
    entries = await readdir(baseDir)
  } catch {
    return []
  }

  const out: ScanEntry[] = []
  for (const entry of entries) {
    const full = join(baseDir, entry)
    let info
    try { info = await stat(full) } catch { continue }

    let name: string
    let raw: string
    let sourcePath: string
    if (info.isDirectory()) {
      if (!VALID_NAME.test(entry)) {
        console.warn(`[scripts] "${entry}": directory name not a valid script name — skipping`)
        continue
      }
      sourcePath = join(full, 'script.md')
      try {
        raw = await readFile(sourcePath, 'utf-8')
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
      sourcePath = full
      try {
        raw = await readFile(sourcePath, 'utf-8')
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
      out.push({ script: parsed, sourcePath })
    } catch (err) {
      console.warn(`[scripts] "${name}" (${sourcePath}): invalid — ${err instanceof Error ? err.message : err}`)
    }
  }

  return out
}
