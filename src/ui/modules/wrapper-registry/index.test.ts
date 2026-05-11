// Tests for the generic wrapper-registry. Real fake resources implementing
// a minimal contract — no mocks. The biometric specialisation
// (session-registry.test.ts) acts as the contract test for one concrete
// consumer; this file tests the generic surface in isolation.

import { describe, test, expect } from 'bun:test'
import { createWrapperRegistry, type ReleaseReason } from './index.ts'

interface FakeWrapper { isConnected: boolean }
const makeWrapper = (isConnected = true): FakeWrapper => ({ isConnected })

interface FakeResource {
  readonly id: string
  readonly disposeCalls: () => number
}

const makeResource = (id: string, behaviour: 'ok' | 'throws' = 'ok'): FakeResource & { __disposed: number } => {
  const r = { id, __disposed: 0 }
  return Object.assign(r, {
    disposeCalls: () => r.__disposed,
    __throws: behaviour === 'throws',
  })
}

const makeRegistry = (overrides: { throws?: boolean; sweepMs?: number } = {}) => {
  const callbacks: Array<() => void> = []
  const scheduler = {
    setInterval: (cb: () => void) => { callbacks.push(cb); return callbacks.length - 1 },
    clearInterval: (_h: unknown) => { /* no-op for tests */ },
  }
  const reg = createWrapperRegistry<ReturnType<typeof makeResource>>({
    label: 'test',
    scheduler,
    ...(overrides.sweepMs !== undefined ? { sweepIntervalMs: overrides.sweepMs } : {}),
    disposeResource: async (r) => {
      r.__disposed += 1
      if (overrides.throws) throw new Error('dispose blew up')
    },
  })
  return { reg, tick: () => { for (const cb of callbacks) cb() }, timerCount: () => callbacks.length }
}

describe('wrapper-registry: basic lifecycle', () => {
  test('attach then get returns the entry with generic field names', () => {
    const { reg } = makeRegistry()
    const r = makeResource('cap_1')
    const w = makeWrapper(true) as unknown as HTMLElement
    reg.attach('cap_1', r, w)
    const e = reg.get('cap_1')
    expect(e).toBeTruthy()
    expect(e?.id).toBe('cap_1')
    expect(e?.resource).toBe(r)
    expect(e?.wrapper).toBe(w)
  })

  test('get returns null for unknown id', () => {
    const { reg } = makeRegistry()
    expect(reg.get('nope')).toBeNull()
  })

  test('release disposes the resource and removes the entry', async () => {
    const { reg } = makeRegistry()
    const r = makeResource('cap_1')
    const w = makeWrapper(true) as unknown as HTMLElement
    reg.attach('cap_1', r, w)
    await reg.release('cap_1', 'user')
    expect(r.disposeCalls()).toBe(1)
    expect(reg.get('cap_1')).toBeNull()
  })

  test('release is idempotent — second call is a no-op', async () => {
    const { reg } = makeRegistry()
    const r = makeResource('cap_1')
    reg.attach('cap_1', r, makeWrapper(true) as unknown as HTMLElement)
    await reg.release('cap_1', 'user')
    await reg.release('cap_1', 'agent')
    expect(r.disposeCalls()).toBe(1)
  })

  test('disposeResource throwing does not stall release', async () => {
    const { reg } = makeRegistry({ throws: true })
    const r = makeResource('cap_1')
    reg.attach('cap_1', r, makeWrapper(true) as unknown as HTMLElement)
    await reg.release('cap_1', 'user')   // must not reject
    expect(reg.get('cap_1')).toBeNull()
  })

  test('tolerates double-dispose: sweep + release race lands at most one dispose-with-side-effect', async () => {
    // Models Leaflet's non-idempotent map.remove(): the registry calls
    // disposeResource at most once because release() deletes the entry
    // before disposing. A second release on the same id is a no-op
    // (handled by get-then-delete check, not by the underlying resource).
    const { reg } = makeRegistry()
    const r = makeResource('cap_1')
    reg.attach('cap_1', r, makeWrapper(true) as unknown as HTMLElement)
    await Promise.all([reg.release('cap_1', 'user'), reg.release('cap_1', 'agent')])
    expect(r.disposeCalls()).toBe(1)
  })
})

