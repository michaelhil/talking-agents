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
// Cost: one disk read of wikis.json + one discovery call (cached 5 min).
// Trivially cheap for the failure mode it prevents.
// ============================================================================

import type { WikiRegistry } from './registry.ts'
import type { MergedWikiEntryWithSource } from './store.ts'
import type { DiscoveredWiki } from './discovery.ts'
import { loadWikiStore, mergeWithDiscovery } from './store.ts'
import { getAvailableWikis } from './discovery.ts'

export const resolveActiveWikis = async (
  storePath: string,
  registry: WikiRegistry,
): Promise<ReadonlyArray<MergedWikiEntryWithSource>> => {
  const { data: store } = await loadWikiStore(storePath)
  let discovered: ReadonlyArray<DiscoveredWiki> = []
  try { discovered = await getAvailableWikis() } catch { /* discovery failures are non-fatal */ }
  const merged = mergeWithDiscovery(store, discovered)
  registry.reconcile(merged.filter((w) => w.enabled))
  return merged
}
