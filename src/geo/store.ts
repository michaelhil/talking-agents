// User-local geodata store — one GeoJSON file per category at
// $SAMSINN_HOME/geodata/<category>.geojson.
//
// Concurrency: a single in-process async-mutex map keyed by file path
// serializes writes. We only support a single Samsinn process per
// SAMSINN_HOME (matches the rest of the codebase — snapshots, providers,
// wikis), so cross-process locking is out of scope.
//
// Atomic writes: write to <file>.tmp, fsync via Bun.write, then rename. A
// crash mid-write leaves either the prior content or the new content,
// never a partial file.
//
// Index: every load builds a (canonical(name) → feature) map and an
// (alias → feature) map, both used by the resolver's strict-match check.
// The index is rebuilt on every read; v1 doesn't keep it in memory across
// calls because the file watcher / hot-reload path isn't built yet.
// Callers that need fast repeated lookups should cache the index.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { sharedPaths } from '../core/paths.ts'
import { canonical } from './canonical.ts'
import type { GeoCategory, GeoFeature, GeoFeatureCollection, GeoSource } from './types.ts'

// ============================================================================
// Per-file mutex map. Map<path, Promise<void>> chains async writers.
// ============================================================================

const mutexes: Map<string, Promise<void>> = new Map()

const withFileMutex = async <T>(filePath: string, fn: () => Promise<T>): Promise<T> => {
  const prev = mutexes.get(filePath) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>((resolve) => { release = resolve })
  mutexes.set(filePath, prev.then(() => next))
  await prev
  try {
    return await fn()
  } finally {
    release()
    // Clean up the map entry once we're the tail.
    if (mutexes.get(filePath) === next) mutexes.delete(filePath)
  }
}

// ============================================================================
// File I/O
// ============================================================================

const categoryFilePath = (category: GeoCategory): string =>
  join(sharedPaths.geodata(), `${category}.geojson`)

const ensureDir = async (dir: string): Promise<void> => {
  if (!existsSync(dir)) await mkdir(dir, { recursive: true, mode: 0o700 })
}

const readCategoryFile = async (category: GeoCategory): Promise<GeoFeatureCollection> => {
  const path = categoryFilePath(category)
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

const writeCategoryFile = async (
  category: GeoCategory,
  fc: GeoFeatureCollection,
): Promise<void> => {
  const path = categoryFilePath(category)
  await ensureDir(dirname(path))
  const tmp = `${path}.tmp`
  // Pretty-print for diff-friendliness — files are small (hundreds, not
  // millions of features) and this is user-visible state.
  await writeFile(tmp, `${JSON.stringify(fc, null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, path)
}

// ============================================================================
// Public API
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

// Read all features in a category. Returns an empty index if the file
// doesn't exist.
export const loadCategory = async (category: GeoCategory): Promise<GeoIndex> => {
  const fc = await readCategoryFile(category)
  return buildIndex(fc.features)
}

// Look up a feature by canonical-form name OR alias. Strict match — no fuzzy
// search. Returns null on no match.
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

// Add or overwrite a feature. Dedup key: (category, canonical(name)). If a
// feature with the same canonical name exists, it's replaced. Verified
// curated entries are NOT overwritten by unverified additions — protection
// against the agent silently downgrading curated data.
export const upsertFeature = async (feature: GeoFeature): Promise<{ replaced: boolean }> => {
  const category = feature.properties.category
  const path = categoryFilePath(category)
  return withFileMutex(path, async () => {
    const fc = await readCategoryFile(category)
    const key = canonical(feature.properties.name)
    let replaced = false
    const next: GeoFeature[] = []
    for (const existing of fc.features) {
      if (canonical(existing.properties.name) === key) {
        // Verified-protection: don't let unverified writes clobber curated.
        if (existing.properties.verified && !feature.properties.verified) {
          return { replaced: false }
        }
        replaced = true
        continue
      }
      next.push(existing)
    }
    next.push(feature)
    await writeCategoryFile(category, { type: 'FeatureCollection', features: next })
    return { replaced }
  })
}

// Remove a feature by (source, id). Only removes when the feature exists in
// this category and matches both source and id.
export const removeFeature = async (
  category: GeoCategory,
  source: GeoSource,
  id: string,
): Promise<{ removed: boolean }> => {
  const path = categoryFilePath(category)
  return withFileMutex(path, async () => {
    const fc = await readCategoryFile(category)
    let removed = false
    const next: GeoFeature[] = []
    for (const f of fc.features) {
      if (f.properties.id === id && f.properties.source === source) {
        removed = true
        continue
      }
      next.push(f)
    }
    if (removed) {
      await writeCategoryFile(category, { type: 'FeatureCollection', features: next })
    }
    return { removed }
  })
}

// Counts for the UI panel. Never throws — missing file → zeros.
export const categoryStats = async (category: GeoCategory): Promise<{
  total: number
  verified: number
  unverified: number
}> => {
  try {
    const fc = await readCategoryFile(category)
    let verified = 0
    let unverified = 0
    for (const f of fc.features) {
      if (f.properties.verified) verified++
      else unverified++
    }
    return { total: fc.features.length, verified, unverified }
  } catch {
    return { total: 0, verified: 0, unverified: 0 }
  }
}

// Used by tests + the panel's "list all" view. Returns features in stored
// order — no implicit sorting.
export const listCategory = async (category: GeoCategory): Promise<ReadonlyArray<GeoFeature>> => {
  const fc = await readCategoryFile(category)
  return fc.features
}
