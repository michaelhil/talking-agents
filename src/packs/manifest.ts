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

// Namespace is always the directory basename — authoritative, independent of
// any `name` in pack.json (which is display-only). Same convention as node_modules.
export const namespaceFor = (dirPath: string): string => basename(dirPath)
