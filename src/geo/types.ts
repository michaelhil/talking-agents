// ============================================================================
// Geodata types — canonical Feature shape, store + index types.
//
// One format end-to-end: bundled repo, local user-edits, agent input, API
// responses. Standard GeoJSON Feature with a strict `properties` shape.
// Geometry is `Point` for v1; lines/polygons can come later without breaking
// readers.
//
// Property contract:
//   - id is canonical kebab-case, unique within (source, category)
//   - name is the human display string (raw, not folded)
//   - aliases are alternate display strings; canonical-form matching folds
//     all of them at lookup time
//   - verified=true means curated (bundled, or user-promoted local)
//   - verified=false means upstream-cached or freshly-added by agent
//
// ID space: cross-source collisions are allowed. Lookups walk the cascade
// and surface the first hit; the (source, id) pair is the unique key for
// remove/update operations.
// ============================================================================

export type GeoSource = 'local' | 'bundled' | 'nominatim' | 'overpass'

export type GeoCategory =
  | 'airport'
  | 'offshore-platform'
  | 'city'
  | 'landmark'
  | 'address'
  | 'other'

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
  readonly added_by?: 'user' | 'agent'
  readonly added_at?: string        // ISO 8601
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

// One file per category. The category lives in properties.category, but the
// filename mirrors it for fast file-level operations + diff-friendly PRs.
export type CategoryFileMap = Record<GeoCategory, string>

// Top-level index in the bundled repo. Lists category → file. No
// schema_version: bundle bumps are clean breaks (matches snapshot policy).
export interface GeoIndex {
  readonly version: string                            // matches the git tag, e.g. "0.1.0"
  readonly generated_at: string                       // ISO 8601
  readonly categories: ReadonlyArray<{
    readonly category: GeoCategory
    readonly file: string                             // path relative to repo root
    readonly count: number
  }>
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
    readonly icon?: 'pin' | 'plane' | 'airport' | 'platform' | 'ship' | 'city' | 'dot'
    readonly color?: string
  }>
}
