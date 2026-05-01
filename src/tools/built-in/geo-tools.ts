// ============================================================================
// Geo tools — geo_lookup, geo_add, geo_remove, geo_list_categories
//
// All operate over the geodata layer (src/geo/). Categories are user-defined
// via the paste-import flow — agents may NOT silently create categories.
// Unknown-category calls hard-refuse with a clear error pointing at the
// Settings → Geodata → Import flow.
//
// Returns are shaped to drop into either the inline ```map fence or
// add_artifact/update_artifact:
//   data: { features: [...envelope-feature], view?: {...}, source }
//
// Safety rails:
//   - geo_lookup may write upstream cascade hits to the local store as
//     verified:false; never overwrites curated entries.
//   - geo_add always writes verified:false, source:'local', added_by:'agent'.
//   - geo_remove only removes (source:'local', verified:false) entries.
//     Curated features and category metadata are immutable from the agent
//     surface — those live behind the user UI.
// ============================================================================

import { resolveLocation } from '../../geo/resolver.ts'
import { categoryStats, lookupInCategory, removeFeature, upsertFeature } from '../../geo/store.ts'
import { getCategory, listCategories } from '../../geo/categories.ts'
import type { GeoFeature, GeoSource, MapEnvelopeFromGeo, MarkerIcon } from '../../geo/types.ts'
import type { Tool } from '../../core/types/tool.ts'

const featureToEnvelope = (f: GeoFeature, icon: MarkerIcon | undefined): MapEnvelopeFromGeo['features'][number] => {
  const [lng, lat] = f.geometry.coordinates
  return {
    type: 'marker',
    lat,
    lng,
    label: f.properties.name,
    ...(icon ? { icon } : {}),
  }
}

const buildEnvelope = (features: ReadonlyArray<GeoFeature>, icon: MarkerIcon | undefined): MapEnvelopeFromGeo => {
  if (features.length === 0) return { features: [] }
  if (features.length === 1) {
    const [lng, lat] = features[0]!.geometry.coordinates
    return {
      view: { center: [lat, lng], zoom: 9 },
      features: features.map((f) => featureToEnvelope(f, icon)),
    }
  }
  return { features: features.map((f) => featureToEnvelope(f, icon)) }
}

const unknownCategoryError = (id: string): { success: false; error: string } => ({
  success: false,
  error: `category '${id}' is not registered. The user must import it first via Settings → Geodata → Import (paste-flow).`,
})

// ============================================================================
// geo_lookup
// ============================================================================

export const createGeoLookupTool = (): Tool => ({
  name: 'geo_lookup',
  description: 'Resolves a place name to coordinates via the cascade: local store → Overpass (OSM) → Nominatim (OSM). Returns map-envelope features ready to drop into a ```map fenced block or an add_artifact/update_artifact body. Categories are user-defined — call geo_list_categories first to discover what is available.',
  usage: 'Use this BEFORE writing any lat/lng yourself. Strict-match — pass an exact name or alias. The result `data` field is already in envelope shape. If category is unknown, the call returns an error; ask the user to import the category first.',
  returns: '{ features: [{type:"marker", lat, lng, label, icon}], view?: {center,zoom}, source: "local"|"overpass"|"nominatim" }, or { features: [] } when nothing matched.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Place name, alias, or address.' },
      category: { type: 'string', description: 'A registered category id. List via geo_list_categories.' },
    },
    required: ['query', 'category'],
  },
  execute: async (params: Record<string, unknown>) => {
    const query = params.query
    const category = params.category
    if (typeof query !== 'string' || !query.trim()) {
      return { success: false, error: 'query is required' }
    }
    if (typeof category !== 'string' || !category) {
      return { success: false, error: 'category is required' }
    }
    const meta = await getCategory(category)
    if (!meta) return unknownCategoryError(category)
    try {
      const result = await resolveLocation(query, category)
      if (!result) {
        return { success: true, data: { features: [], source: null } }
      }
      const env = buildEnvelope(result.features, meta.icon)
      return { success: true, data: { ...env, source: result.source } }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
})

// ============================================================================
// geo_add
// ============================================================================

