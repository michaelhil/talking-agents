// Upstream lookups — Nominatim and Overpass.
//
// Both are public services run by volunteers. Two non-negotiables:
//   1. Polite UA + email contact (USER_AGENT below).
//   2. Per-process rate limiting + a hard daily cap that throws on exceed
//      rather than silently spamming the upstream until we get IP-banned.
//
// Strict-match rule: each function returns null unless the upstream answer
// has a canonical-form name match against the original query. This is the
// core of the cascade design — a partial answer should not short-circuit
// further sources.

import { canonical } from './canonical.ts'
import type { GeoCategory, GeoFeature, GeoSource } from './types.ts'

const USER_AGENT = 'samsinn/1.0 (multi-agent research assistant; mhilde@gmail.com)'

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search'
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
] as const

const NOMINATIM_DAILY_CAP = 10_000
const NOMINATIM_MIN_INTERVAL_MS = 1_100   // ≤ 1 req/s with a tiny buffer
const FETCH_TIMEOUT_MS = 10_000

// ============================================================================
// Per-process Nominatim queue + daily counter.
// ============================================================================

let lastNominatimAt = 0
let nominatimToday = 0
let dailyResetAt = startOfNextDay(Date.now())

function startOfNextDay(now: number): number {
  const d = new Date(now)
  d.setUTCHours(24, 0, 0, 0)
  return d.getTime()
}

const nominatimGate = async (): Promise<void> => {
  const now = Date.now()
  if (now >= dailyResetAt) {
    nominatimToday = 0
    dailyResetAt = startOfNextDay(now)
  }
  if (nominatimToday >= NOMINATIM_DAILY_CAP) {
    throw new Error('Nominatim daily cap (10000) exceeded for this process')
  }
  const wait = lastNominatimAt + NOMINATIM_MIN_INTERVAL_MS - now
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastNominatimAt = Date.now()
  nominatimToday++
}

const fetchWithTimeout = async (url: string, init?: RequestInit): Promise<Response> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { ...(init?.headers ?? {}), 'User-Agent': USER_AGENT },
    })
  } finally {
    clearTimeout(timer)
  }
}

// ============================================================================
// Nominatim — free-text place search.
// ============================================================================

interface NominatimHit {
  readonly display_name: string
  readonly name?: string
  readonly lat: string
  readonly lon: string
  readonly importance?: number
  readonly osm_id?: number
  readonly type?: string
  readonly class?: string
  readonly address?: Record<string, string>
}

const buildNominatimFeature = (
  hit: NominatimHit,
  query: string,
  category: GeoCategory,
): GeoFeature => {
  const lat = parseFloat(hit.lat)
  const lng = parseFloat(hit.lon)
  const name = hit.name ?? hit.display_name.split(',')[0]?.trim() ?? query
  const id = `nominatim-${hit.osm_id ?? canonical(name)}`
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lng, lat] },
    properties: {
      id,
      name,
      category,
      verified: false,
      source: 'nominatim',
      added_by: 'agent',
      added_at: new Date().toISOString(),
      ...(hit.address?.country_code ? { country: hit.address.country_code.toUpperCase() } : {}),
      ...(hit.type ? { subcategory: hit.type } : {}),
    },
  }
}

export const lookupNominatim = async (
  query: string,
  category: GeoCategory,
): Promise<GeoFeature | null> => {
  await nominatimGate()
  const url = new URL(NOMINATIM_URL)
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  url.searchParams.set('limit', '5')
  url.searchParams.set('addressdetails', '1')
  const res = await fetchWithTimeout(url.toString())
  if (!res.ok) return null
  const hits = await res.json() as ReadonlyArray<NominatimHit>
  if (!Array.isArray(hits) || hits.length === 0) return null
  // Strict-match: scan hits for one whose canonical name == canonical query.
  // If none match, return null — the resolver tries the next source.
  const key = canonical(query)
  for (const hit of hits) {
    const candidates = [hit.name, hit.display_name.split(',')[0]?.trim()].filter(Boolean) as string[]
    if (candidates.some((c) => canonical(c) === key)) {
      return buildNominatimFeature(hit, query, category)
    }
  }
  return null
}

