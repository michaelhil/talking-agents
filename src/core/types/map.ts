// ============================================================================
// Canonical map schema — single source of truth for the entire mapping
// system: parser, renderer, validator, agent-facing tool descriptions.
//
// Two ingestion shapes are accepted (envelope and GeoJSON FeatureCollection),
// but the validator always normalizes to the envelope shape — the renderer
// and downstream code see ONE form.
//
// Errors carry { path, message } so a structured error display can show
// the agent and the user the exact field that failed.
// ============================================================================

// === Marker icons ===========================================================

// Closed enum. The renderer's SVG factory (ui/modules/map/icons.ts) maps
// each name to a divIcon. Adding an icon = one line here + one SVG.
export const MARKER_ICONS = ['pin', 'platform', 'airport', 'plane', 'ship', 'city', 'dot'] as const
export type MarkerIcon = typeof MARKER_ICONS[number]

export const isMarkerIcon = (s: unknown): s is MarkerIcon =>
  typeof s === 'string' && (MARKER_ICONS as ReadonlyArray<string>).includes(s)

// === Envelope shape =========================================================

export interface MapView {
  readonly center: readonly [number, number]   // [lat, lng]
  readonly zoom: number                        // 1..19
}

export type MapFeature =
  | {
      readonly type: 'marker'
      readonly lat: number
      readonly lng: number
      readonly label?: string
      readonly tooltip?: string
      readonly icon?: MarkerIcon
      readonly color?: string
    }
  | {
      readonly type: 'line' | 'track'
      readonly coords: ReadonlyArray<readonly [number, number]>
      readonly color?: string
      readonly weight?: number
    }
  | {
      readonly type: 'polygon'
      readonly coords: ReadonlyArray<readonly [number, number]>
      readonly color?: string
      readonly fillColor?: string
    }
  | {
      readonly type: 'circle'
      readonly lat: number
      readonly lng: number
      readonly radius: number   // meters
      readonly color?: string
    }

export interface MapEnvelope {
  readonly view?: MapView
  readonly features: ReadonlyArray<MapFeature>
}

// === Validation errors ======================================================

export interface MapValidationError {
  /** Dot-path into the input object: e.g. "features[3].icon" */
  readonly path: string
  /** Human-readable, single-sentence. Suitable for both user banner and agent retry. */
  readonly message: string
}

export type ValidatedMap =
  | { readonly ok: true; readonly envelope: MapEnvelope }
  | { readonly ok: false; readonly errors: ReadonlyArray<MapValidationError> }

// === Helpers ================================================================

const isLatLng = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number'

const isLatLngArray = (v: unknown): v is ReadonlyArray<[number, number]> =>
  Array.isArray(v) && v.every(isLatLng)

const inLatRange = (n: number): boolean => n >= -90 && n <= 90 && Number.isFinite(n)
const inLngRange = (n: number): boolean => n >= -180 && n <= 180 && Number.isFinite(n)

const validateView = (raw: unknown, errs: MapValidationError[]): MapView | undefined => {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object') {
    errs.push({ path: 'view', message: 'view must be an object { center: [lat, lng], zoom: number }' })
    return undefined
  }
  const o = raw as Record<string, unknown>
  if (!isLatLng(o.center)) {
    errs.push({ path: 'view.center', message: 'view.center must be [lat, lng] (two numbers)' })
    return undefined
  }
  if (typeof o.zoom !== 'number') {
    errs.push({ path: 'view.zoom', message: 'view.zoom must be a number (1-19)' })
    return undefined
  }
  if (!inLatRange(o.center[0]) || !inLngRange(o.center[1])) {
    errs.push({ path: 'view.center', message: 'view.center out of range (lat ∈ [-90,90], lng ∈ [-180,180])' })
    return undefined
  }
  return { center: o.center, zoom: o.zoom }
}

const validateMarker = (raw: Record<string, unknown>, path: string, errs: MapValidationError[]): MapFeature | null => {
  if (typeof raw.lat !== 'number' || !inLatRange(raw.lat)) {
    errs.push({ path: `${path}.lat`, message: 'marker.lat must be a number in [-90, 90]' })
    return null
  }
  if (typeof raw.lng !== 'number' || !inLngRange(raw.lng)) {
    errs.push({ path: `${path}.lng`, message: 'marker.lng must be a number in [-180, 180]' })
    return null
  }
  // Strict on icon — unknown icon is a structured error, not silent fallback.
  // The validator surfaces a list of the closed set so the agent can correct.
  let icon: MarkerIcon | undefined
  if (raw.icon !== undefined) {
    if (!isMarkerIcon(raw.icon)) {
      errs.push({
        path: `${path}.icon`,
        message: `unknown marker icon ${JSON.stringify(raw.icon)}. Valid: ${MARKER_ICONS.join(', ')}.`,
      })
      return null
    }
    icon = raw.icon
  }
  const out: MapFeature = {
    type: 'marker',
    lat: raw.lat,
    lng: raw.lng,
    ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
    ...(typeof raw.tooltip === 'string' ? { tooltip: raw.tooltip } : {}),
    ...(typeof raw.color === 'string' ? { color: raw.color } : {}),
    ...(icon ? { icon } : {}),
  }
  return out
}

