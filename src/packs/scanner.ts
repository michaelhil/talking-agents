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
    // Orphan rollback snapshots from a crashed update_pack. Scanner skips
    // them (they're not packs) but surfaces a warning so the operator can
    // inspect + remove. update_pack also refuses to run when one exists.
    if (entry.endsWith('.prev')) {
      console.warn(`[packs] orphan rollback snapshot: ${join(rootDir, entry)} — a previous update_pack crashed before cleanup. Inspect and remove manually.`)
      continue
    }
    if (entry.startsWith('.') || entry.startsWith('_')) continue
    // 'local' is the synthetic system pack — its directory holds the
    // user's drop-in tools/skills/scripts/geodata, but it's surfaced via
    // the system-pack synthesis in list_packs (kind:'external' / etc.),
    // not as a regular installable. Skip here to avoid duplication.
    if (entry === 'local') continue

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

// Helper for sub-system loaders that want a flat list of pack subdirs of a
// given kind (scripts/, geodata/, wikis/). Returns one entry per existing
// subdir — packs that don't ship that subdir are silently omitted.
export const scanPackSubdirs = async (
  rootDir: string,
  subdir: 'scripts' | 'geodata' | 'wikis',
): Promise<ReadonlyArray<{ readonly pack: string; readonly dir: string }>> => {
  const packs = await scanPacks(rootDir)
  const out: Array<{ pack: string; dir: string }> = []
  for (const p of packs) {
    const candidate = join(p.dirPath, subdir)
    try {
      const s = await stat(candidate)
      if (s.isDirectory()) out.push({ pack: p.namespace, dir: candidate })
    } catch { /* no such subdir — fine, packs choose what to ship */ }
  }
  return out
}
