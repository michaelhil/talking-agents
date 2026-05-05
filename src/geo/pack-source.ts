// ============================================================================
// Pack-bundled geodata loader.
//
// Each installed pack may ship `<pack>/geodata/*.geojson` — one or more
// GeoJSON FeatureCollections. Files are loaded at boot and (re-)scanned
// whenever the install/update/uninstall cycle calls `reload`. Features get
// tagged with `properties.source = 'pack'` and `properties.pack = <ns>`
// so the room-aware filter (effectiveActivePacks ⊕ implicit core+local)
// can gate them per room.
//
// This is the local-disk parallel of discovered-cache.ts (which fetches
// from the samsinn-geodata GitHub org). Once samsinn-geodata is folded
// into samsinn-packs proper, the discovered-cache layer can be deleted
// and packs become the only distribution mechanism for non-user geodata.
// ============================================================================

import { readdir, readFile } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { scanPackSubdirs } from '../packs/scanner.ts'
import { extractCategoryMetaFromFeatures, validateEmbeddedCategoryMeta } from './projection.ts'
import type { CategoryMeta, GeoFeature } from './types.ts'

// File-size cap mirrors discovered-cache: 5 MB is generous for hand-
// curated category files and small enough that a malformed/abusive pack
// can't OOM the loader.
const MAX_FILE_BYTES = 5 * 1024 * 1024

// Same shape discovered-cache uses — featuresByCategory + categoriesById +
// per-source counts + errors. Lets the rest of the geo subsystem treat
// pack-loaded data identically to discovered.
export interface PackGeoState {
  readonly featuresByCategory: ReadonlyMap<string, ReadonlyArray<GeoFeature>>
  readonly categoriesById: ReadonlyMap<string, CategoryMeta>
  readonly perPackFeatureCounts: ReadonlyMap<string, number>
  readonly errors: ReadonlyArray<{ pack: string; file: string; reason: string }>
}

const EMPTY_STATE: PackGeoState = {
  featuresByCategory: new Map(),
  categoriesById: new Map(),
  perPackFeatureCounts: new Map(),
  errors: [],
}

let state: PackGeoState = EMPTY_STATE
let inFlight: Promise<PackGeoState> | null = null

const isValidGeoFeature = (raw: unknown): boolean => {
  if (!raw || typeof raw !== 'object') return false
  const f = raw as Record<string, unknown>
  if (f.type !== 'Feature') return false
  const g = f.geometry as Record<string, unknown> | undefined
  if (!g || g.type !== 'Point' || !Array.isArray(g.coordinates) || g.coordinates.length !== 2) return false
  const [lng, lat] = g.coordinates as ReadonlyArray<unknown>
  if (typeof lng !== 'number' || typeof lat !== 'number') return false
  const p = f.properties as Record<string, unknown> | undefined
  if (!p) return false
  if (typeof p.id !== 'string' || !p.id) return false
  if (typeof p.name !== 'string' || !p.name) return false
  if (typeof p.category !== 'string' || !p.category) return false
  return true
}

// Parse a single .geojson file from a pack. Returns parsed features tagged
// with source/pack, plus per-file errors. Malformed files are skipped
// with a logged reason; one bad file doesn't break the rest of the pack.
const parsePackFile = (
  raw: string,
  packNamespace: string,
  filePath: string,
): { features: GeoFeature[]; errors: string[] } => {
  const errors: string[] = []
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch (err) {
    errors.push(`parse failed: ${err instanceof Error ? err.message : String(err)}`)
    return { features: [], errors }
  }
  if (!parsed || typeof parsed !== 'object') {
    errors.push('not an object')
    return { features: [], errors }
  }
  const fc = parsed as { type?: unknown; features?: unknown }
  if (fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    errors.push('not a FeatureCollection')
    return { features: [], errors }
  }

  const out: GeoFeature[] = []
  let skippedNoId = 0
  for (const r of fc.features) {
    if (!isValidGeoFeature(r)) {
      const p = (r as { properties?: { id?: unknown } } | undefined)?.properties
      if (p && typeof p.id !== 'string') skippedNoId++
      continue
    }
    const f = r as GeoFeature

    // Strip out malformed embedded category metadata, keep the feature.
    // Same policy as discovered-cache — bad metadata shouldn't drop the
    // feature itself.
    const metaErr = validateEmbeddedCategoryMeta({
      category: f.properties.category,
      category_display: f.properties.category_display,
      category_icon: f.properties.category_icon,
      category_osm_query: f.properties.category_osm_query,
    })
    let cleanedProps = f.properties
    if (metaErr) {
      const { category_display: _d, category_icon: _i, category_osm_query: _q, ...rest } = f.properties
      cleanedProps = rest as typeof f.properties
      errors.push(`${filePath}: dropped category metadata (${metaErr})`)
    }

    // Force source='pack' + pack=<ns>. Pack repos may set source='discovered'
    // by mistake (copy-paste from samsinn-geodata) — we override to keep
    // attribution honest.
    out.push({
      ...f,
      properties: {
        ...cleanedProps,
        source: 'pack',
        pack: packNamespace,
        // Pack-bundled features are curated by the pack author. Treat as
        // verified by default: discovered features default to false
        // (crowd-sourced, unvetted); pack features get author-vouched true.
        // Load-bearing — store.lookup at src/geo/store.ts:202 hides
        // unverified features unless `includeUnverified` is passed.
        verified: cleanedProps.verified ?? true,
      },
    })
  }
  if (skippedNoId > 0) errors.push(`${filePath}: ${skippedNoId} features skipped (missing properties.id)`)
  return { features: out, errors }
}

