// ============================================================================
// Shared filesystem scan helper for "directory of markdown documents."
//
// Used by:
//   - src/core/scripts/script-store.ts (scripts/<name>/script.md or <name>.md)
//
// Walk a dir, accept either `<name>/inner.md` or `<name>.md`, validate the
// name regex, read the file, parse, log + skip on errors.
//
// Generic parameter `T` is whatever the consumer's parser produces.
// ============================================================================

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface MarkdownScanResult<T> {
  readonly value: T
  readonly name: string
  readonly sourcePath: string
}

export interface MarkdownScanOptions<T> {
  // Directory to scan. Missing dir resolves to [] (not an error).
  readonly dir: string
  // Inner filename when an entry is a subdirectory (e.g. "script.md").
  readonly innerFilename: string
  // Names must match this regex. Both directory names and flat-file stems
  // are tested; mismatches are skipped with a warning under `logPrefix`.
  readonly validNameRe: RegExp
  // Log tag — e.g. "scripts". Used in console.warn for skip / parse-error
  // diagnostics.
  readonly logPrefix: string
  // Parser. Throw to signal an invalid file (caller logs + skips).
  readonly parse: (name: string, raw: string) => T
  // Optional size cap. Files larger than this are skipped with a warning.
  readonly maxBytes?: number
}

export const scanMarkdownDir = async <T>(
  opts: MarkdownScanOptions<T>,
): Promise<MarkdownScanResult<T>[]> => {
  const { dir, innerFilename, validNameRe, logPrefix, parse, maxBytes } = opts
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }

  const out: MarkdownScanResult<T>[] = []
  for (const entry of entries) {
    const full = join(dir, entry)
    let info
    try { info = await stat(full) } catch { continue }

    let name: string
    let sourcePath: string
    let raw: string
    if (info.isDirectory()) {
      if (!validNameRe.test(entry)) {
        console.warn(`[${logPrefix}] "${entry}": directory name not a valid name — skipping`)
        continue
      }
      sourcePath = join(full, innerFilename)
      try { raw = await readFile(sourcePath, 'utf-8') } catch { continue }
      name = entry
    } else if (info.isFile() && entry.endsWith('.md')) {
      const stem = entry.slice(0, -'.md'.length)
      if (!validNameRe.test(stem)) {
        console.warn(`[${logPrefix}] "${entry}": filename not a valid name — skipping`)
        continue
      }
      sourcePath = full
      try {
        raw = await readFile(sourcePath, 'utf-8')
      } catch (err) {
        console.warn(`[${logPrefix}] "${entry}": read failed — ${err instanceof Error ? err.message : err}`)
        continue
      }
      name = stem
    } else {
      continue
    }

    if (maxBytes !== undefined && raw.length > maxBytes) {
      console.warn(`[${logPrefix}] "${name}" exceeds ${maxBytes}-byte cap — skipping`)
      continue
    }

    try {
      out.push({ value: parse(name, raw), name, sourcePath })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[${logPrefix}] "${name}" (${sourcePath}): invalid — ${msg}`)
    }
  }

  return out
}
