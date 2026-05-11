// Generic wrapper-registry — owns a long-lived resource (T) outside the DOM
// wrapper that displays it. Two consumers today:
//
//   biometrics (createSessionRegistry) — T = CaptureSession
//   map        (mapRegistry)           — T = LeafletMap
//
// Why outside the DOM wrapper: chat re-renders detach wrappers without
// warning. A camera left attached to a detached <video> keeps the MediaStream
// alive (orphaned camera light). A Leaflet map left attached to a detached
// container keeps its DOM listeners + tile callbacks + internal refs alive
// (slow growth, hundreds of KB per dropped map). Owning the resource here
// means we can sweep on a timer: any entry whose wrapper is no longer in
// the document gets disposed.
//
// Lifecycle invariants:
//   - attach(id, resource, wrapper) — fresh registration. starts the sweep
//     timer (lazy) on first attach.
//   - setWrapper(id, wrapper) — wrapper swap on re-mount; resource keeps
//     running. Used by biometrics when markdown re-renders a fenced block.
//   - setViewBinding(id, {teardown}) — optional. View-side teardown (e.g.
//     timers, listeners) the registry runs BEFORE disposeResource on
//     release. Replacing the binding tears down the previous one first.
//     Biometrics uses this; map ignores it (uniform surface beats divergent
//     APIs — Finding 3.5 from the stress-test).
//   - release(id, reason) — SOLE chokepoint that disposes a resource.
//     Ordering: viewBinding.teardown (try/swallow) → disposeResource
//     (try/swallow) → onRelease config hook → onAllReleased subscribers.
//     Independent try-blocks so a thrown teardown can't skip disposal.
//   - releaseAll(reason) — release every entry; replaces open-coded
//     fan-out loops in callers.
//   - sweepOrphans() — release any entry whose wrapper is no longer in
//     the document. The unconditional safety net: regardless of which
//     mutation event fires (or doesn't), the next sweep tick cleans up.
//
// Two sweep timers run when both biometric + map registries are active.
// Trivial cost; mentioned so a future reader doesn't think it's a bug.

export type ReleaseReason = 'user' | 'agent' | 'unmount' | 'disconnect' | 'error'

export interface ViewBinding {
  readonly teardown: () => void
}

export interface RegistryEntry<T> {
  readonly id: string
  readonly resource: T
  readonly wrapper: HTMLElement | null
}

export interface WrapperRegistry<T> {
  readonly get: (id: string) => RegistryEntry<T> | null
  readonly attach: (id: string, resource: T, wrapper: HTMLElement) => void
  readonly setWrapper: (id: string, wrapper: HTMLElement) => void
  readonly setViewBinding: (id: string, binding: ViewBinding) => void
  readonly release: (id: string, reason: ReleaseReason) => Promise<void>
  readonly releaseAll: (reason: ReleaseReason) => Promise<void>
  readonly sweepOrphans: () => Promise<void>
  readonly onAllReleased: (cb: (id: string, reason: ReleaseReason) => void) => () => void
}

export interface WrapperRegistryConfig<T> {
  // Per-subsystem teardown of the resource itself. Forced async (one
  // contract). disposeResource must tolerate being called when the
  // resource is in any state — including already-disposed — because
  // sweep and explicit release can race. Swallow throws inside the
  // implementation rather than relying on the registry's try/catch
  // for cleanliness; the registry's swallow is the last-line guarantee.
  readonly disposeResource: (resource: T) => Promise<void>

  // Optional per-release side effect (e.g. send a WS message).
  // Runs AFTER disposeResource, BEFORE onAllReleased subscribers.
  readonly onRelease?: (id: string, reason: ReleaseReason) => void

  // Test seam — production uses globalThis.setInterval.
  readonly scheduler?: {
    readonly setInterval: (cb: () => void, ms: number) => unknown
    readonly clearInterval: (handle: unknown) => void
  }

  // Default 2000. Tighter intervals burn CPU on idle pages.
  readonly sweepIntervalMs?: number

  // Debug label for console traces ('biometric', 'map', ...).
  readonly label?: string
}

const DEFAULT_SWEEP_INTERVAL_MS = 2000

export const createWrapperRegistry = <T>(config: WrapperRegistryConfig<T>): WrapperRegistry<T> => {
  interface Entry {
    resource: T
    wrapper: HTMLElement | null
    viewBinding: ViewBinding | null
  }
  const entries = new Map<string, Entry>()
  const subscribers = new Set<(id: string, reason: ReleaseReason) => void>()
  const scheduler = config.scheduler ?? {
    setInterval: (cb, ms) => globalThis.setInterval(cb, ms),
    clearInterval: (h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>),
  }
  const sweepIntervalMs = config.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS
  const label = config.label ?? 'wrapper'
  let sweepHandle: unknown = null

  const ensureSweeper = (): void => {
    if (sweepHandle !== null) return
    sweepHandle = scheduler.setInterval(() => { void registry.sweepOrphans() }, sweepIntervalMs)
  }
  const stopSweeperIfEmpty = (): void => {
    if (entries.size === 0 && sweepHandle !== null) {
      scheduler.clearInterval(sweepHandle)
      sweepHandle = null
    }
  }

  const registry: WrapperRegistry<T> = {
    get: (id) => {
      const e = entries.get(id)
      return e ? { id, resource: e.resource, wrapper: e.wrapper } : null
    },
    attach: (id, resource, wrapper) => {
      entries.set(id, { resource, wrapper, viewBinding: null })
      ensureSweeper()
      console.debug(`[${label}:lifecycle] attach`, { id })
    },
    setWrapper: (id, wrapper) => {
      const e = entries.get(id)
      if (!e) return
      e.wrapper = wrapper
      console.debug(`[${label}:lifecycle] setWrapper`, { id })
    },
    setViewBinding: (id, binding) => {
      const e = entries.get(id)
      if (!e) return
      // Replace: tear down the previous binding first so a re-mount that
      // rewires fresh timers doesn't leak the old ones.
      if (e.viewBinding) {
        try { e.viewBinding.teardown() } catch { /* ignore */ }
      }
      e.viewBinding = binding
    },
    release: async (id, reason) => {
      const e = entries.get(id)
      if (!e) return
      entries.delete(id)
      console.debug(`[${label}:lifecycle] release`, { id, reason })
      // Independent try-blocks so a thrown teardown can't skip disposal.
      try { e.viewBinding?.teardown() } catch { /* ignore */ }
      try { await config.disposeResource(e.resource) } catch { /* always swallow — release must complete */ }
      try { config.onRelease?.(id, reason) } catch { /* ignore */ }
      for (const cb of subscribers) {
        try { cb(id, reason) } catch { /* ignore — one subscriber's bug can't break others */ }
      }
      stopSweeperIfEmpty()
    },
    releaseAll: async (reason) => {
      // Snapshot ids before iterating so release() mutating the map is safe.
      const ids = [...entries.keys()]
      for (const id of ids) {
        await registry.release(id, reason)
      }
    },
    sweepOrphans: async () => {
      const orphans: string[] = []
      for (const [id, e] of entries) {
        if (e.wrapper && !e.wrapper.isConnected) orphans.push(id)
      }
      for (const id of orphans) {
        console.debug(`[${label}:lifecycle] sweep released`, { id, reason: 'unmount' })
        await registry.release(id, 'unmount')
      }
    },
    onAllReleased: (cb) => {
      subscribers.add(cb)
      return () => subscribers.delete(cb)
    },
  }

  return registry
}
