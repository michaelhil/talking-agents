// Map registry — owns LeafletMap instances outside the DOM wrapper that
// holds them, closing a real leak: previous code created `L.map(container)`
// and never called `.remove()`. When the chat re-rendered a message or the
// geodata panel was closed/reopened, the Leaflet instance kept its DOM
// listeners, tile-load callbacks, and internal references alive — slow
// growth in the hundreds of KB per dropped map.
//
// This is a thin specialisation of src/ui/modules/wrapper-registry/index.ts.
// Lifecycle semantics live there; this module supplies only:
//   - the LeafletMap-specific disposal (map.remove())
//   - a module-scope id counter (nextMapId) — per-call counters could
//     produce overlapping ids that collide in entries.set() across
//     re-renders, silently dropping a map's resource without disposing.
//
// Worst-case bound: sweep runs every 2000 ms (same as biometrics, so
// timing is consistent across registries). A chat re-render that detaches
// N map wrappers between ticks holds up to N Leaflet instances (~100 KB
// each) until the next tick. Acceptable: bound is small in practice, and
// a tighter sweep would burn CPU on idle pages.
//
// No releaseAll wiring on page-unload (unlike biometrics): the biometric
// listeners exist to release a real OS resource (the camera). Leaflet
// instances are pure in-page state; browser GC handles them on a real
// page unload. The registry's only job here is in-page detach cases.
//
// Two sweep timers run when both biometric + map registries are active.
// Trivial cost; documented for symmetry with biometric/session-registry.ts.

import { createWrapperRegistry, type WrapperRegistry } from '../wrapper-registry/index.ts'
import type { LeafletMap } from './api.ts'

// Module-scope counter — see Finding 1.5 in the wrapper-registry stress-test.
let mapIdCounter = 0
export const nextMapId = (): string => `map-${++mapIdCounter}`

export type MapRegistry = WrapperRegistry<LeafletMap>

export const mapRegistry: MapRegistry = createWrapperRegistry<LeafletMap>({
  label: 'map',
  // Leaflet's Map.remove() is NOT idempotent — calling it twice throws.
  // The registry's get-then-delete ensures release() runs at most once
  // per id, but sweep and an explicit release could still race
  // (sweep ticks while a Stop handler is in flight). Swallow inside
  // dispose so the race is harmless.
  disposeResource: async (m) => { try { m.remove() } catch { /* tolerate double-dispose */ } },
})