const validateLine = (raw: Record<string, unknown>, kind: 'line' | 'track', path: string, errs: MapValidationError[]): MapFeature | null => {
  if (!isLatLngArray(raw.coords) || raw.coords.length < 2) {
    errs.push({ path: `${path}.coords`, message: `${kind}.coords must be an array of ≥ 2 [lat, lng] pairs` })
    return null
  }
  return {
    type: kind,
    coords: raw.coords,
    ...(typeof raw.color === 'string' ? { color: raw.color } : {}),
    ...(typeof raw.weight === 'number' ? { weight: raw.weight } : {}),
  }
}

const validatePolygon = (raw: Record<string, unknown>, path: string, errs: MapValidationError[]): MapFeature | null => {
  if (!isLatLngArray(raw.coords) || raw.coords.length < 3) {
    errs.push({ path: `${path}.coords`, message: 'polygon.coords must be an array of ≥ 3 [lat, lng] pairs' })
    return null
  }
  return {
    type: 'polygon',
    coords: raw.coords,
    ...(typeof raw.color === 'string' ? { color: raw.color } : {}),
    ...(typeof raw.fillColor === 'string' ? { fillColor: raw.fillColor } : {}),
  }
}

const validateCircle = (raw: Record<string, unknown>, path: string, errs: MapValidationError[]): MapFeature | null => {
  if (typeof raw.lat !== 'number' || !inLatRange(raw.lat)) {
    errs.push({ path: `${path}.lat`, message: 'circle.lat must be a number in [-90, 90]' })
    return null
  }
  if (typeof raw.lng !== 'number' || !inLngRange(raw.lng)) {
    errs.push({ path: `${path}.lng`, message: 'circle.lng must be a number in [-180, 180]' })
    return null
  }
  if (typeof raw.radius !== 'number' || raw.radius <= 0) {
    errs.push({ path: `${path}.radius`, message: 'circle.radius must be a positive number (meters)' })
    return null
  }
  return {
    type: 'circle',
    lat: raw.lat,
    lng: raw.lng,
    radius: raw.radius,
    ...(typeof raw.color === 'string' ? { color: raw.color } : {}),
  }
}

const validateFeature = (raw: unknown, path: string, errs: MapValidationError[]): MapFeature | null => {
  if (!raw || typeof raw !== 'object') {
    errs.push({ path, message: 'feature must be an object' })
    return null
  }
  const f = raw as Record<string, unknown>
  switch (f.type) {
    case 'marker':            return validateMarker(f, path, errs)
    case 'line':
    case 'track':             return validateLine(f, f.type, path, errs)
    case 'polygon':           return validatePolygon(f, path, errs)
    case 'circle':            return validateCircle(f, path, errs)
    default: {
      const t = JSON.stringify(f.type)
      errs.push({
        path: `${path}.type`,
        message: `unknown feature type ${t}. Valid: marker, line, track, polygon, circle.`,
      })
      return null
    }
  }
}

// === GeoJSON → envelope conversion ==========================================

// Walks a GeoJSON Point feature into a marker. Only Point geometry is
// supported in the envelope-flattened form. MultiPoint / LineString /
// Polygon could be added later but aren't currently rendered as markers.
const geojsonFeatureToEnvelope = (raw: unknown, path: string, errs: MapValidationError[]): MapFeature | null => {
  if (!raw || typeof raw !== 'object') {
    errs.push({ path, message: 'GeoJSON feature must be an object' })
    return null
  }
  const f = raw as Record<string, unknown>
  if (f.type !== 'Feature') {
    errs.push({ path: `${path}.type`, message: 'GeoJSON feature must have type:"Feature"' })
    return null
  }
  const geom = f.geometry as Record<string, unknown> | undefined
  if (!geom || geom.type !== 'Point' || !Array.isArray(geom.coordinates) || geom.coordinates.length < 2) {
    errs.push({
      path: `${path}.geometry`,
      message: 'GeoJSON feature must have Point geometry with [lng, lat] coordinates',
    })
    return null
  }
  // GeoJSON is [lng, lat]; we store [lat, lng] in the envelope.
  const lng = geom.coordinates[0] as number
  const lat = geom.coordinates[1] as number
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    errs.push({ path: `${path}.geometry.coordinates`, message: 'coordinates must be numbers' })
    return null
  }
  if (!inLatRange(lat) || !inLngRange(lng)) {
    errs.push({ path: `${path}.geometry.coordinates`, message: 'coordinates out of range' })
    return null
  }
  const props = (f.properties as Record<string, unknown> | undefined) ?? {}
  return {
    type: 'marker',
    lat,
    lng,
    ...(typeof props.name === 'string' ? { label: props.name } : (typeof props.label === 'string' ? { label: props.label } : {})),
    ...(typeof props.tooltip === 'string' ? { tooltip: props.tooltip } : {}),
    ...(isMarkerIcon(props.icon) ? { icon: props.icon } : {}),
    ...(typeof props.color === 'string' ? { color: props.color } : {}),
  }
}

