// ============================================================================
// resolveActiveWikis — single source of truth for "what wikis are active right
// now" across the server. Replaces the boot-once-then-drift pattern that
// caused the v0.9.x wiki refresh bug (registry frozen at boot, discovery
// changes later, hasWiki(id) returns false on user click → 404).
//
// Every consumer that needs the active set — REST routes, agent tools,
// background warmers — should go through this function. The registry's
// internal state (per-wiki adapter + page cache) is reconciled on each call,
// so callers never observe a stale id-set.
//
// Failure plumbing: returns `{ items, failures }`. Discovery errors are
// non-fatal (we still reconcile from the on-disk store) but they ARE
// surfaced — callers/UI render them as a warning so empty lists are never
// silently confused with "rate-limited GitHub call." Earlier versions
// caught-and-discarded discovery failures here; that was the outermost
// silent-fail layer on the wiki path.
//
// Cost: one disk read of wikis.json + one discovery call (cached 5 min in
// success; not cached on empty-with-failure so a token set after rate-limit
// unblocks immediately).
// ============================================================================

import type { WikiRegistry } from './registry.ts'
import type { MergedWikiEntryWithSource } from './store.ts'
import { loadWikiStore, mergeWithDiscovery } from './store.ts'
import { getAvailableWikis } from './discovery.ts'
import type { DiscoveryFailure } from '../core/github-discovery.ts'

export interface ResolveActiveResult {
  readonly items: ReadonlyArray<MergedWikiEntryWithSource>
  readonly failures: ReadonlyArray<DiscoveryFailure>
}

export const resolveActiveWikis = async (
  storePath: string,
  registry: WikiRegistry,
  options: {
    readonly discoverySources?: ReadonlyArray<string>
    readonly storedToken?: string
  } = {},
): Promise<ResolveActiveResult> => {
  const { data: store } = await loadWikiStore(storePath)
  let discovered: Awaited<ReturnType<typeof getAvailableWikis>> = { items: [], failures: [] }
  try {
    discovered = await getAvailableWikis({
      ...(options.discoverySources ? { storedSources: options.discoverySources } : {}),
      ...(options.storedToken !== undefined ? { storedToken: options.storedToken } : {}),
    })
  } catch (err) {
    // Unexpected throw (not a structured HTTP failure) — surface as a
    // synthetic failure entry so callers still see something actionable.
    discovered = {
      items: [],
      failures: [{
        source: 'getAvailableWikis',
        status: 0,
        reason: 'network',
        message: err instanceof Error ? err.message : String(err),
      }],
    }
  }
  const merged = mergeWithDiscovery(store, discovered.items)
  registry.reconcile(merged.filter((w) => w.enabled))
  return { items: merged, failures: discovered.failures }
}
