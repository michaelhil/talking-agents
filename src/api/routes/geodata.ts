// ============================================================================
// Geodata admin routes — list / search / delete features in the user-local
// store. Read-mostly; the only mutation is DELETE for unverified-local
// features. Curated and bundled features cannot be removed via this API
// (the store enforces the rule).
//
// GET    /api/geodata                                 → category counts (bundled + local)
// GET    /api/geodata/:category                       → list features in a category
// GET    /api/geodata/search?q=...&category=...       → resolver cascade lookup
// DELETE /api/geodata/:category/:source/:id           → remove unverified-local
// ============================================================================

import { json, errorResponse } from './helpers.ts'
import type { RouteEntry } from './types.ts'
import { categoryStats, listCategory, removeFeature } from '../../geo/store.ts'
import { bundledStats } from '../../geo/bundled.ts'
import { resolveLocation } from '../../geo/resolver.ts'
import type { GeoCategory, GeoSource } from '../../geo/types.ts'

const CATEGORIES: ReadonlyArray<GeoCategory> = [
  'airport', 'offshore-platform', 'city', 'landmark', 'address', 'other',
]

const isCategory = (s: string): s is GeoCategory =>
  (CATEGORIES as ReadonlyArray<string>).includes(s)

const isSource = (s: string): s is GeoSource =>
  s === 'local' || s === 'bundled' || s === 'nominatim' || s === 'overpass'

export const geodataRoutes: RouteEntry[] = [
  // --- Overview: per-category counts (bundled + local + unverified) ---
  {
    method: 'GET',
    pattern: /^\/api\/geodata$/,
    handler: async () => {
      const rows = await Promise.all(CATEGORIES.map(async (c) => {
        const [local, bundled] = await Promise.all([categoryStats(c), bundledStats(c)])
        return {
          category: c,
          bundled: bundled.count,
          local: local.total,
          verified: local.verified,
          unverified: local.unverified,
        }
      }))
      const versions = await bundledStats('city')   // any category — we only need the version field
      return json({ categories: rows, bundledVersion: versions.version })
    },
  },

  // --- Search: full cascade. Listed BEFORE the per-category pattern so it
  //     wins the dispatcher's first-match-wins lookup. ---
  {
    method: 'GET',
    pattern: /^\/api\/geodata\/search$/,
    handler: async (req) => {
      const url = new URL(req.url)
      const q = url.searchParams.get('q')?.trim()
      const c = url.searchParams.get('category')
      if (!q) return errorResponse('missing q')
      if (!c || !isCategory(c)) return errorResponse('missing or invalid category')
      try {
        const result = await resolveLocation(q, c)
        return json({ result })
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : 'lookup failed', 500)
      }
    },
  },

  // --- List features in a category (local only — bundled is read-only and
  //     usually too large to dump wholesale here; UI fetches by category) ---
  {
    method: 'GET',
    pattern: /^\/api\/geodata\/([a-z-]+)$/,
    handler: async (_req, match) => {
      const c = match[1]!
      if (!isCategory(c)) return errorResponse(`unknown category: ${c}`)
      const features = await listCategory(c)
      return json({ category: c, features })
    },
  },

  // --- Delete: only (source=local, verified=false) features removable. ---
  {
    method: 'DELETE',
    pattern: /^\/api\/geodata\/([a-z-]+)\/([a-z]+)\/([^/]+)$/,
    handler: async (_req, match) => {
      const c = match[1]!
      const src = match[2]!
      const id = decodeURIComponent(match[3]!)
      if (!isCategory(c)) return errorResponse(`unknown category: ${c}`)
      if (!isSource(src)) return errorResponse(`unknown source: ${src}`)
      const features = await listCategory(c)
      const target = features.find((f) => f.properties.id === id && f.properties.source === src)
      if (!target) return errorResponse('not found', 404)
      if (target.properties.verified || src !== 'local') {
        return errorResponse('curated and non-local features cannot be deleted via this endpoint', 403)
      }
      const result = await removeFeature(c, 'local', id)
      return json({ removed: result.removed })
    },
  },
]
