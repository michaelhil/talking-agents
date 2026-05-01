// ============================================================================
// Geo tools — geo_lookup, geo_add, geo_remove
//
// All three operate over the geodata layer (src/geo/). Returns are shaped
// to drop into either the inline ```map fence or add_artifact/update_artifact:
//   data: { features: [...envelope-feature], view?: {...} }
//
// Safety rails:
//   - geo_lookup is read-mostly (cascade may write upstream hits to the
//     local store as verified:false, but never overwrites curated entries).
//   - geo_add always writes verified:false, source:'local', added_by:'agent'.
//     Curated (verified:true) entries with the same canonical name are NOT
//     overwritten — the store enforces this.
//   - geo_remove only removes (source:'local', verified:false) entries.
//     Curated and bundled features are immutable from the agent surface.
//
// Tool descriptions emphasise the envelope-shape compatibility — the
// agent should be able to copy `data` into either rendering surface
// without further transformation.
// ============================================================================

import { resolveLocation } from '../../geo/resolver.ts'
import { lookupInCategory, removeFeature, upsertFeature } from '../../geo/store.ts'
import type { GeoCategory, GeoFeature, GeoSource, MapEnvelopeFromGeo } from '../../geo/types.ts'
import type { Tool } from '../../core/types/tool.ts'

const VALID_CATEGORIES: ReadonlyArray<GeoCategory> = [
  'airport', 'offshore-platform', 'city', 'landmark', 'address', 'other',
]

const ICON_FOR_CATEGORY: Record<GeoCategory, MapEnvelopeFromGeo['features'][number]['icon']> = {
  airport: 'airport',
  'offshore-platform': 'platform',
  city: 'city',
  landmark: 'pin',
  address: 'pin',
  other: 'pin',
}

const featureToEnvelope = (f: GeoFeature): MapEnvelopeFromGeo['features'][number] => {
  const [lng, lat] = f.geometry.coordinates
  return {
    type: 'marker',
    lat,
    lng,
    label: f.properties.name,
    icon: ICON_FOR_CATEGORY[f.properties.category],
  }
}

const buildEnvelope = (features: ReadonlyArray<GeoFeature>): MapEnvelopeFromGeo => {
  if (features.length === 0) return { features: [] }
  if (features.length === 1) {
    const [lng, lat] = features[0]!.geometry.coordinates
    return {
      view: { center: [lat, lng], zoom: 9 },
      features: features.map(featureToEnvelope),
    }
  }
  return { features: features.map(featureToEnvelope) }
}

const isValidCategory = (c: unknown): c is GeoCategory =>
  typeof c === 'string' && (VALID_CATEGORIES as ReadonlyArray<string>).includes(c)

// ============================================================================
// geo_lookup
// ============================================================================

