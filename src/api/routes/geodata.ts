// ============================================================================
// Geodata admin routes — dynamic categories, paste-import, delete cascade.
//
// GET    /api/geodata                                 → registry overview (categories + counts)
// GET    /api/geodata/:category                       → list features in a category
// GET    /api/geodata/search?q=...&category=...       → resolver cascade lookup
// POST   /api/geodata/import                          → paste-object import (validate + apply)
// DELETE /api/geodata/categories/:id                  → delete category (cascades to .geojson)
// DELETE /api/geodata/:category/:source/:id           → remove individual feature (local + unverified only)
//
// All categories are user-defined via the import flow. There is no closed
// allow-list — validation walks the registry at request time.
// ============================================================================

import { json, errorResponse, parseBody } from './helpers.ts'
import type { RouteEntry } from './types.ts'
import { categoryStats, listCategory, removeFeature } from '../../geo/store.ts'
import { deleteCategory, getCategory, listCategories } from '../../geo/categories.ts'
import { resolveLocation } from '../../geo/resolver.ts'
import { applyImport } from '../../geo/import.ts'
import type { GeoSource } from '../../geo/types.ts'

const isSource = (s: string): s is GeoSource =>
  s === 'local' || s === 'nominatim' || s === 'overpass'

export const geodataRoutes: RouteEntry[] = [
  // --- Overview: per-category counts. Categories come from the registry;
  //     the empty-state UI hangs off an empty array here. ---
  {
    method: 'GET',
    pattern: /^\/api\/geodata$/,
    handler: async () => {
      const categories = await listCategories()
      const rows = await Promise.all(categories.map(async (meta) => {
        const stats = await categoryStats(meta.id)
        return {
          id: meta.id,
          displayName: meta.displayName,
          icon: meta.icon,
          osmQuery: meta.osmQuery ?? null,
          total: stats.total,
          verified: stats.verified,
          unverified: stats.unverified,
        }
      }))
      return json({ categories: rows })
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
      if (!c) return errorResponse('missing category')
      if (!await getCategory(c)) return errorResponse(`unknown category: ${c}`, 404)
      try {
        const result = await resolveLocation(q, c)
        return json({ result })
      } catch (err) {
        return errorResponse(err instanceof Error ? err.message : 'lookup failed', 500)
      }
    },
  },

  // --- Import: validate + apply paste object. ---
  {
    method: 'POST',
    pattern: /^\/api\/geodata\/import$/,
    handler: async (req) => {
      const body = await parseBody(req)
      const result = await applyImport(body)
      const status = result.ok ? 200 : 400
      return json(result, status)
    },
  },

  // --- Delete a category (cascades to per-category .geojson). ---
  {
    method: 'DELETE',
    pattern: /^\/api\/geodata\/categories\/([a-z0-9-]+)$/,
    handler: async (_req, match) => {
      const id = match[1]!
      const r = await deleteCategory(id)
      if (!r.deleted) return errorResponse('not found', 404)
      return json(r)
    },
  },

  // --- List features in a category. ---
  {
    method: 'GET',
    pattern: /^\/api\/geodata\/([a-z0-9-]+)$/,
    handler: async (_req, match) => {
      const c = match[1]!
      if (!await getCategory(c)) return errorResponse(`unknown category: ${c}`, 404)
      const features = await listCategory(c)
      return json({ category: c, features })
    },
  },

  // --- Delete an individual feature. Only (source=local, verified=false). ---
  {
    method: 'DELETE',
    pattern: /^\/api\/geodata\/([a-z0-9-]+)\/([a-z]+)\/([^/]+)$/,
    handler: async (_req, match) => {
      const c = match[1]!
      const src = match[2]!
      const id = decodeURIComponent(match[3]!)
      if (!await getCategory(c)) return errorResponse(`unknown category: ${c}`, 404)
      if (!isSource(src)) return errorResponse(`unknown source: ${src}`)
      const features = await listCategory(c)
      const target = features.find((f) => f.properties.id === id && f.properties.source === src)
      if (!target) return errorResponse('not found', 404)
      if (target.properties.verified || src !== 'local') {
        return errorResponse('only local + unverified features can be deleted via this endpoint; use DELETE /api/geodata/categories/:id to remove a whole category', 403)
      }
      const result = await removeFeature(c, 'local', id)
      return json({ removed: result.removed })
    },
  },
]
