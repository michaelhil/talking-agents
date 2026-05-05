// ============================================================================
// User-local geodata store — one file at $SAMSINN_HOME/geodata/geodata.geojson.
//
// Layout: a single GeoJSON FeatureCollection covering ALL categories. Each
// feature carries `properties.category` (id). Categories are derived from
// features via projection.ts; there is no separate registry file.
//
// Concurrency: one process-wide async-mutex on the file path. Single
// process per SAMSINN_HOME (matches snapshots / providers / wikis).
//
// Atomic writes: write to <file>.tmp, then rename. A crash mid-write
// leaves either the prior content or the new content — never partial.
// ============================================================================

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { sharedPaths } from '../core/paths.ts'
import { canonical } from './canonical.ts'
import { getDiscoveredFeatures } from './discovered-cache.ts'
import { getPackFeatures, getAllPackFeatures } from './pack-source.ts'
import { extractCategoryMetaFromFeatures } from './projection.ts'
import type { CategoryMeta, GeoCategory, GeoFeature, GeoFeatureCollection, GeoSource } from './types.ts'

// ============================================================================
// File path + mutex
// ============================================================================

const filePath = (): string => join(sharedPaths.geodata(), 'geodata.geojson')

let mutex: Promise<void> = Promise.resolve()

const withMutex = async <T>(fn: () => Promise<T>): Promise<T> => {
  const prev = mutex
  let release!: () => void
  const next = new Promise<void>((resolve) => { release = resolve })
  mutex = prev.then(() => next)
  await prev
  try {
    return await fn()
  } finally {
    release()
  }
}

// ============================================================================
// File I/O
// ============================================================================

const ensureDir = async (dir: string): Promise<void> => {
  if (!existsSync(dir)) await mkdir(dir, { recursive: true, mode: 0o700 })
}

const readFile_ = async (): Promise<GeoFeatureCollection> => {
  const path = filePath()
  if (!existsSync(path)) {
    return { type: 'FeatureCollection', features: [] }
  }
  const raw = await readFile(path, 'utf8')
  const parsed = JSON.parse(raw) as GeoFeatureCollection
  if (parsed.type !== 'FeatureCollection' || !Array.isArray(parsed.features)) {
    throw new Error(`malformed geodata file: ${path}`)
  }
  return parsed
}

