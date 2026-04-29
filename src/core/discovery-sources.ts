// ============================================================================
// Discovery sources — file-backed registry of GitHub <owner> / <owner>/<repo>
// strings that pack and wiki discovery scan. Replaces env-only config so users
// can add sources from the UI without editing SAMSINN_PACK_SOURCES /
// SAMSINN_WIKI_SOURCES env vars.
//
// Stored at $SAMSINN_HOME/discovery-sources.json. Env vars still win on merge:
// operators with strict env-driven deploys keep that behavior, while
// single-tenant users get a real UI path.
//
// Single store for both domains (packs + wikis) so the admin surface is one
// endpoint instead of two near-identical ones.
// ============================================================================

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export const STORE_VERSION = 1

export interface DiscoverySourcesFileShape {
  readonly version: number
  readonly packs: ReadonlyArray<string>
  readonly wikis: ReadonlyArray<string>
}

const EMPTY: DiscoverySourcesFileShape = { version: STORE_VERSION, packs: [], wikis: [] }

const validateList = (raw: unknown): ReadonlyArray<string> => {
  if (!Array.isArray(raw)) return []
  return (raw as unknown[])
    .filter((v): v is string => typeof v === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export const loadDiscoverySources = async (path: string): Promise<DiscoverySourcesFileShape> => {
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY
    return EMPTY
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return EMPTY }
  const obj = parsed as Record<string, unknown>
  return {
    version: STORE_VERSION,
    packs: validateList(obj.packs),
    wikis: validateList(obj.wikis),
  }
}

export const saveDiscoverySources = async (
  path: string,
  data: DiscoverySourcesFileShape,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  const tmpPath = `${path}.tmp`
  await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
  await rename(tmpPath, path)
}

// Merge env + stored + canonical fallback. Order: env (deploy-time, wins),
// then stored (UI-managed), then fallback (canonical org always scanned).
//
// Earlier semantics dropped the fallback whenever env or stored had ANY entry.
// That broke the user-facing claim that `samsinn-packs` / `samsinn-wikis` are
// "scanned by default" — adding a custom org silently disabled the canonical.
// The new contract: canonical is always included (deduped), so additional
// sources are genuinely additional, not a replacement.
export const mergeSources = (
  envRaw: string | undefined,
  stored: ReadonlyArray<string>,
  fallback: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const envList = (envRaw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of [...envList, ...stored, ...fallback]) {
    if (seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}
