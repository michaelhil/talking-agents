// Renderer-facing thin wrapper over the canonical map schema.
//
// The schema, validator, and tolerant JSON parser all live in
// src/core/types/map.ts. This module exists to:
//   - re-export the renderer-facing names (preserves call sites)
//   - bridge the old `ParsedMap`/`MapEnvelope`-via-this-file imports until
//     all UI call sites migrate to the canonical module directly
//
// Rendering changes vs the previous design:
//   - GeoJSON is normalized to envelope at parse time (no more
//     `kind: 'geojson'` rendering branch)
//   - Unknown marker icons now produce a structured error, not a silent
//     fallback to default pin
//   - `parseMapSource(source)` keeps its name as the renderer entry point
//     but internally calls `parseMapBody` from core/types/map.ts

export {
  MARKER_ICONS,
  isMarkerIcon,
  type MarkerIcon,
  type MapView,
  type MapFeature,
  type MapEnvelope,
  type MapValidationError,
  type ValidatedMap,
  parseMapBody,
  validateMapEnvelope,
  formatMapErrors,
  collectEnvelopeLatLngs,
  truncateForDisplay,
} from '../../../core/types/map.ts'

// Backwards-compatible alias for the existing renderer `EnvelopeFeature`
// name. New code should use `MapFeature` from core/types/map.ts.
export type { MapFeature as EnvelopeFeature } from '../../../core/types/map.ts'

import {
  parseMapBody,
  collectEnvelopeLatLngs,
  type MapEnvelope,
  type ValidatedMap,
} from '../../../core/types/map.ts'

// Result type the renderer's existing call sites use. Wraps `ValidatedMap`
// in the historical `kind:` shape so buildMap doesn't have to change.
export type ParsedMap =
  | { kind: 'envelope'; data: MapEnvelope }
  | { kind: 'invalid'; reason: string }

// Renderer entry point. Bridges to the canonical parser + flattens the
// validation result into the kind-tagged shape buildMap expects.
export const parseMapSource = (source: string): ParsedMap => {
  const r = parseMapBody(source)
  if (r.ok === true) return { kind: 'envelope', data: r.envelope }
  // Explicit cast is purely a TS narrowing aid — the runtime value is
  // already known to have `errors` because `r.ok === false`.
  const errors = (r as Extract<ValidatedMap, { ok: false }>).errors
  const reason = errors.length === 1
    ? (errors[0]!.path ? `${errors[0]!.path}: ${errors[0]!.message}` : errors[0]!.message)
    : errors.map(e => e.path ? `${e.path}: ${e.message}` : e.message).join('; ')
  return { kind: 'invalid', reason }
}

// Backwards-compatible: collectLatLngs used to handle both envelope and
// GeoJSON branches. Now everything is normalized to envelope, so this is
// a thin pass-through.
export const collectLatLngs = (parsed: Extract<ParsedMap, { kind: 'envelope' }>): Array<[number, number]> =>
  collectEnvelopeLatLngs(parsed.data)