const writeFile_ = async (fc: GeoFeatureCollection): Promise<void> => {
  const path = filePath()
  await ensureDir(dirname(path))
  const tmp = `${path}.tmp`
  // Pretty-print for diff-friendliness.
  await writeFile(tmp, `${JSON.stringify(fc, null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, path)
}

// ============================================================================
// Index
// ============================================================================

export interface GeoIndex {
  readonly byCanonicalName: ReadonlyMap<string, GeoFeature>
  readonly byAlias: ReadonlyMap<string, GeoFeature>
  readonly byId: ReadonlyMap<string, GeoFeature>
  readonly all: ReadonlyArray<GeoFeature>
}

const buildIndex = (features: ReadonlyArray<GeoFeature>): GeoIndex => {
  const byCanonicalName = new Map<string, GeoFeature>()
  const byAlias = new Map<string, GeoFeature>()
  const byId = new Map<string, GeoFeature>()
  for (const f of features) {
    const p = f.properties
    byId.set(p.id, f)
    byCanonicalName.set(canonical(p.name), f)
    if (p.aliases) {
      for (const a of p.aliases) byAlias.set(canonical(a), f)
    }
  }
  return { byCanonicalName, byAlias, byId, all: features }
}

// ============================================================================
// Merge — local + pack + discovered. Collision wins by precedence:
//   discovered > pack > local
// (discovered/curated wins over pack-bundled, both win over local user-paste).
// Each layer keeps its `properties.source` so callers can attribute. The
// `pack` field is preserved so the room-aware filter can gate by activation.
// ============================================================================

const mergeFeatures = (
  local: ReadonlyArray<GeoFeature>,
  pack: ReadonlyArray<GeoFeature>,
  discovered: ReadonlyArray<GeoFeature>,
): ReadonlyArray<GeoFeature> => {
  const byKey = new Map<string, GeoFeature>()
  // Insertion order = precedence: later layers overwrite earlier ones on
  // (category, canonical name) collision. local → pack → discovered.
  for (const f of local) byKey.set(`${f.properties.category}:${canonical(f.properties.name)}`, f)
  for (const f of pack) byKey.set(`${f.properties.category}:${canonical(f.properties.name)}`, f)
  for (const f of discovered) byKey.set(`${f.properties.category}:${canonical(f.properties.name)}`, f)
  return [...byKey.values()]
}

// ============================================================================
// Public API — feature reads
// ============================================================================

// All features (local + pack + discovered, merged) in a category. Does NOT
// filter by room.activePacks — that gate lives in the room-aware variant
// `listCategoryForRoom`. The unfiltered form is still useful for admin
// surfaces (categoryStats, removeCategory, etc.) that want the global view.
export const listCategory = async (category: GeoCategory): Promise<ReadonlyArray<GeoFeature>> => {
  let local: ReadonlyArray<GeoFeature> = []
  try {
    const fc = await readFile_()
    local = fc.features.filter((f) => f.properties.category === category)
  } catch {
    // Missing or corrupt file — fall through to discovered-only.
  }
  const pack = getPackFeatures(category)
  const discovered = await getDiscoveredFeatures(category)
  return mergeFeatures(local, pack, discovered)
}

// Room-aware variant: filters pack-sourced features by `activePacks`.
// Non-pack features (local / discovered) are always included since they
// don't have a pack origin to gate on. Use this from the agent surface
// (geo_lookup, etc.) so an agent in a room with `aviation` deactivated
// doesn't see aviation's airports.
export const listCategoryForRoom = async (
  category: GeoCategory,
  activePacks: ReadonlySet<string>,
): Promise<ReadonlyArray<GeoFeature>> => {
  const all = await listCategory(category)
  return all.filter(f => {
    if (f.properties.source !== 'pack') return true
    const ns = f.properties.pack
    return !!ns && activePacks.has(ns)
  })
}

// Indexed view of a category's merged features. Used by lookupInCategory.
export const loadCategory = async (category: GeoCategory): Promise<GeoIndex> => {
  const merged = await listCategory(category)
  return buildIndex(merged)
}

// All features across all categories — used by the registry projection.
export const listAllFeatures = async (): Promise<ReadonlyArray<GeoFeature>> => {
  let local: ReadonlyArray<GeoFeature> = []
  try {
    const fc = await readFile_()
    local = fc.features
  } catch {
    // ignore
  }
  // Discovered features for categories the local file doesn't know about
  // still need to be visible. Fetch all known category ids from local +
  // discovered registry projection and merge each category individually.
  // To avoid a circular import, we project from the in-memory cache state
  // via getAllDiscoveredFeatures.
  const { getAllDiscoveredFeatures } = await import('./discovered-cache.ts')
  const discovered = await getAllDiscoveredFeatures()
  const pack = getAllPackFeatures()
  // Merge per-category to keep collision semantics consistent.
  const byCategory = new Map<string, { local: GeoFeature[]; pack: GeoFeature[]; discovered: GeoFeature[] }>()
  const slot = (cat: string) => {
    let s = byCategory.get(cat)
    if (!s) { s = { local: [], pack: [], discovered: [] }; byCategory.set(cat, s) }
    return s
  }
  for (const f of local)      slot(f.properties.category).local.push(f)
  for (const f of pack)       slot(f.properties.category).pack.push(f)
  for (const f of discovered) slot(f.properties.category).discovered.push(f)
  const out: GeoFeature[] = []
  for (const { local: l, pack: p, discovered: d } of byCategory.values()) {
    out.push(...mergeFeatures(l, p, d))
  }
  return out
}

// Look up a feature by canonical-form name OR alias within a category.
// Strict match. Returns null on no match.
export const lookupInCategory = async (
  category: GeoCategory,
  query: string,
  opts?: { readonly includeUnverified?: boolean },
): Promise<GeoFeature | null> => {
  const index = await loadCategory(category)
  const key = canonical(query)
  const hit = index.byCanonicalName.get(key) ?? index.byAlias.get(key) ?? null
  if (!hit) return null
  if (!opts?.includeUnverified && !hit.properties.verified) return null
  return hit
}

// ============================================================================
// Public API — category projection
// ============================================================================

// Derived registry: walk all features, project per-category metadata.
export const listCategories = async (): Promise<ReadonlyArray<CategoryMeta>> => {
  const features = await listAllFeatures()
  const map = extractCategoryMetaFromFeatures(features)
  return [...map.values()]
}

export const getCategory = async (id: string): Promise<CategoryMeta | null> => {
  const features = await listCategory(id)
  if (features.length === 0) return null
  const map = extractCategoryMetaFromFeatures(features)
  return map.get(id) ?? null
}

// Counts surface for the UI panel + geo_list_categories tool. Includes
// local + discovered breakdown.
export const categoryStats = async (category: GeoCategory): Promise<{
  total: number
  verified: number
  unverified: number
  local: number
  discovered: number
}> => {
  const merged = await listCategory(category)
  let verified = 0, unverified = 0, local = 0, discovered = 0
  for (const f of merged) {
    if (f.properties.verified) verified++
    else unverified++
    if (f.properties.source === 'discovered') discovered++
    else if (f.properties.source === 'local') local++
  }
  return { total: merged.length, verified, unverified, local, discovered }
}

// ============================================================================
// Public API — feature mutations (local-only)
// ============================================================================

// Add or overwrite a feature. Dedup key: (category, canonical(name)). If a
// feature with the same key exists locally, it is replaced. Verified-
// protection: an existing verified local entry is NOT overwritten by an
// unverified write. Discovered entries cannot be modified through this
// path; the caller can still add a local feature with the same name (it
// stays local until merge precedence kicks in at read time).
export const upsertFeature = async (feature: GeoFeature): Promise<{ replaced: boolean }> => {
  return withMutex(async () => {
    let fc: GeoFeatureCollection
    try {
      fc = await readFile_()
    } catch {
      fc = { type: 'FeatureCollection', features: [] }
    }
    const key = canonical(feature.properties.name)
    const cat = feature.properties.category
    let replaced = false
    const next: GeoFeature[] = []
    for (const existing of fc.features) {
      if (existing.properties.category === cat && canonical(existing.properties.name) === key) {
        if (existing.properties.verified && !feature.properties.verified) {
          // Verified-protection: keep curated.
          return { replaced: false }
        }
        replaced = true
        continue
      }
      next.push(existing)
    }
    next.push(feature)
    await writeFile_({ type: 'FeatureCollection', features: next })
    return { replaced }
  })
}

// Remove a feature by (category, source, id). Only touches the local file —
// discovered features are read-only at runtime.
export const removeFeature = async (
  category: GeoCategory,
  source: GeoSource,
  id: string,
): Promise<{ removed: boolean }> => {
  return withMutex(async () => {
    let fc: GeoFeatureCollection
    try {
      fc = await readFile_()
    } catch {
      return { removed: false }
    }
    let removed = false
    const next: GeoFeature[] = []
    for (const f of fc.features) {
      if (
        f.properties.category === category &&
        f.properties.id === id &&
        f.properties.source === source
      ) {
        removed = true
        continue
      }
      next.push(f)
    }
    if (removed) {
      await writeFile_({ type: 'FeatureCollection', features: next })
    }
    return { removed }
  })
}

// Cascade-delete: remove every local feature for a category. Discovered
// features for the same category are unaffected (read-only).
export const removeCategory = async (category: GeoCategory): Promise<{ removed: number }> => {
  return withMutex(async () => {
    let fc: GeoFeatureCollection
    try {
      fc = await readFile_()
    } catch {
      return { removed: 0 }
    }
    let removed = 0
    const next: GeoFeature[] = []
    for (const f of fc.features) {
      if (f.properties.category === category) {
        removed++
        continue
      }
      next.push(f)
    }
    if (removed > 0) {
      await writeFile_({ type: 'FeatureCollection', features: next })
    }
    return { removed }
  })
}

// Test-only — clear the in-memory mutex chain.
export const __resetGeoStoreState = (): void => {
  mutex = Promise.resolve()
}
