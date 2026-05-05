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
  // Room-aware filter. When provided, pack-sourced features are gated by
  // this set: a feature with `properties.source === 'pack'` is only
  // visible if its `properties.pack` is in `activePacks`. Non-pack sources
  // (local, discovered) are unaffected. Without this option, behavior is
  // unchanged from pre-pack-scoping (every pack feature is visible).
  readonly activePacks?: ReadonlySet<string>
}

// The local cascade source includes unverified entries — those are upstream
// results we cached previously (or agent-added points). Without this, every
// resolve would re-hammer Overpass/Nominatim because cached features carry
// verified:false. The agent-facing geo_lookup tool surfaces the source field
// in its result so callers can see "this came from the cache" without us
// having to hide unverified data from the resolver itself.
//
// activePacks is captured by the closure so the per-resolver source list
// stays the same shape; the filter applies post-lookup if a hit is from a
// pack the room hasn't activated.
const buildLocalSource = (activePacks?: ReadonlySet<string>): SourceFn => async (query, category) => {
  const hit = await lookupInCategory(category, query, { includeUnverified: true })
  if (!hit) return null
  if (!activePacks) return hit
  if (hit.properties.source !== 'pack') return hit
  const ns = hit.properties.pack
  if (ns && activePacks.has(ns)) return hit
  return null
}

export const resolveLocation = async (
  query: string,
  category: GeoCategory,
  opts: ResolverOptions = {},
): Promise<GeoLookupResult | null> => {
  const trimmed = query.trim()
  if (!trimmed) return null
  // Default cascade rebuilt per call when an activation filter is set —
  // closures over the filter aren't reusable across rooms with different
  // activation sets. Cheap (4 fn allocations); avoids leaking room
  // context into module-level state.
  const sources = opts.sources ?? [
    { name: 'local'     as GeoSource, fn: buildLocalSource(opts.activePacks) },
    { name: 'overpass'  as GeoSource, fn: lookupOverpass },
    { name: 'nominatim' as GeoSource, fn: lookupNominatim },
  ]
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