export const createGeoAddTool = (): Tool => ({
  name: 'geo_add',
  description: 'Adds a feature to the user-local geodata store under an existing category. Always written as verified:false (unverified). Curated (verified:true) features with the same canonical name are NOT overwritten.',
  usage: 'Use after a successful web_search or domain-knowledge claim to persist a place the cascade did not find. The category MUST already exist (call geo_list_categories). To create a new category, ask the user to use Settings → Geodata → Import.',
  returns: '{ added: boolean, replaced: boolean, id: string }. added=false when a curated entry blocked the write.',
  parameters: {
    type: 'object',
    properties: {
      name:     { type: 'string',  description: 'Display name.' },
      lat:      { type: 'number',  description: 'Latitude (decimal degrees).' },
      lng:      { type: 'number',  description: 'Longitude (decimal degrees).' },
      category: { type: 'string',  description: 'Existing category id (call geo_list_categories).' },
      aliases:  { type: 'array',   description: 'Alternate display names / codes.', items: { type: 'string' } },
      country:  { type: 'string',  description: 'ISO-3166-1 alpha-2 country code (optional).' },
      operator: { type: 'string',  description: 'Operating organisation (optional).' },
      iata:     { type: 'string',  description: 'IATA code (optional, airports).' },
      icao:     { type: 'string',  description: 'ICAO code (optional, airports).' },
      tags:     { type: 'array',   description: 'Free-form tags.', items: { type: 'string' } },
    },
    required: ['name', 'lat', 'lng', 'category'],
  },
  execute: async (params: Record<string, unknown>) => {
    const name = params.name
    const lat = params.lat
    const lng = params.lng
    const category = params.category
    if (typeof name !== 'string' || !name.trim()) return { success: false, error: 'name is required' }
    if (typeof lat !== 'number' || typeof lng !== 'number') return { success: false, error: 'lat and lng must be numbers' }
    if (typeof category !== 'string' || !category) return { success: false, error: 'category is required' }
    if (!await getCategory(category)) return unknownCategoryError(category)

    const id = `local-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${Date.now().toString(36)}`
    const aliases = Array.isArray(params.aliases) ? params.aliases.filter((a): a is string => typeof a === 'string') : undefined
    const tags = Array.isArray(params.tags) ? params.tags.filter((t): t is string => typeof t === 'string') : undefined

    const feature: GeoFeature = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
      properties: {
        id,
        name: name.trim(),
        category,
        verified: false,
        source: 'local' as GeoSource,
        added_by: 'agent',
        added_at: new Date().toISOString(),
        ...(aliases && aliases.length > 0 ? { aliases } : {}),
        ...(typeof params.country === 'string' ? { country: params.country } : {}),
        ...(typeof params.operator === 'string' ? { operator: params.operator } : {}),
        ...(typeof params.iata === 'string' ? { iata: params.iata } : {}),
        ...(typeof params.icao === 'string' ? { icao: params.icao } : {}),
        ...(tags && tags.length > 0 ? { tags } : {}),
      },
    }

    const result = await upsertFeature(feature)
    const stored = await lookupInCategory(category, name, { includeUnverified: true })
    const added = stored?.properties.id === id
    return { success: true, data: { added, replaced: result.replaced, id: stored?.properties.id ?? id } }
  },
})

// ============================================================================
// geo_remove
// ============================================================================

export const createGeoRemoveTool = (): Tool => ({
  name: 'geo_remove',
  description: 'Removes a feature from the user-local geodata store. Only removes entries that are local AND unverified. Curated features and entire categories cannot be removed via this tool — that is a user-only action in Settings → Geodata.',
  usage: 'Use to clean up a wrong agent-added entry. Pass the feature id returned by geo_add or surfaced by a previous geo_lookup result.',
  returns: '{ removed: boolean }.',
  parameters: {
    type: 'object',
    properties: {
      id:       { type: 'string', description: 'Feature id to remove.' },
      category: { type: 'string', description: 'Category id the feature lives in.' },
    },
    required: ['id', 'category'],
  },
  execute: async (params: Record<string, unknown>) => {
    const id = params.id
    const category = params.category
    if (typeof id !== 'string' || !id) return { success: false, error: 'id is required' }
    if (typeof category !== 'string' || !category) return { success: false, error: 'category is required' }
    if (!await getCategory(category)) return unknownCategoryError(category)
    const { listCategory } = await import('../../geo/store.ts')
    const list = await listCategory(category)
    const target = list.find((f) => f.properties.id === id)
    if (!target) return { success: true, data: { removed: false } }
    if (target.properties.source !== 'local' || target.properties.verified) {
      return { success: false, error: 'cannot remove curated or non-local features (use the Settings → Geodata panel)' }
    }
    const result = await removeFeature(category, 'local', id)
    return { success: true, data: { removed: result.removed } }
  },
})

// ============================================================================
// geo_list_categories
// ============================================================================

export const createGeoListCategoriesTool = (): Tool => ({
  name: 'geo_list_categories',
  description: 'Lists all registered geodata categories with their id, displayName, icon, and feature count. Categories are user-defined via Settings → Geodata → Import.',
  usage: 'Call this BEFORE geo_lookup, geo_add, or geo_remove to discover what categories exist. Returns an empty array on a fresh install.',
  returns: 'Array of { id, displayName, icon, featureCount, hasOsmQuery }.',
  parameters: { type: 'object', properties: {}, required: [] },
  execute: async () => {
    const cats = await listCategories()
    const rows = await Promise.all(cats.map(async (m) => {
      const stats = await categoryStats(m.id)
      return {
        id: m.id,
        displayName: m.displayName,
        icon: m.icon,
        featureCount: stats.total,
        hasOsmQuery: !!m.osmQuery,
      }
    }))
    return { success: true, data: rows }
  },
})
