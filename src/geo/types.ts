// ============================================================================
// Geodata types — canonical Feature shape, store + index types.
//
// One format end-to-end: user-paste imports, agent-tool input, store on
// disk, API responses. Standard GeoJSON Feature with a strict `properties`
// shape. Geometry is `Point` for v1; lines/polygons can come later without
// breaking readers.
//
// Categories are no longer a closed union — users define them via the
// paste-import flow, validated against the registry at runtime. The
// `category` field is therefore typed as `string` here, with runtime
// validation in src/geo/categories.ts.
//
// ID space: cross-source collisions are allowed. Lookups walk the cascade
// and surface the first hit; the (source, id) pair is the unique key for
// remove/update operations.
// ============================================================================

import type { MarkerIcon } from '../ui/modules/map/schema.ts'
export { MARKER_ICONS, isMarkerIcon, type MarkerIcon } from '../ui/modules/map/schema.ts'

export type GeoSource = 'local' | 'overpass' | 'nominatim' | 'discovered' | 'pack'

// Open category type. Validation is registry-driven at runtime — see
// src/geo/categories.ts.
export type GeoCategory = string

export interface GeoProperties {
  readonly id: string
  readonly name: string
  readonly aliases?: ReadonlyArray<string>
  readonly category: GeoCategory
  readonly subcategory?: string
  readonly country?: string         // ISO-3166-1 alpha-2
  readonly iata?: string
  readonly icao?: string
  readonly operator?: string
  readonly tags?: ReadonlyArray<string>
  readonly verified: boolean
  readonly source: GeoSource
  // When `source === 'pack'`, names the owning pack namespace. The room-
  // aware filter (effectiveActivePacks ⊕ implicit core+local) gates pack
  // features per room. Undefined for non-pack sources.
  readonly pack?: string
  readonly added_by?: 'user' | 'agent'
  readonly added_at?: string        // ISO 8601
  // === Embedded category metadata (optional) ===
  // Categories are derived from features rather than declared in a separate
  // registry. Any feature can carry these properties; on read, the first
  // feature found with each property defines the category's metadata. If no
  // feature carries them, fallbacks apply: display = title-case(id), icon =
  // 'pin', osmQuery = undefined (Overpass cascade step skipped).
  readonly category_display?: string
  readonly category_icon?: MarkerIcon
  readonly category_osm_query?: string  // Overpass template, must contain `{name}` exactly once
}

export interface GeoPoint {
  readonly type: 'Point'
  readonly coordinates: readonly [number, number]   // [lng, lat] per GeoJSON spec
}

export interface GeoFeature {
  readonly type: 'Feature'
  readonly geometry: GeoPoint
  readonly properties: GeoProperties
}

export interface GeoFeatureCollection {
  readonly type: 'FeatureCollection'
  readonly features: ReadonlyArray<GeoFeature>
}

// Category metadata — derived from feature properties at read time.
// No persisted registry file; categories exist iff at least one feature
// carries that category id. Metadata fields project from any feature
// carrying category_display / category_icon / category_osm_query.
export interface CategoryMeta {
  readonly id: string                       // kebab-case, /^[a-z][a-z0-9-]{0,62}$/
  readonly displayName: string
  readonly icon: MarkerIcon
  readonly osmQuery?: string                // Overpass template with `{name}` placeholder
}

// Resolver result. Single-source short-circuit: the first cascade source to
// return a strict match wins.
export interface GeoLookupResult {
  readonly features: ReadonlyArray<GeoFeature>
  readonly source: GeoSource
}

// Envelope shape consumed by the inline ```map fence and add_artifact body.
// Built from a GeoLookupResult for the agent.
export interface MapEnvelopeFromGeo {
  readonly view?: { readonly center: readonly [number, number]; readonly zoom: number }
  readonly features: ReadonlyArray<{
    readonly type: 'marker'
    readonly lat: number
    readonly lng: number
    readonly label?: string
    readonly icon?: MarkerIcon
    readonly color?: string
  }>
}