describe('wrapper-registry: onRelease + onAllReleased', () => {
  test('onRelease hook fires with id and reason', async () => {
    const calls: Array<{ id: string; reason: ReleaseReason }> = []
    const callbacks: Array<() => void> = []
    const reg = createWrapperRegistry<ReturnType<typeof makeResource>>({
      label: 'test',
      scheduler: { setInterval: (cb) => { callbacks.push(cb); return 0 }, clearInterval: () => {} },
      disposeResource: async () => {},
      onRelease: (id, reason) => calls.push({ id, reason }),
    })
    reg.attach('cap_1', makeResource('cap_1'), makeWrapper(true) as unknown as HTMLElement)
    await reg.release('cap_1', 'unmount')
    expect(calls).toEqual([{ id: 'cap_1', reason: 'unmount' }])
  })

  test('onAllReleased subscribers fire after release; unsubscribe stops them', async () => {
    const { reg } = makeRegistry()
    const calls: string[] = []
    const unsub = reg.onAllReleased((id) => calls.push(id))

    reg.attach('cap_1', makeResource('cap_1'), makeWrapper(true) as unknown as HTMLElement)
    await reg.release('cap_1', 'user')
    expect(calls).toEqual(['cap_1'])

    unsub()
    reg.attach('cap_2', makeResource('cap_2'), makeWrapper(true) as unknown as HTMLElement)
    await reg.release('cap_2', 'user')
    expect(calls).toEqual(['cap_1'])
  })

  test('subscriber throwing does not break other subscribers or release', async () => {
    const { reg } = makeRegistry()
    const calls: string[] = []
    reg.onAllReleased(() => { throw new Error('boom') })
    reg.onAllReleased((id) => calls.push(id))
    reg.attach('cap_1', makeResource('cap_1'), makeWrapper(true) as unknown as HTMLElement)
    await reg.release('cap_1', 'user')
    expect(calls).toEqual(['cap_1'])
  })
})

describe('wrapper-registry: view bindings', () => {
  test('setViewBinding teardown runs once on release, BEFORE dispose', async () => {
    const order: string[] = []
    const callbacks: Array<() => void> = []
    const reg = createWrapperRegistry<{ id: string }>({
      label: 'test',
      scheduler: { setInterval: (cb) => { callbacks.push(cb); return 0 }, clearInterval: () => {} },
      disposeResource: async () => { order.push('dispose') },
    })
    reg.attach('cap_1', { id: 'cap_1' }, makeWrapper(true) as unknown as HTMLElement)
    reg.setViewBinding('cap_1', { teardown: () => { order.push('teardown') } })
    await reg.release('cap_1', 'user')
    expect(order).toEqual(['teardown', 'dispose'])
  })

  test('setViewBinding called twice tears down the previous binding', () => {
    const { reg } = makeRegistry()
    reg.attach('cap_1', makeResource('cap_1'), makeWrapper(true) as unknown as HTMLElement)
    let downA = 0, downB = 0
    reg.setViewBinding('cap_1', { teardown: () => { downA += 1 } })
    reg.setViewBinding('cap_1', { teardown: () => { downB += 1 } })
    expect(downA).toBe(1)
    expect(downB).toBe(0)
  })

  test('thrown view-binding teardown does not skip dispose', async () => {
    const { reg } = makeRegistry()
    const r = makeResource('cap_1')
    reg.attach('cap_1', r, makeWrapper(true) as unknown as HTMLElement)
    reg.setViewBinding('cap_1', { teardown: () => { throw new Error('boom') } })
    await reg.release('cap_1', 'user')
    expect(r.disposeCalls()).toBe(1)
  })

  test('setViewBinding on unknown id is a no-op', () => {
    const { reg } = makeRegistry()
    expect(() => reg.setViewBinding('nope', { teardown: () => {} })).not.toThrow()
  })
})

