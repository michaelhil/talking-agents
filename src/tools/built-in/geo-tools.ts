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
import { categoryStats, listCategory, lookupInCategory, removeFeature, upsertFeature } from '../../geo/store.ts'
import { getCategory, listCategories } from '../../geo/categories.ts'
import type { CategoryMeta, GeoFeature, GeoSource, MapEnvelopeFromGeo, MarkerIcon } from '../../geo/types.ts'
import type { Tool } from '../../core/types/tool.ts'

// Room-aware activation resolver. When wired (always in production via
// bootstrap), geo_lookup applies the same effectiveActivePacks gate the
// rest of the pack subsystem uses: pack-sourced features are visible
// only when the owning pack is active in the trigger room. Without it
// (tests / MCP-only), filtering is skipped and behavior matches the
// pre-pack-scoping cascade.
export interface GeoToolsDeps {
  readonly getActivePacks?: (roomId: string) => ReadonlyArray<string> | undefined
}

const IMPLICIT_ACTIVE = ['core', 'local'] as const

const buildActiveSet = (
  deps: GeoToolsDeps | undefined,
  roomId: string | undefined,
): ReadonlySet<string> | undefined => {
  if (!deps?.getActivePacks || !roomId) return undefined
  const explicit = deps.getActivePacks(roomId)
  if (!explicit) return undefined
  return new Set([...IMPLICIT_ACTIVE, ...explicit])
}

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

// Wrap an envelope in a ```map fenced code block — the canonical agent
// output shape. Drop into a chat message verbatim and the renderer picks
// it up. Saves the agent from re-stringifying or guessing the fence
// language tag.
const renderableFor = (envelope: { view?: unknown; features: ReadonlyArray<unknown> }): string => {
  return '```map\n' + JSON.stringify(envelope, null, 2) + '\n```'
}

// ============================================================================
// geo_lookup
// ============================================================================

