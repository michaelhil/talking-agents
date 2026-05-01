// Normalises LLM-generated map source into a structured value the renderer
// can consume. Pure function. No DOM, no network, no side effects.
//
// Two accepted shapes (sniffed at parse time):
//
//   ENVELOPE — opinionated short-form. Easier for weaker agents.
//     {
//       "view"?: { "center": [lat, lng], "zoom": number },
//       "features": [
//         { "type": "marker",  "lat": number, "lng": number, "label"?: string, "color"?: string, "icon"?: MarkerIcon },
//         { "type": "line",    "coords": [[lat,lng],...], "color"?: string, "weight"?: number },
//         { "type": "track",   "coords": [[lat,lng],...], "color"?: string, "weight"?: number },  // alias for line
//         { "type": "polygon", "coords": [[lat,lng],...], "color"?: string, "fillColor"?: string },
//         { "type": "circle",  "lat": number, "lng": number, "radius": number, "color"?: string }
//       ]
//     }
//
//   Marker icon set: 'pin' (default teardrop) | 'plane' | 'airport' | 'platform'
//                  | 'ship' | 'city' | 'dot'.
//   When `icon` or `color` is set, the renderer draws a coloured SVG via
//   Leaflet divIcon — this is the only code path where `color` actually
//   takes effect on a marker (the default bitmap pin ignores it).
//
//   GEOJSON — standard FeatureCollection. Every model knows it.
//     { "type": "FeatureCollection", "features": [...] }
//
// View handling: explicit `view` wins. Otherwise the renderer auto-fits to
// feature bounds. Empty FeatureCollection AND no view → caller shows the
// `empty` fallback.
//
// No size cap (per design choice). A misbehaving agent that ships a 50MB
// FeatureCollection blows the renderer; revisit if it bites in practice.

export type MapView = { center: [number, number]; zoom: number }

export type MarkerIcon = 'pin' | 'plane' | 'airport' | 'platform' | 'ship' | 'city' | 'dot'

export const MARKER_ICONS: ReadonlySet<MarkerIcon> = new Set([
  'pin', 'plane', 'airport', 'platform', 'ship', 'city', 'dot',
])

export type EnvelopeFeature =
  | { type: 'marker'; lat: number; lng: number; label?: string; color?: string; icon?: MarkerIcon }
  | { type: 'line' | 'track'; coords: ReadonlyArray<[number, number]>; color?: string; weight?: number }
  | { type: 'polygon'; coords: ReadonlyArray<[number, number]>; color?: string; fillColor?: string }
  | { type: 'circle'; lat: number; lng: number; radius: number; color?: string }

export interface MapEnvelope {
  view?: MapView
  features: EnvelopeFeature[]
}

export interface GeoJSONFeatureCollection {
  type: 'FeatureCollection'
  features: ReadonlyArray<unknown>
  // Optional view extension — accepted but not part of the spec. Lets
  // GeoJSON authors pin a view without falling back to the envelope.
  view?: MapView
}

export type ParsedMap =
  | { kind: 'envelope'; data: MapEnvelope }
  | { kind: 'geojson'; data: GeoJSONFeatureCollection }
  | { kind: 'invalid'; reason: string }

const isLatLng = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number'

const isLatLngArray = (v: unknown): v is ReadonlyArray<[number, number]> =>
  Array.isArray(v) && v.every(isLatLng)

const validateView = (v: unknown): MapView | undefined => {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const center = o.center
  const zoom = o.zoom
  if (!isLatLng(center)) return undefined
  if (typeof zoom !== 'number') return undefined
  return { center, zoom }
}

const validateEnvelopeFeature = (raw: unknown): EnvelopeFeature | null => {
  if (!raw || typeof raw !== 'object') return null
  const f = raw as Record<string, unknown>
  switch (f.type) {
    case 'marker': {
      if (typeof f.lat !== 'number' || typeof f.lng !== 'number') return null
      const out: EnvelopeFeature = { type: 'marker', lat: f.lat, lng: f.lng }
      if (typeof f.label === 'string') (out as { label?: string }).label = f.label
      if (typeof f.color === 'string') (out as { color?: string }).color = f.color
      // Unknown icon names are silently dropped rather than failing validation —
      // the marker still renders (default bitmap pin), the agent just doesn't
      // get the colour treatment. Strict failure here would break maps over a
      // typo in a single feature.
      if (typeof f.icon === 'string' && MARKER_ICONS.has(f.icon as MarkerIcon)) {
        (out as { icon?: MarkerIcon }).icon = f.icon as MarkerIcon
      }
      return out
    }
    case 'line':
    case 'track': {
      if (!isLatLngArray(f.coords) || f.coords.length < 2) return null
      const out: EnvelopeFeature = { type: f.type, coords: f.coords }
      if (typeof f.color === 'string') (out as { color?: string }).color = f.color
      if (typeof f.weight === 'number') (out as { weight?: number }).weight = f.weight
      return out
    }
    case 'polygon': {
      if (!isLatLngArray(f.coords) || f.coords.length < 3) return null
      const out: EnvelopeFeature = { type: 'polygon', coords: f.coords }
      if (typeof f.color === 'string') (out as { color?: string }).color = f.color
      if (typeof f.fillColor === 'string') (out as { fillColor?: string }).fillColor = f.fillColor
      return out
    }
    case 'circle': {
      if (typeof f.lat !== 'number' || typeof f.lng !== 'number') return null
      if (typeof f.radius !== 'number' || f.radius <= 0) return null
      const out: EnvelopeFeature = { type: 'circle', lat: f.lat, lng: f.lng, radius: f.radius }
      if (typeof f.color === 'string') (out as { color?: string }).color = f.color
      return out
    }
    default:
      return null
  }
}