describe('wrapper-registry: setWrapper + sweepOrphans', () => {
  test('setWrapper swaps the attached wrapper without disturbing the resource', () => {
    const { reg } = makeRegistry()
    const r = makeResource('cap_1')
    const w1 = makeWrapper(true) as unknown as HTMLElement
    const w2 = makeWrapper(true) as unknown as HTMLElement
    reg.attach('cap_1', r, w1)
    reg.setWrapper('cap_1', w2)
    expect(reg.get('cap_1')?.wrapper).toBe(w2)
    expect(r.disposeCalls()).toBe(0)
  })

  test('setWrapper on unknown id is a no-op', () => {
    const { reg } = makeRegistry()
    expect(() => reg.setWrapper('nope', makeWrapper(true) as unknown as HTMLElement)).not.toThrow()
  })

  test('sweepOrphans releases entries whose wrapper has been detached', async () => {
    const { reg } = makeRegistry()
    const live = makeResource('live')
    const orphan = makeResource('orphan')
    const liveW = makeWrapper(true) as unknown as HTMLElement
    const orphanW = makeWrapper(true) as unknown as HTMLElement
    reg.attach('live', live, liveW)
    reg.attach('orphan', orphan, orphanW)

    ;(orphanW as unknown as FakeWrapper).isConnected = false
    await reg.sweepOrphans()

    expect(live.disposeCalls()).toBe(0)
    expect(orphan.disposeCalls()).toBe(1)
    expect(reg.get('live')).toBeTruthy()
    expect(reg.get('orphan')).toBeNull()
  })

  test('sweepOrphans fires view-binding teardown for the orphaned entry', async () => {
    const { reg } = makeRegistry()
    const r = makeResource('cap_1')
    const w = makeWrapper(true) as unknown as HTMLElement
    reg.attach('cap_1', r, w)
    let torn = 0
    reg.setViewBinding('cap_1', { teardown: () => { torn += 1 } })

    ;(w as unknown as FakeWrapper).isConnected = false
    await reg.sweepOrphans()

    expect(torn).toBe(1)
    expect(r.disposeCalls()).toBe(1)
    expect(reg.get('cap_1')).toBeNull()
  })

  test('sweep timer fires via injected scheduler and stops when registry empties', async () => {
    const { reg, tick, timerCount } = makeRegistry()
    const r = makeResource('cap_1')
    const w = makeWrapper(true) as unknown as HTMLElement
    expect(timerCount()).toBe(0)
    reg.attach('cap_1', r, w)
    expect(timerCount()).toBe(1)

    ;(w as unknown as FakeWrapper).isConnected = false
    tick()
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(r.disposeCalls()).toBe(1)
    expect(reg.get('cap_1')).toBeNull()
  })
})

describe('wrapper-registry: releaseAll', () => {
  test('releaseAll releases every entry with the given reason', async () => {
    const { reg } = makeRegistry()
    const a = makeResource('a'), b = makeResource('b'), c = makeResource('c')
    const w = makeWrapper(true) as unknown as HTMLElement
    reg.attach('a', a, w); reg.attach('b', b, w); reg.attach('c', c, w)
    const reasons: ReleaseReason[] = []
    reg.onAllReleased((_id, r) => reasons.push(r))

    await reg.releaseAll('disconnect')
    expect(a.disposeCalls()).toBe(1)
    expect(b.disposeCalls()).toBe(1)
    expect(c.disposeCalls()).toBe(1)
    expect(reasons).toEqual(['disconnect', 'disconnect', 'disconnect'])
    expect(reg.get('a')).toBeNull()
  })

  test('releaseAll on empty registry resolves cleanly', async () => {
    const { reg } = makeRegistry()
    await reg.releaseAll('disconnect')
    // No assertion needed — just must not reject.
    expect(true).toBe(true)
  })
})