export const createGeoLookupTool = (deps?: GeoToolsDeps): Tool => ({
  name: 'geo_lookup',
  description: 'Resolve a place name to coordinates via local store → Overpass → Nominatim. Paste `data.renderable` verbatim into your reply to render the map inline.',
  usage: 'Strict-match — pass an exact name or alias. The result includes `data.renderable` — drop that string verbatim into your chat reply to render the map inline. If category is unknown, the call returns an error; ask the user to import the category first.',
  returns: '{ features: [{type:"marker", lat, lng, label, icon}], view?: {center,zoom}, source: "local"|"overpass"|"nominatim", renderable: "```map\\n...\\n```" }, or { features: [] } when nothing matched.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      category: { type: 'string', description: 'Registered category id (list via geo_list_categories).' },
    },
    required: ['query', 'category'],
  },
  execute: async (params: Record<string, unknown>, ctx) => {
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
      // Pack-aware filter: derive the active set from the trigger room
      // (when both deps and ctx.roomId are wired) and pass it to the
      // resolver. Pack features for inactive packs are filtered out of
      // the local cascade step, matching the per-room scoping for tools/
      // skills/scripts.
      const activePacks = buildActiveSet(deps, ctx.roomId)
      const result = await resolveLocation(query, category, activePacks ? { activePacks } : {})
      if (!result) {
        return { success: true, data: { features: [], source: null } }
      }
      const env = buildEnvelope(result.features, meta.icon)
      return {
        success: true,
        data: {
          ...env,
          source: result.source,
          // Drop this verbatim into your reply to render the map inline.
          // Maps DO NOT use add_artifact — the inline ```map fence is
          // the only render path.
          renderable: renderableFor(env),
        },
      }
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
  description: 'Add a feature to the local store under an existing category. Written as unverified; never overwrites curated entries.',
  usage: 'Use after a successful web_search or domain-knowledge claim to persist a place the cascade did not find. The category MUST already exist (call geo_list_categories). To create a new category, ask the user to use Settings → Geodata → Import.',
  returns: '{ added: boolean, replaced: boolean, id: string }. added=false when a curated entry blocked the write.',
  parameters: {
    type: 'object',
    properties: {
      name:     { type: 'string' },
      lat:      { type: 'number',  description: 'decimal degrees' },
      lng:      { type: 'number',  description: 'decimal degrees' },
      category: { type: 'string',  description: 'Existing category id.' },
      aliases:  { type: 'array',   items: { type: 'string' } },
      country:  { type: 'string',  description: 'ISO-3166-1 alpha-2.' },
      operator: { type: 'string' },
      iata:     { type: 'string',  description: 'IATA code (airports).' },
      icao:     { type: 'string',  description: 'ICAO code (airports).' },
      tags:     { type: 'array',   items: { type: 'string' } },
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
  description: 'Remove an unverified local feature. Curated and non-local features are immutable from this tool.',
  usage: 'Use to clean up a wrong agent-added entry. Pass the feature id returned by geo_add or surfaced by a previous geo_lookup result.',
  returns: '{ removed: boolean }.',
  parameters: {
    type: 'object',
    properties: {
      id:       { type: 'string' },
      category: { type: 'string' },
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
  description: 'List registered geodata categories with id, displayName, icon, and feature count.',
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

// ============================================================================
// geo_list_features
//
// Bulk-list all features in a category (or a filtered subset). Folds the
// "discover the category id, then list all features, then filter, then
// build a map envelope" sequence into a single tool call so prompts like
// "show all Norwegian oil platforms on a map" succeed without N round-trips.
//
// Category resolution is forgiving: pass either `category` (exact id) or
// `categoryHint` (case-insensitive substring against displayName + id).
// On ambiguous hint, returns an error listing the candidates so the agent
// can clarify with the user — never silently guesses.
// ============================================================================

const fuzzyMatchCategory = (
  hint: string,
  cats: ReadonlyArray<CategoryMeta>,
): { match: CategoryMeta | null; candidates: ReadonlyArray<CategoryMeta> } => {
  const needle = hint.toLowerCase().trim()
  if (!needle) return { match: null, candidates: [] }
  // Exact id wins.
  const exact = cats.find((c) => c.id === needle)
  if (exact) return { match: exact, candidates: [] }
  // Substring match against id OR displayName.
  const matches = cats.filter((c) => {
    const dn = c.displayName.toLowerCase()
    return c.id.includes(needle) || dn.includes(needle)
  })
  if (matches.length === 1) return { match: matches[0]!, candidates: [] }
  return { match: null, candidates: matches }
}

const filterFeatures = (
  features: ReadonlyArray<GeoFeature>,
  filters: { country?: string; operator?: string; nameContains?: string; tag?: string },
): ReadonlyArray<GeoFeature> => {
  const country = filters.country?.toUpperCase()
  const operator = filters.operator?.toLowerCase()
  const nameContains = filters.nameContains?.toLowerCase()
  const tag = filters.tag?.toLowerCase()
  return features.filter((f) => {
    const p = f.properties
    if (country && p.country?.toUpperCase() !== country) return false
    if (operator && (p.operator?.toLowerCase() ?? '').indexOf(operator) === -1) return false
    if (nameContains) {
      const inName = p.name.toLowerCase().includes(nameContains)
      const inAlias = p.aliases?.some((a) => a.toLowerCase().includes(nameContains)) ?? false
      if (!inName && !inAlias) return false
    }
    if (tag && !(p.tags?.map((t) => t.toLowerCase()).includes(tag) ?? false)) return false
    return true
  })
}

// Compute a center+zoom that fits all points roughly. Single point: zoom 9.
// Multi-point: pick center as midpoint of bbox; zoom from longitudinal span
// (rough — Leaflet auto-fit on the client is the authoritative version, this
// is a hint).
const fitView = (features: ReadonlyArray<GeoFeature>): MapEnvelopeFromGeo['view'] | undefined => {
  if (features.length === 0) return undefined
  if (features.length === 1) {
    const [lng, lat] = features[0]!.geometry.coordinates
    return { center: [lat, lng], zoom: 9 }
  }
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180
  for (const f of features) {
    const [lng, lat] = f.geometry.coordinates
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
    if (lng < minLng) minLng = lng
    if (lng > maxLng) maxLng = lng
  }
  const center: [number, number] = [(minLat + maxLat) / 2, (minLng + maxLng) / 2]
  // Crude zoom estimate from longitudinal span.
  const span = Math.max(maxLat - minLat, (maxLng - minLng) / 2)
  let zoom = 9
  if (span > 0.5) zoom = 7
  if (span > 2) zoom = 6
  if (span > 8) zoom = 4
  if (span > 30) zoom = 3
  return { center, zoom }
}

const DEFAULT_LIMIT = 200
const MAX_LIMIT = 1000

export const createGeoListFeaturesTool = (): Tool => ({
  name: 'geo_list_features',
  description: 'List features in a category, optionally filtered by country / operator / name-substring / tag. Paste `data.renderable` verbatim into your reply to render the map inline.',
  usage: 'Pass `category` (exact id) OR `categoryHint` (e.g. "oil platforms"). On ambiguous hint, the call errors with the candidate ids so you can clarify with the user. Filters compose (AND): country=ISO-3166-1-alpha-2, operator=substring, nameContains=substring on name+aliases, tag=exact match. Drop `data.renderable` verbatim into your chat reply to render the map inline.',
  returns: '{ features: [...], view?: {center, zoom}, count, totalMatched, truncated, category, source: "merged", renderable: "```map\\n{...}\\n```" }, or { success:false, error, candidates? } on ambiguity.',
  parameters: {
    type: 'object',
    properties: {
      category:      { type: 'string' },
      categoryHint:  { type: 'string', description: 'Substring against id or displayName; errors with candidates on ambiguity.' },
      country:       { type: 'string', description: 'ISO-3166-1 alpha-2.' },
      operator:      { type: 'string', description: 'Substring, case-insensitive.' },
      nameContains:  { type: 'string', description: 'Matches name + aliases.' },
      tag:           { type: 'string' },
      limit:         { type: 'number', default: DEFAULT_LIMIT, maximum: MAX_LIMIT },
    },
    required: [],
  },
  execute: async (params: Record<string, unknown>) => {
    const categoryParam = typeof params.category === 'string' ? params.category : ''
    const hint = typeof params.categoryHint === 'string' ? params.categoryHint : ''
    if (!categoryParam && !hint) {
      return { success: false, error: 'either `category` or `categoryHint` is required' }
    }

    const allCats = await listCategories()
    if (allCats.length === 0) {
      return { success: false, error: 'no geo categories registered yet — the user must import one first via Settings → Geodata → Import.' }
    }

    let meta: CategoryMeta | null = null
    if (categoryParam) {
      meta = allCats.find((c) => c.id === categoryParam) ?? null
      if (!meta) return unknownCategoryError(categoryParam)
    } else {
      const r = fuzzyMatchCategory(hint, allCats)
      if (!r.match) {
        if (r.candidates.length === 0) {
          return {
            success: false,
            error: `no category matched hint '${hint}'. Available: ${allCats.map((c) => c.id).join(', ')}`,
          }
        }
        return {
          success: false,
          error: `categoryHint '${hint}' is ambiguous`,
          candidates: r.candidates.map((c) => ({ id: c.id, displayName: c.displayName })),
        }
      }
      meta = r.match
    }

    const filters = {
      ...(typeof params.country === 'string' ? { country: params.country } : {}),
      ...(typeof params.operator === 'string' ? { operator: params.operator } : {}),
      ...(typeof params.nameContains === 'string' ? { nameContains: params.nameContains } : {}),
      ...(typeof params.tag === 'string' ? { tag: params.tag } : {}),
    }

    const all = await listCategory(meta.id)
    const filtered = filterFeatures(all, filters)

    const requestedLimit = typeof params.limit === 'number' && params.limit > 0
      ? Math.min(params.limit, MAX_LIMIT)
      : DEFAULT_LIMIT
    const truncated = filtered.length > requestedLimit
    const slice = truncated ? filtered.slice(0, requestedLimit) : filtered

    const view = fitView(slice)
    const envelope = {
      features: slice.map((f) => featureToEnvelope(f, meta!.icon)),
      ...(view ? { view } : {}),
    }
    return {
      success: true,
      data: {
        ...envelope,
        count: slice.length,
        totalMatched: filtered.length,
        truncated,
        category: meta.id,
        source: 'merged' as const,
        // Drop this verbatim into your reply to render the map inline.
        // Maps DO NOT use add_artifact — the inline ```map fence is
        // the only render path.
        renderable: renderableFor(envelope),
      },
    }
  },
})
