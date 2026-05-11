// Tests for the map-registry specialisation. Verifies the leak fix:
// detached wrappers result in map.remove() calls via the generic sweep.
// Uses a fake LeafletMap (counter object) — no real Leaflet, no DOM
// beyond a minimal FakeWrapper with isConnected.

import { describe, test, expect } from 'bun:test'
import { createWrapperRegistry, type WrapperRegistry } from '../wrapper-registry/index.ts'
import type { LeafletMap } from './api.ts'
import { nextMapId } from './map-registry.ts'

interface FakeWrapper { isConnected: boolean }
const makeWrapper = (isConnected = true): FakeWrapper => ({ isConnected })

interface FakeMap {
  removeCalls: number
  remove: () => void
}
const makeMap = (behaviour: 'ok' | 'throws-second' = 'ok'): FakeMap => {
  const m: FakeMap = {
    removeCalls: 0,
    remove() {
      m.removeCalls += 1
      // Models Leaflet's non-idempotent Map.remove() — second call throws.
      if (behaviour === 'throws-second' && m.removeCalls > 1) {
        throw new Error('Map.remove() called twice')
      }
    },
  }
  return m
}

// Helper: build a test-scoped registry that mirrors mapRegistry's config
// but with an injected manual scheduler so tests can drive sweep ticks.
const makeTestMapRegistry = (): { reg: WrapperRegistry<LeafletMap>; tick: () => void } => {
  const callbacks: Array<() => void> = []
  const scheduler = {
    setInterval: (cb: () => void) => { callbacks.push(cb); return callbacks.length - 1 },
    clearInterval: (_h: unknown) => { /* no-op */ },
  }
  const reg = createWrapperRegistry<LeafletMap>({
    label: 'map-test',
    scheduler,
    disposeResource: async (m) => { try { m.remove() } catch { /* tolerate double-dispose */ } },
  })
  return { reg, tick: () => { for (const cb of callbacks) cb() } }
}

describe('map-registry: leak fix', () => {
  test('detached wrapper → sweep calls map.remove() exactly once', async () => {
    const { reg, tick } = makeTestMapRegistry()
    const m = makeMap()
    const w = makeWrapper(true) as unknown as HTMLElement
    reg.attach('map-1', m as unknown as LeafletMap, w)

    ;(w as unknown as FakeWrapper).isConnected = false
    tick()
    await new Promise<void>(resolve => setTimeout(resolve, 0))

    expect(m.removeCalls).toBe(1)
    expect(reg.get('map-1')).toBeNull()
  })

  test('two distinct maps → both removed on a single sweep', async () => {
    const { reg, tick } = makeTestMapRegistry()
    const m1 = makeMap(), m2 = makeMap()
    const w1 = makeWrapper(true) as unknown as HTMLElement
    const w2 = makeWrapper(true) as unknown as HTMLElement
    reg.attach('map-1', m1 as unknown as LeafletMap, w1)
    reg.attach('map-2', m2 as unknown as LeafletMap, w2)

    ;(w1 as unknown as FakeWrapper).isConnected = false
    ;(w2 as unknown as FakeWrapper).isConnected = false
    tick()
    await new Promise<void>(resolve => setTimeout(resolve, 0))

    expect(m1.removeCalls).toBe(1)
    expect(m2.removeCalls).toBe(1)
  })

  test('releaseAll("disconnect") removes every map', async () => {
    const { reg } = makeTestMapRegistry()
    const m1 = makeMap(), m2 = makeMap()
    const w = makeWrapper(true) as unknown as HTMLElement
    reg.attach('map-1', m1 as unknown as LeafletMap, w)
    reg.attach('map-2', m2 as unknown as LeafletMap, w)

    await reg.releaseAll('disconnect')
    expect(m1.removeCalls).toBe(1)
    expect(m2.removeCalls).toBe(1)
  })

  test('Leaflet-style non-idempotent remove() — sweep + release race tolerated', async () => {
    // Models the real Leaflet contract: second remove() throws. The
    // registry's get-then-delete in release() guarantees disposeResource
    // runs at most once per id, but the dispose itself swallows the
    // throw so a concurrent release wins gracefully.
    const { reg, tick } = makeTestMapRegistry()
    const m = makeMap('throws-second')
    const w = makeWrapper(true) as unknown as HTMLElement
    reg.attach('map-1', m as unknown as LeafletMap, w)

    ;(w as unknown as FakeWrapper).isConnected = false
    // Fire sweep + explicit release concurrently — neither should reject.
    const sweepP = (async () => { tick(); await new Promise<void>(resolve => setTimeout(resolve, 0)) })()
    const relP = reg.release('map-1', 'user')
    await Promise.all([sweepP, relP])

    // Disposed at most once (the registry's get-then-delete is the guard).
    expect(m.removeCalls).toBe(1)
  })
})

describe('map-registry: id allocation', () => {
  test('nextMapId() returns distinct ids on each call across the module', () => {
    // Module-scope counter regression test (Finding 1.5): per-call
    // counters could overlap and silently overwrite registry entries.
    const a = nextMapId()
    const b = nextMapId()
    const c = nextMapId()
    expect(a).not.toBe(b)
    expect(b).not.toBe(c)
    expect(a).not.toBe(c)
  })

  test('nextMapId() prefix is stable', () => {
    expect(nextMapId().startsWith('map-')).toBe(true)
  })
})
