// Bundled-dataset fetcher — pulls the pinned snapshot from the
// samsinn-geodata GitHub org via jsdelivr, caches to disk, indexes for
// strict-match lookup.
//
// URL shape:
//   https://cdn.jsdelivr.net/gh/samsinn-geodata/data@<version>/<file>
//
// Versioning: `geodataVersion` in package.json is the single source of
// truth. Bumping it invalidates the cache (different cache dir).
//
// Failure policy: any network or parse error → empty index, log once,
// resolver falls through to upstream sources. The app stays functional.
//
// "0.0.0" is the unset sentinel: when geodataVersion is "0.0.0" we treat
// bundled as empty without ever calling jsdelivr. This is the default
// state until the samsinn-geodata repo ships its first tagged release.

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { sharedPaths } from '../core/paths.ts'
import { canonical } from './canonical.ts'
import type { GeoCategory, GeoFeature, GeoFeatureCollection, GeoIndex as GeoIndexFile } from './types.ts'

const JSDELIVR_BASE = 'https://cdn.jsdelivr.net/gh/samsinn-geodata/data'
const FETCH_TIMEOUT_MS = 10_000

interface BundledIndexEntry {
  readonly category: GeoCategory
  readonly file: string
  readonly count: number
}

interface BundledCache {
  readonly version: string
  readonly indexEntries: ReadonlyArray<BundledIndexEntry>
  readonly byCategory: Map<GeoCategory, ReadonlyArray<GeoFeature>>
}

let cached: BundledCache | null = null
let loadInFlight: Promise<BundledCache> | null = null

const readPackageGeodataVersion = async (): Promise<string> => {
  // Env override exists for tests + emergency pin overrides without a redeploy.
  const envOverride = process.env.SAMSINN_GEODATA_VERSION
  if (envOverride && envOverride.length > 0) return envOverride
  try {
    // package.json sits at repo root — same lookup pattern as bootstrap.ts.
    const path = join(process.cwd(), 'package.json')
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as { geodataVersion?: string }
    return parsed.geodataVersion ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const fetchWithTimeout = async (url: string): Promise<Response> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'samsinn/geo-bundled' },
    })
  } finally {
    clearTimeout(timer)
  }
}

const cacheDir = (version: string): string =>
  join(sharedPaths.geodataBundleCache(), version)

const cachedFilePath = (version: string, filename: string): string =>
  join(cacheDir(version), filename)

const fetchAndCache = async (
  version: string,
  remotePath: string,
): Promise<string> => {
  // Strip any leading "./" so the URL stays clean.
  const clean = remotePath.replace(/^\.?\//, '')
  const local = cachedFilePath(version, clean)
  if (existsSync(local)) {
    return await readFile(local, 'utf8')
  }
  const url = `${JSDELIVR_BASE}@${version}/${clean}`
  const res = await fetchWithTimeout(url)
  if (!res.ok) throw new Error(`bundled fetch failed: ${url} → HTTP ${res.status}`)
  const text = await res.text()
  // Create the parent directory of the *target file*, not just the cache root.
  // For nested paths like airports/world.geojson, this is cache/<version>/airports/.
  await mkdir(dirname(local), { recursive: true, mode: 0o700 })
  // jsdelivr serves immutable @<tag> URLs; once cached, no need to revalidate.
  await writeFile(local, text, { mode: 0o600 })
  return text
}

const loadBundledOnce = async (): Promise<BundledCache> => {
  const version = await readPackageGeodataVersion()
  if (version === '0.0.0') {
    return { version, indexEntries: [], byCategory: new Map() }
  }
  try {
    const indexRaw = await fetchAndCache(version, 'index.json')
    const indexFile = JSON.parse(indexRaw) as GeoIndexFile
    if (!Array.isArray(indexFile.categories)) {
      throw new Error('bundled index.json missing categories array')
    }
    const byCategory = new Map<GeoCategory, ReadonlyArray<GeoFeature>>()
    for (const entry of indexFile.categories) {
      const fcRaw = await fetchAndCache(version, entry.file)
      const fc = JSON.parse(fcRaw) as GeoFeatureCollection
      byCategory.set(entry.category, fc.features)
    }
    return { version, indexEntries: indexFile.categories, byCategory }
  } catch (err) {
    console.warn('[geo/bundled] load failed; treating as empty:', err instanceof Error ? err.message : err)
    return { version, indexEntries: [], byCategory: new Map() }
  }
}

const loadBundled = async (): Promise<BundledCache> => {
  if (cached) return cached
  if (loadInFlight) return loadInFlight
  loadInFlight = loadBundledOnce().then((c) => {
    cached = c
    loadInFlight = null
    return c
  })
  return loadInFlight
}

// ============================================================================
// Public API — strict-match lookup against the bundled snapshot.
// ============================================================================

export const lookupBundled = async (
  category: GeoCategory,
  query: string,
): Promise<GeoFeature | null> => {
  const bundle = await loadBundled()
  const features = bundle.byCategory.get(category)
  if (!features || features.length === 0) return null
  const key = canonical(query)
  for (const f of features) {
    if (canonical(f.properties.name) === key) return f
    if (f.properties.aliases) {
      for (const a of f.properties.aliases) {
        if (canonical(a) === key) return f
      }
    }
  }
  return null
}

export const bundledStats = async (
  category: GeoCategory,
): Promise<{ count: number; version: string }> => {
  const bundle = await loadBundled()
  const features = bundle.byCategory.get(category)
  return { count: features?.length ?? 0, version: bundle.version }
}

// Test-only — flush in-memory state so tests can re-mock.
export const __resetBundledCache = (): void => {
  cached = null
  loadInFlight = null
}
