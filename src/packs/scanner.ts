// Scanner — list every installed pack under a root directory. Each immediate
// subdirectory is treated as a pack; hidden and underscore-prefixed names are
// skipped (matches skill-loader convention). Missing root resolves to [].

import type { Pack } from './types.ts'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readManifest, namespaceFor } from './manifest.ts'

// Pack namespace must satisfy the tool-name regex so it can be used as a
// prefix: `<ns>_<tool>` must remain a valid tool identifier.
const VALID_NAMESPACE = /^[a-zA-Z0-9_-]+$/

export const scanPacks = async (rootDir: string): Promise<ReadonlyArray<Pack>> => {
  try {
    const s = await stat(rootDir)
    if (!s.isDirectory()) return []
  } catch {
    return []
  }

  const entries = await readdir(rootDir)
  const packs: Pack[] = []

  for (const entry of entries) {
    if (entry.startsWith('.') || entry.startsWith('_')) continue

    const dirPath = join(rootDir, entry)
    try {
      const s = await stat(dirPath)
      if (!s.isDirectory()) continue
    } catch { continue }

    const namespace = namespaceFor(dirPath)
    if (!VALID_NAMESPACE.test(namespace)) {
      console.warn(`[packs] ${namespace}: directory name is not a valid namespace — skipping`)
      continue
    }

    const manifest = await readManifest(dirPath)
    packs.push({ namespace, dirPath, manifest })
  }

  return packs
}