export const parseMapSource = (source: string): ParsedMap => {
  let parsed: unknown
  try { parsed = JSON.parse(source) }
  catch (err) {
    return { kind: 'invalid', reason: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { kind: 'invalid', reason: 'expected an object' }
  }
  const obj = parsed as Record<string, unknown>

  // GeoJSON branch — recognised by the canonical type tag.
  if (obj.type === 'FeatureCollection') {
    if (!Array.isArray(obj.features)) {
      return { kind: 'invalid', reason: 'FeatureCollection.features must be an array' }
    }
    const view = validateView(obj.view)
    return {
      kind: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: obj.features,
        ...(view ? { view } : {}),
      },
    }
  }

  // Envelope branch — must have a `features` array.
  if (!Array.isArray(obj.features)) {
    return { kind: 'invalid', reason: 'expected `features` array or a GeoJSON FeatureCollection' }
  }
  const view = validateView(obj.view)
  const features: EnvelopeFeature[] = []
  for (let i = 0; i < obj.features.length; i++) {
    const f = validateEnvelopeFeature(obj.features[i])
    if (!f) {
      return { kind: 'invalid', reason: `feature[${i}] is not a recognised type or has invalid fields` }
    }
    features.push(f)
  }
  return {
    kind: 'envelope',
    data: { features, ...(view ? { view } : {}) },
  }
}

// Truncate a source string for display in a fallback card. Shared shape
// with mermaid's truncateForDisplay.
export const truncateForDisplay = (src: string, max = 500): string => {
  if (src.length <= max) return src
  return `${src.slice(0, max)}\n… (truncated)`
}

// Compute bounds from a parsed map. Returns null when there's nothing to
// fit (empty features). Callers use this for autofit when no view is set.
export const collectLatLngs = (parsed: Extract<ParsedMap, { kind: 'envelope' | 'geojson' }>): Array<[number, number]> => {
  const out: Array<[number, number]> = []
  if (parsed.kind === 'envelope') {
    for (const f of parsed.data.features) {
      if (f.type === 'marker') out.push([f.lat, f.lng])
      else if (f.type === 'circle') out.push([f.lat, f.lng])
      else for (const c of f.coords) out.push(c)
    }
  } else {
    // GeoJSON: walk features, pull every coordinate. We accept the standard
    // [lng, lat] order from GeoJSON and flip to Leaflet's [lat, lng].
    for (const f of parsed.data.features) {
      const geom = (f as { geometry?: { type?: string; coordinates?: unknown } })?.geometry
      if (!geom?.type || geom.coordinates === undefined) continue
      walkCoords(geom.type, geom.coordinates, out)
    }
  }
  return out
}

const walkCoords = (geomType: string, coords: unknown, out: Array<[number, number]>): void => {
  if (geomType === 'Point' && Array.isArray(coords) && coords.length >= 2) {
    out.push([coords[1] as number, coords[0] as number])
    return
  }
  if (geomType === 'MultiPoint' || geomType === 'LineString') {
    if (Array.isArray(coords)) for (const c of coords) {
      if (Array.isArray(c) && c.length >= 2) out.push([c[1] as number, c[0] as number])
    }
    return
  }
  if (geomType === 'MultiLineString' || geomType === 'Polygon') {
    if (Array.isArray(coords)) for (const ring of coords) {
      if (Array.isArray(ring)) for (const c of ring) {
        if (Array.isArray(c) && c.length >= 2) out.push([c[1] as number, c[0] as number])
      }
    }
    return
  }
  if (geomType === 'MultiPolygon') {
    if (Array.isArray(coords)) for (const poly of coords) {
      if (Array.isArray(poly)) for (const ring of poly) {
        if (Array.isArray(ring)) for (const c of ring) {
          if (Array.isArray(c) && c.length >= 2) out.push([c[1] as number, c[0] as number])
        }
      }
    }
  }
}