// === Tolerant JSON pre-parse (raw control chars in string literals) ========

// LLMs routinely emit raw \n inside string values (e.g. "tooltip": "line 1\nline 2"
// where \n is an actual LF). JSON.parse rejects this. The pre-parser walks
// the source and escapes those characters inside string literals — valid
// JSON passes unchanged. Conservative: only touches characters JSON forbids
// raw in that position. Semantic errors (unknown icon, bad coord) still
// hard-fail downstream — the tolerance is for ONE syntactic class.
const escapeUnescapedControlsInStrings = (source: string): string => {
  let out = ''
  let inString = false
  let escaping = false
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!
    if (inString) {
      if (escaping) { out += ch; escaping = false; continue }
      if (ch === '\\') { out += ch; escaping = true; continue }
      if (ch === '"') { out += ch; inString = false; continue }
      if (ch === '\n') { out += '\\n'; continue }
      if (ch === '\r') { out += '\\r'; continue }
      if (ch === '\t') { out += '\\t'; continue }
      if (ch < ' ') { out += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'); continue }
      out += ch
      continue
    }
    if (ch === '"') inString = true
    out += ch
  }
  return out
}

// === Public API =============================================================

// Parse + validate map JSON source string. Returns either a normalized
// envelope or structured errors. Single entry point for the renderer,
// tools, and tests.
export const parseMapBody = (source: string): ValidatedMap => {
  let parsed: unknown
  try { parsed = JSON.parse(source) }
  catch (firstErr) {
    try { parsed = JSON.parse(escapeUnescapedControlsInStrings(source)) }
    catch {
      const msg = firstErr instanceof Error ? firstErr.message : String(firstErr)
      return { ok: false, errors: [{ path: '', message: `not valid JSON: ${msg}` }] }
    }
  }
  return validateMapEnvelope(parsed)
}

// Validate an already-parsed object (useful for tool bodies that arrive
// pre-parsed from JSON-RPC). Accepts envelope OR GeoJSON FeatureCollection,
// returns normalized envelope.
export const validateMapEnvelope = (input: unknown): ValidatedMap => {
  const errors: MapValidationError[] = []
  if (!input || typeof input !== 'object') {
    return { ok: false, errors: [{ path: '', message: 'expected an object' }] }
  }
  const obj = input as Record<string, unknown>

  // GeoJSON FeatureCollection branch — convert to envelope.
  if (obj.type === 'FeatureCollection') {
    if (!Array.isArray(obj.features)) {
      return { ok: false, errors: [{ path: 'features', message: 'FeatureCollection.features must be an array' }] }
    }
    const view = validateView(obj.view, errors)
    const features: MapFeature[] = []
    for (let i = 0; i < obj.features.length; i++) {
      const f = geojsonFeatureToEnvelope(obj.features[i], `features[${i}]`, errors)
      if (f) features.push(f)
    }
    if (errors.length > 0) return { ok: false, errors }
    return { ok: true, envelope: { features, ...(view ? { view } : {}) } }
  }

  // Envelope branch.
  if (!Array.isArray(obj.features)) {
    return { ok: false, errors: [{ path: 'features', message: 'expected `features` array (envelope) or `type: "FeatureCollection"` (GeoJSON)' }] }
  }
  const view = validateView(obj.view, errors)
  const features: MapFeature[] = []
  for (let i = 0; i < obj.features.length; i++) {
    const f = validateFeature(obj.features[i], `features[${i}]`, errors)
    if (f) features.push(f)
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, envelope: { features, ...(view ? { view } : {}) } }
}

// Format a validation result into a single human-readable string. Used by
// the inline error banner and the agent-facing tool error.
export const formatMapErrors = (errors: ReadonlyArray<MapValidationError>): string => {
  if (errors.length === 0) return ''
  if (errors.length === 1) {
    const e = errors[0]!
    return e.path ? `${e.path}: ${e.message}` : e.message
  }
  return errors.map(e => e.path ? `  • ${e.path}: ${e.message}` : `  • ${e.message}`).join('\n')
}

// Compute lat/lng pairs from a normalized envelope. Used for autofit.
export const collectEnvelopeLatLngs = (envelope: MapEnvelope): Array<[number, number]> => {
  const out: Array<[number, number]> = []
  for (const f of envelope.features) {
    if (f.type === 'marker') out.push([f.lat, f.lng])
    else if (f.type === 'circle') out.push([f.lat, f.lng])
    else for (const c of f.coords) out.push([c[0], c[1]])
  }
  return out
}

// Truncate a source string for display in a fallback card.
export const truncateForDisplay = (src: string, max = 500): string => {
  if (src.length <= max) return src
  return `${src.slice(0, max)}\n… (truncated)`
}