export const createGeoLookupTool = (): Tool => ({
  name: 'geo_lookup',
  description: 'Resolves a place name to coordinates via the cascade: local store → bundled dataset → Overpass (OSM) → Nominatim (OSM). Returns map-envelope features ready to drop into a ```map fenced block or an add_artifact/update_artifact body.',
  usage: 'Use this BEFORE writing any lat/lng yourself. Strict-match — pass an exact name or alias (e.g. "Bergen", "ENGM", "Ekofisk"). Free-text addresses fall through to Nominatim. The result `data` field is already in envelope shape.',
  returns: '{ features: [{type:"marker", lat, lng, label, icon}], view?: {center,zoom}, source: "local"|"bundled"|"overpass"|"nominatim" }, or { features: [] } when nothing matched.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Place name, alias, ICAO/IATA code, or address.' },
      category: {
        type: 'string',
        description: 'One of: airport, offshore-platform, city, landmark, address, other. Determines which OSM tag is queried upstream.',
      },
    },
    required: ['query', 'category'],
  },
  execute: async (params: Record<string, unknown>) => {
    const query = params.query
    const category = params.category
    if (typeof query !== 'string' || !query.trim()) {
      return { success: false, error: 'query is required' }
    }
    if (!isValidCategory(category)) {
      return { success: false, error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` }
    }
    try {
      const result = await resolveLocation(query, category)
      if (!result) {
        return { success: true, data: { features: [], source: null } }
      }
      const env = buildEnvelope(result.features)
      return {
        success: true,
        data: {
          ...env,
          source: result.source,
        },
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  },
})

// ============================================================================
// geo_add
// ============================================================================

export const createGeoAddTool = (): Tool => ({
  name: 'geo_add',
  description: 'Adds a feature to the user-local geodata store. Always written as verified:false (unverified). Curated (verified:true) features with the same canonical name are NOT overwritten.',
  usage: 'Use after a successful web_search or domain-knowledge claim to persist a place the cascade did not find. Provide canonical lat/lng. The user can promote unverified entries to verified via the Settings → Geodata panel.',
  returns: '{ added: boolean, replaced: boolean, id: string }. added=false when a curated entry blocked the write.',
  parameters: {
    type: 'object',
    properties: {
      name:     { type: 'string',  description: 'Display name, e.g. "Ekofisk".' },
      lat:      { type: 'number',  description: 'Latitude (decimal degrees).' },
      lng:      { type: 'number',  description: 'Longitude (decimal degrees).' },
      category: { type: 'string',  description: 'One of: airport, offshore-platform, city, landmark, address, other.' },
      aliases:  { type: 'array',   description: 'Alternate display names / codes.', items: { type: 'string' } },
      country:  { type: 'string',  description: 'ISO-3166-1 alpha-2 country code (optional).' },
      operator: { type: 'string',  description: 'Operating organisation, if relevant (oil platforms, airports).' },
      iata:     { type: 'string',  description: 'IATA airport code (airports only).' },
      icao:     { type: 'string',  description: 'ICAO airport code (airports only).' },
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
    if (!isValidCategory(category)) return { success: false, error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` }

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
    // Re-check whether the feature is actually present (might have been
    // blocked by verified-protection).
    const stored = await lookupInCategory(category, name, { includeUnverified: true })
    const added = stored?.properties.id === id
    return {
      success: true,
      data: { added, replaced: result.replaced, id: stored?.properties.id ?? id },
    }
  },
})

// ============================================================================
// geo_remove
// ============================================================================

export const createGeoRemoveTool = (): Tool => ({
  name: 'geo_remove',
  description: 'Removes a feature from the user-local geodata store. Only removes entries that are local AND unverified. Curated and bundled features cannot be removed via this tool — that is a user-only action in the Settings panel.',
  usage: 'Use to clean up a wrong agent-added entry. Pass the feature id returned by geo_add or surfaced by a previous geo_lookup result.',
  returns: '{ removed: boolean }.',
  parameters: {
    type: 'object',
    properties: {
      id:       { type: 'string', description: 'Feature id to remove (from a previous geo_add or geo_lookup result).' },
      category: { type: 'string', description: 'Category the feature lives in. One of: airport, offshore-platform, city, landmark, address, other.' },
    },
    required: ['id', 'category'],
  },
  execute: async (params: Record<string, unknown>) => {
    const id = params.id
    const category = params.category
    if (typeof id !== 'string' || !id) return { success: false, error: 'id is required' }
    if (!isValidCategory(category)) return { success: false, error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` }
    // Only local + unverified features are removable. Look up first to
    // enforce the verified-immutability rule.
    const list = await (await import('../../geo/store.ts')).listCategory(category)
    const target = list.find((f) => f.properties.id === id)
    if (!target) return { success: true, data: { removed: false } }
    if (target.properties.source !== 'local' || target.properties.verified) {
      return { success: false, error: 'cannot remove curated or non-local features via geo_remove (use the Settings → Geodata panel)' }
    }
    const result = await removeFeature(category, 'local', id)
    return { success: true, data: { removed: result.removed } }
  },
})
