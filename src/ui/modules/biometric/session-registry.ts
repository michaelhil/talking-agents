// Tab-scoped registry of live biometric capture sessions, keyed by
// captureId. The MediaStream AND the widget's view-side timers are owned
// here — outside the DOM widget — so re-renders, room switches, and any
// other event that detaches the widget wrapper cannot orphan a camera OR
// leave phantom signal-push timers ticking against a dead session.
//
// Lifecycle invariants:
//   - attach() registers a freshly-started session with its wrapper.
//   - setWrapper() swaps the attached wrapper on widget re-mount (the
//     fenced block was re-parsed by markdown and a new wrapper element
//     took the old one's place). The session keeps streaming; no
//     re-consent, no second getUserMedia.
//   - setViewBinding() stores a teardown callback alongside the session.
//     Calling it again replaces (and tears down) the previous binding,
//     so a re-mount that rewires fresh timers doesn't leak the old ones.
//   - release() is the SOLE chokepoint that stops a session. It runs the
//     view-binding's teardown FIRST (in its own try/catch so a thrown
//     teardown can't prevent session.stop()), then stops the session,
//     then fires the onRelease hook, then fans out to onAllReleased
//     subscribers. Idempotent.
//   - releaseAll() iterates and releases — replaces the three open-coded
//     fan-out loops that previously walked _entries() from widget.ts.
//   - sweepOrphans() releases any session whose wrapper has been detached.
//     This is what makes the leak structurally impossible — no matter
//     which mutation event fires (or doesn't), the next sweep tick stops
//     the camera AND the view-side timers.
//
// The registry is tab-scoped. Cross-tab claim resolution still happens
// over WS via biometric_capture_claimed broadcast.

import type { CaptureSession } from '../../../biometrics/index.ts'

export type ReleaseReason = 'user' | 'agent' | 'unmount' | 'disconnect' | 'error'

export interface LiveSession {
  readonly captureId: string
  readonly session: CaptureSession
  readonly attachedWrapper: HTMLElement | null
}

export interface ViewBinding {
  readonly teardown: () => void
}

export interface SessionRegistry {
  readonly get: (captureId: string) => LiveSession | null
  readonly attach: (captureId: string, session: CaptureSession, wrapper: HTMLElement) => void
  readonly setWrapper: (captureId: string, wrapper: HTMLElement) => void
  readonly setViewBinding: (captureId: string, binding: ViewBinding) => void
  readonly release: (captureId: string, reason: ReleaseReason) => Promise<void>
  readonly releaseAll: (reason: ReleaseReason) => Promise<void>
  readonly sweepOrphans: () => Promise<void>
  // Multi-subscriber notification fired after each release completes.
  // Returns an unsubscribe.
  readonly onAllReleased: (cb: (captureId: string, reason: ReleaseReason) => void) => () => void
}

const SWEEP_INTERVAL_MS = 2000

export interface SessionRegistryConfig {
  // Optional override for tests — when null, sweepOrphans() can still be
  // driven manually. Production uses setInterval.
  readonly scheduler?: {
    readonly setInterval: (cb: () => void, ms: number) => unknown
    readonly clearInterval: (handle: unknown) => void
  }
  // Optional onRelease hook used by the widget to send a WS stopped
  // message. Decoupled from the registry so the registry has no WS
  // dependency and stays unit-testable.
  readonly onRelease?: (captureId: string, reason: ReleaseReason) => void
}

export const createSessionRegistry = (config: SessionRegistryConfig = {}): SessionRegistry => {
  interface Entry {
    session: CaptureSession
    wrapper: HTMLElement | null
    viewBinding: ViewBinding | null
  }
  const entries = new Map<string, Entry>()
  const subscribers = new Set<(captureId: string, reason: ReleaseReason) => void>()
  const scheduler = config.scheduler ?? {
    setInterval: (cb, ms) => globalThis.setInterval(cb, ms),
    clearInterval: (h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>),
  }
  let sweepHandle: unknown = null

  const ensureSweeper = (): void => {
    if (sweepHandle !== null) return
    sweepHandle = scheduler.setInterval(() => { void registry.sweepOrphans() }, SWEEP_INTERVAL_MS)
  }
  const stopSweeperIfEmpty = (): void => {
    if (entries.size === 0 && sweepHandle !== null) {
      scheduler.clearInterval(sweepHandle)
      sweepHandle = null
    }
  }

  const registry: SessionRegistry = {
    get: (captureId) => {
      const e = entries.get(captureId)
      return e ? { captureId, session: e.session, attachedWrapper: e.wrapper } : null
    },
    attach: (captureId, session, wrapper) => {
      entries.set(captureId, { session, wrapper, viewBinding: null })
      ensureSweeper()
      console.debug('[biometric:lifecycle] attach', { captureId })
    },
    setWrapper: (captureId, wrapper) => {
      const e = entries.get(captureId)
      if (!e) return
      e.wrapper = wrapper
      console.debug('[biometric:lifecycle] setWrapper', { captureId })
    },
    setViewBinding: (captureId, binding) => {
      const e = entries.get(captureId)
      if (!e) return
      // Replace: tear down the previous binding's timers/listeners before
      // overwriting. Re-mount paths rely on this to clean up the prior
      // wrapper's intervals when the second wrapper rewires fresh ones.
      if (e.viewBinding) {
        try { e.viewBinding.teardown() } catch { /* ignore */ }
      }
      e.viewBinding = binding
    },
    release: async (captureId, reason) => {
      const e = entries.get(captureId)
      if (!e) return
      entries.delete(captureId)
      console.debug('[biometric:lifecycle] release', { captureId, reason })
      // Order matters: view-binding teardown FIRST (independent try/catch
      // so a thrown teardown can't skip session.stop), THEN session.stop,
      // THEN the config hook + subscribers.
      try { e.viewBinding?.teardown() } catch { /* ignore */ }
      try { await e.session.stop() } catch { /* always swallow — release must complete */ }
      try { config.onRelease?.(captureId, reason) } catch { /* ignore */ }
      for (const cb of subscribers) {
        try { cb(captureId, reason) } catch { /* ignore — one subscriber's bug can't break others */ }
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
        console.debug('[biometric:lifecycle] sweep released', { captureId: id, reason: 'unmount' })
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