// Scan + load every pack's geodata/ subdir under packsDir. Idempotent —
// safe to call on every reload (install_pack / uninstall_pack flows).
// Returns the new state; callers replace the module-level `state` atomically.
const reload = async (packsDir: string): Promise<PackGeoState> => {
  const subdirs = await scanPackSubdirs(packsDir, 'geodata')
  const featuresByCategory = new Map<string, GeoFeature[]>()
  const perPackFeatureCounts = new Map<string, number>()
  const errors: { pack: string; file: string; reason: string }[] = []
  const allFeatures: GeoFeature[] = []

  for (const { pack, dir } of subdirs) {
    let entries: string[] = []
    try {
      entries = await readdir(dir)
    } catch (err) {
      errors.push({ pack, file: '', reason: `readdir: ${err instanceof Error ? err.message : String(err)}` })
      continue
    }
    for (const entry of entries) {
      if (!entry.endsWith('.geojson')) continue
      const full = join(dir, entry)
      let raw: string
      try {
        const buf = await readFile(full)
        if (buf.byteLength > MAX_FILE_BYTES) {
          errors.push({ pack, file: entry, reason: `exceeds ${MAX_FILE_BYTES}-byte cap (${buf.byteLength})` })
          continue
        }
        raw = buf.toString('utf-8')
      } catch (err) {
        errors.push({ pack, file: entry, reason: err instanceof Error ? err.message : String(err) })
        continue
      }
      const { features, errors: fileErrors } = parsePackFile(raw, pack, basename(full))
      for (const e of fileErrors) errors.push({ pack, file: entry, reason: e })
      perPackFeatureCounts.set(pack, (perPackFeatureCounts.get(pack) ?? 0) + features.length)
      allFeatures.push(...features)
      for (const f of features) {
        const list = featuresByCategory.get(f.properties.category) ?? []
        list.push(f)
        featuresByCategory.set(f.properties.category, list)
      }
    }
  }

  // Derive category metadata the same way discovered-cache does — first
  // feature wins per category for display name / icon / OSM query.
  const categoriesById = extractCategoryMetaFromFeatures(allFeatures)

  return { featuresByCategory, categoriesById, perPackFeatureCounts, errors }
}

// Public surface — mirrors discovered-cache shape so consumers can switch
// between sources cleanly.

export const refreshPackGeodata = async (packsDir: string): Promise<PackGeoState> => {
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      state = await reload(packsDir)
      return state
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

export const getPackFeatures = (categoryId: string): ReadonlyArray<GeoFeature> =>
  state.featuresByCategory.get(categoryId) ?? []

export const getAllPackFeatures = (): ReadonlyArray<GeoFeature> => {
  const out: GeoFeature[] = []
  for (const list of state.featuresByCategory.values()) out.push(...list)
  return out
}

export const getPackCategories = (): ReadonlyMap<string, CategoryMeta> => state.categoriesById

export const getPackGeoState = (): PackGeoState => state

// Test seam — clears the cached state so the next refresh runs fresh.
export const __resetPackGeodataCache = (): void => {
  state = EMPTY_STATE
  inFlight = null
}
