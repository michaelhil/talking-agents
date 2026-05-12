// Bundled demo tool — live VATSIM traffic arriving at a given airport.
//
// VATSIM publishes one global JSON datafeed at data.vatsim.net/v3/. It's
// ~5 MB, refreshed every 15 s. We fetch and cache the whole thing once
// per 15-second window (module-level cache); each call filters client-
// side by ICAO. Caching the WHOLE feed (not per-ICAO) avoids redundant
// 5 MB downloads when one demo runs in parallel across colleagues.
//
// Defensive failure: if the datafeed is unreachable, the tool returns
// success: false with a clear, user-facing error string. The agent's
// persona instructs it to relay that one sentence to the user and stop —
// no opaque stack trace, no infinite retry loop.

import type { Tool, ToolResult } from '../../../core/types/tool.ts'
import { fetchWithTimeout } from '../../../core/fetch-utils.ts'

interface VatsimPilot {
  readonly callsign?: string
  readonly latitude?: number
  readonly longitude?: number
  readonly altitude?: number
  readonly flight_plan?: {
    readonly departure?: string
    readonly arrival?: string
    readonly aircraft_short?: string
  }
}

interface VatsimFeed {
  readonly pilots: ReadonlyArray<VatsimPilot>
}

const VATSIM_URL = 'https://data.vatsim.net/v3/vatsim-data.json'
const CACHE_TTL_MS = 15_000
const FETCH_TIMEOUT_MS = 8_000

interface CacheEntry {
  readonly fetchedAt: number
  readonly data: VatsimFeed
}

let cache: CacheEntry | null = null
let inflight: Promise<VatsimFeed> | null = null

const fetchFeed = async (): Promise<VatsimFeed> => {
  const now = Date.now()
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache.data
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const res = await fetchWithTimeout(VATSIM_URL, { headers: { 'User-Agent': 'samsinn-demo-vatsim' } }, FETCH_TIMEOUT_MS)
      if (!res.ok) throw new Error(`VATSIM datafeed returned HTTP ${res.status}`)
      const body = await res.json() as VatsimFeed
      if (!Array.isArray(body.pilots)) throw new Error('VATSIM datafeed missing pilots array')
      cache = { fetchedAt: Date.now(), data: body }
      return body
    } finally {
      inflight = null
    }
  })()
  return inflight
}

const buildMapFence = (pilots: ReadonlyArray<VatsimPilot>, icao: string): string => {
  const features = pilots.map(p => {
    const fp = p.flight_plan ?? {}
    const dep = fp.departure ?? '?'
    const arr = fp.arrival ?? icao
    const ac = fp.aircraft_short ? ` · ${fp.aircraft_short}` : ''
    return {
      type: 'marker',
      lat: p.latitude!,
      lng: p.longitude!,
      label: `${p.callsign ?? '?'} · ${dep} → ${arr}${ac}`,
      icon: 'plane',
    }
  })
  return '```map\n' + JSON.stringify({ features }, null, 2) + '\n```'
}

export const vatsimArrivalsTool: Tool = {
  name: 'vatsim_arrivals',
  description:
    'Returns a ```map fenced block of live VATSIM pilots whose filed flight plan terminates at the given ICAO airport. ' +
    'Paste the fence verbatim. If the tool reports an error, relay the one-line error to the user and stop.',
  usage: 'Pass `icao` as a 4-letter ICAO code (e.g. EGLL for London Heathrow, KJFK for JFK). Cached 15 s per global fetch.',
  returns: 'A markdown string containing a ```map fenced block, or an error message.',
  parameters: {
    type: 'object',
    properties: {
      icao: {
        type: 'string',
        description: '4-letter ICAO airport code (case-insensitive)',
      },
    },
    required: ['icao'],
    additionalProperties: false,
  },
  execute: async (params): Promise<ToolResult> => {
    const rawIcao = typeof params.icao === 'string' ? params.icao.trim().toUpperCase() : ''
    if (!/^[A-Z]{4}$/.test(rawIcao)) {
      return { success: false, error: `icao must be a 4-letter code (got "${params.icao}")` }
    }
    try {
      const feed = await fetchFeed()
      const matches = feed.pilots.filter(p =>
        p.flight_plan?.arrival?.toUpperCase() === rawIcao &&
        typeof p.latitude === 'number' &&
        typeof p.longitude === 'number',
      )
      if (matches.length === 0) {
        return { success: true, data: `No live VATSIM traffic currently inbound to ${rawIcao}.` }
      }
      return { success: true, data: buildMapFence(matches, rawIcao) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        success: false,
        error: `VATSIM datafeed unreachable: ${msg}. Try again in a minute — the feed refreshes every 15 s.`,
      }
    }
  },
}
