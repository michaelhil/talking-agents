// pack.json parser. Both fields are optional; a missing or malformed file
// yields an empty manifest ({}) rather than an error — the directory name is
// the canonical namespace, so a pack without a manifest is still valid.

import type { PackManifest } from './types.ts'
import { readFile } from 'node:fs/promises'
import { join, basename } from 'node:path'

const MANIFEST_FILENAME = 'pack.json'

export const readManifest = async (dirPath: string): Promise<PackManifest> => {
  const filePath = join(dirPath, MANIFEST_FILENAME)
  let raw: string
  try {
    raw = await readFile(filePath, 'utf-8')
  } catch {
    return {}
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.warn(`[packs] ${filePath}: invalid JSON — ignoring manifest`)
    return {}
  }

  if (!parsed || typeof parsed !== 'object') return {}
  const obj = parsed as Record<string, unknown>

  const out: { name?: string; description?: string } = {}
  if (typeof obj.name === 'string' && obj.name.trim().length > 0) out.name = obj.name.trim()
  if (typeof obj.description === 'string' && obj.description.trim().length > 0) {
    out.description = obj.description.trim()
  }
  return out
}

// Namespace from a directory that already exists on disk. Used by the
// scanner to identify already-installed packs — at that point the install
// step has already chosen the directory name, so basename is authoritative.
export const namespaceFor = (dirPath: string): string => basename(dirPath)

// Pack-tools namespace regex (mirrors VALID_NS in pack-tools.ts to avoid an
// import cycle).
const VALID_NS_RE = /^[a-zA-Z0-9_-]+$/

// Convention: GitHub repos are named `samsinn-pack-<X>` for discoverability
// (so the registry can list them), but the canonical install namespace and
// tool prefix is `<X>`. This helper strips the prefix only.
export const stripPackPrefix = (s: string): string => s.replace(/^samsinn-pack-/, '')

// Resolves the canonical install namespace for a freshly cloned pack:
//   1. pack.json `name`  (if present and valid)
//   2. samsinn-pack-stripped basename of the source dir
// Validates against the namespace regex and returns null if neither yields
// a valid identifier — caller must surface the error to the user instead of
// installing the pack into a malformed directory.
export const resolveInstallNamespace = (
  manifest: PackManifest,
  sourceDir: string,
): string | null => {
  const fromManifest = manifest.name?.trim() ?? ''
  if (fromManifest && VALID_NS_RE.test(fromManifest)) return fromManifest
  const fromBasename = stripPackPrefix(basename(sourceDir))
  if (VALID_NS_RE.test(fromBasename)) return fromBasename
  return null
}