// ============================================================================
// Overpass — category-tagged OSM queries (airports, cities, platforms, etc.)
// ============================================================================

let overpassMirrorIdx = 0
const nextOverpassMirror = (): string => {
  const m = OVERPASS_MIRRORS[overpassMirrorIdx % OVERPASS_MIRRORS.length]!
  overpassMirrorIdx++
  return m
}

interface OverpassElement {
  readonly type: 'node' | 'way' | 'relation'
  readonly id: number
  readonly lat?: number
  readonly lon?: number
  readonly center?: { lat: number; lon: number }
  readonly tags?: Record<string, string>
}

interface OverpassResponse {
  readonly elements: ReadonlyArray<OverpassElement>
}

const overpassQueryFor = (category: GeoCategory, query: string): string | null => {
  // Escape regex specials in the name so Overpass treats it literally.
  const safe = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  switch (category) {
    case 'airport':
      return `[out:json][timeout:10]; (node[aeroway=aerodrome][name~"^${safe}$",i]; way[aeroway=aerodrome][name~"^${safe}$",i];); out center 5;`
    case 'city':
      return `[out:json][timeout:10]; (node[place~"^(city|town)$"][name~"^${safe}$",i];); out 5;`
    case 'offshore-platform':
      return `[out:json][timeout:10]; (node[man_made=offshore_platform][name~"^${safe}$",i]; way[man_made=offshore_platform][name~"^${safe}$",i];); out center 5;`
    case 'landmark':
      return `[out:json][timeout:10]; (node[tourism][name~"^${safe}$",i]; node[historic][name~"^${safe}$",i];); out 5;`
    default:
      return null
  }
}

const elementCoords = (el: OverpassElement): [number, number] | null => {
  if (typeof el.lat === 'number' && typeof el.lon === 'number') return [el.lon, el.lat]
  if (el.center) return [el.center.lon, el.center.lat]
  return null
}

const buildOverpassFeature = (
  el: OverpassElement,
  query: string,
  category: GeoCategory,
): GeoFeature | null => {
  const coords = elementCoords(el)
  if (!coords) return null
  const tags = el.tags ?? {}
  const name = tags.name ?? query
  const aliases: string[] = []
  if (tags['name:en']) aliases.push(tags['name:en']!)
  if (tags.iata) aliases.push(tags.iata!)
  if (tags.icao) aliases.push(tags.icao!)
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: coords },
    properties: {
      id: `overpass-${el.type}-${el.id}`,
      name,
      ...(aliases.length > 0 ? { aliases } : {}),
      category,
      verified: false,
      source: 'overpass' as GeoSource,
      added_by: 'agent',
      added_at: new Date().toISOString(),
      ...(tags.iata ? { iata: tags.iata } : {}),
      ...(tags.icao ? { icao: tags.icao } : {}),
      ...(tags.operator ? { operator: tags.operator } : {}),
      ...(tags['addr:country'] ? { country: tags['addr:country'].toUpperCase() } : {}),
    },
  }
}

export const lookupOverpass = async (
  query: string,
  category: GeoCategory,
): Promise<GeoFeature | null> => {
  const q = overpassQueryFor(category, query)
  if (!q) return null
  const url = nextOverpassMirror()
  let res: Response
  try {
    res = await fetchWithTimeout(url, {
      method: 'POST',
      body: `data=${encodeURIComponent(q)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
  } catch {
    return null
  }
  if (!res.ok) return null
  const body = await res.json() as OverpassResponse
  if (!Array.isArray(body.elements) || body.elements.length === 0) return null
  const key = canonical(query)
  for (const el of body.elements) {
    const tags = el.tags ?? {}
    const candidates = [tags.name, tags['name:en'], tags.iata, tags.icao].filter(Boolean) as string[]
    if (candidates.some((c) => canonical(c) === key)) {
      const f = buildOverpassFeature(el, query, category)
      if (f) return f
    }
  }
  return null
}

// Test-only — reset the rate limiter state.
export const __resetUpstreamGates = (): void => {
  lastNominatimAt = 0
  nominatimToday = 0
  dailyResetAt = startOfNextDay(Date.now())
  overpassMirrorIdx = 0
}
