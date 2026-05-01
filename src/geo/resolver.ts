// Resolver cascade — local → bundled → Overpass → Nominatim. Strict-match
// per source: each returns null unless it has a canonical-form name match
// or alias match. First non-null wins.
//
// Successful upstream resolutions write back to the local store with
// verified:false so subsequent lookups for the same query short-circuit
// at the local layer. Dedup key: (category, canonical(name)).
//
// Configurable cascade for tests (and possible future user override) —
// the resolver accepts a SourceList and walks them in order. The default
// list is what production uses.

import { lookupInCategory, upsertFeature } from './store.ts'
import { lookupNominatim, lookupOverpass } from './upstream.ts'
import type { GeoCategory, GeoFeature, GeoLookupResult, GeoSource } from './types.ts'

export type SourceFn = (query: string, category: GeoCategory) => Promise<GeoFeature | null>

export interface ResolverOptions {
  readonly sources?: ReadonlyArray<{ readonly name: GeoSource; readonly fn: SourceFn }>
  readonly cacheUpstream?: boolean    // default true: write upstream hits back to local
}

// The local cascade source includes unverified entries — those are upstream
// results we cached previously (or agent-added points). Without this, every
// resolve would re-hammer Overpass/Nominatim because cached features carry
// verified:false. The agent-facing geo_lookup tool surfaces the source field
// in its result so callers can see "this came from the cache" without us
// having to hide unverified data from the resolver itself.
const localSource: SourceFn = async (query, category) =>
  lookupInCategory(category, query, { includeUnverified: true })

const DEFAULT_SOURCES: ReadonlyArray<{ name: GeoSource; fn: SourceFn }> = [
  { name: 'local',     fn: localSource },
  { name: 'overpass',  fn: lookupOverpass },
  { name: 'nominatim', fn: lookupNominatim },
]

export const resolveLocation = async (
  query: string,
  category: GeoCategory,
  opts: ResolverOptions = {},
): Promise<GeoLookupResult | null> => {
  const trimmed = query.trim()
  if (!trimmed) return null
  const sources = opts.sources ?? DEFAULT_SOURCES
  const cacheUpstream = opts.cacheUpstream !== false

  for (const src of sources) {
    let hit: GeoFeature | null = null
    try {
      hit = await src.fn(trimmed, category)
    } catch (err) {
      // Upstream errors are not fatal — log and continue cascade. The hard
      // daily-cap throw from Nominatim does propagate by design (see
      // upstream.ts), so the agent gets a clear "we're rate limited"
      // signal instead of silent fallthrough.
      if (err instanceof Error && /daily cap/.test(err.message)) throw err
      console.warn(`[geo/resolver] ${src.name} threw:`, err instanceof Error ? err.message : err)
    }
    if (hit) {
      if (cacheUpstream && (src.name === 'overpass' || src.name === 'nominatim')) {
        // Fire-and-forget. The write is mutex-serialized so concurrent
        // resolves of the same query produce one stored feature.
        void upsertFeature(hit).catch((e) => {
          console.warn('[geo/resolver] upstream cache write failed:', e instanceof Error ? e.message : e)
        })
      }
      return { features: [hit], source: src.name }
    }
  }
  return null
}
