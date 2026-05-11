// Pure-TS unit tests for the session registry. No DOM, no MediaPipe, no
// real getUserMedia — the registry is provider-agnostic (it accepts any
// CaptureSession). We pass a real factory-function implementation of
// CaptureSession that records stop() calls. Same "real interface with
// controlled behavior" pattern as makeStubGateway in biometric-flow.test.ts;
// not a mock.
//
// The "wrapper" only needs an isConnected boolean for the sweeper. We
// build a minimal object literal that satisfies that surface.

import { describe, test, expect } from 'bun:test'
import { createSessionRegistry, type ReleaseReason } from './session-registry.ts'
import type { CaptureSession, BiometricSignal } from '../../../biometrics/index.ts'

interface FakeWrapper {
  isConnected: boolean
}

const makeWrapper = (isConnected = true): FakeWrapper => ({ isConnected })

interface TrackingSession extends CaptureSession {
  readonly stopCalls: () => number
}

const makeSession = (): TrackingSession => {
  let stopCount = 0
  return {
    start: async () => {},
    read: (): BiometricSignal | null => null,
    stop: async () => { stopCount += 1 },
    onError: () => () => {},
    stopCalls: () => stopCount,
  }
}

// Manual scheduler — tests drive the sweep tick explicitly so the registry
// timer logic doesn't bleed real wall-clock time into the assertions.
const makeManualScheduler = () => {
  const callbacks: Array<() => void> = []
  return {
    scheduler: {
      setInterval: (cb: () => void) => { callbacks.push(cb); return callbacks.length - 1 },
      clearInterval: (_h: unknown) => { /* no-op for tests */ },
    },
    tick: () => { for (const cb of callbacks) cb() },
    timerCount: () => callbacks.length,
  }
}

describe('session registry', () => {
  test('attach then get returns the entry', () => {
    const reg = createSessionRegistry()
    const session = makeSession()
    const wrapper = makeWrapper(true) as unknown as HTMLElement
    reg.attach('cap_1', session, wrapper)
    const entry = reg.get('cap_1')
    expect(entry).toBeTruthy()
    expect(entry?.captureId).toBe('cap_1')
    expect(entry?.session).toBe(session)
    expect(entry?.attachedWrapper).toBe(wrapper)
  })

  test('get returns null for unknown captureId', () => {
    const reg = createSessionRegistry()
    expect(reg.get('nope')).toBeNull()
  })

  test('release stops the session and removes the entry', async () => {
    const reg = createSessionRegistry()
    const session = makeSession()
    const wrapper = makeWrapper(true) as unknown as HTMLElement
    reg.attach('cap_1', session, wrapper)

    await reg.release('cap_1', 'user')
    expect(session.stopCalls()).toBe(1)
    expect(reg.get('cap_1')).toBeNull()
  })

  test('release is idempotent — second call is a no-op', async () => {
    const reg = createSessionRegistry()
    const session = makeSession()
    const wrapper = makeWrapper(true) as unknown as HTMLElement
    reg.attach('cap_1', session, wrapper)

    await reg.release('cap_1', 'user')
    await reg.release('cap_1', 'agent')   // already gone — no second stop()
    expect(session.stopCalls()).toBe(1)
  })

  test('release invokes onRelease hook with reason', async () => {
    const calls: Array<{ captureId: string; reason: ReleaseReason }> = []
    const reg = createSessionRegistry({ onRelease: (captureId, reason) => calls.push({ captureId, reason }) })
    const session = makeSession()
    const wrapper = makeWrapper(true) as unknown as HTMLElement
    reg.attach('cap_1', session, wrapper)

    await reg.release('cap_1', 'unmount')
    expect(calls).toEqual([{ captureId: 'cap_1', reason: 'unmount' }])
  })

  test('setWrapper swaps the attached wrapper without disturbing the session', () => {
    const reg = createSessionRegistry()
    const session = makeSession()
    const w1 = makeWrapper(true) as unknown as HTMLElement
    const w2 = makeWrapper(true) as unknown as HTMLElement
    reg.attach('cap_1', session, w1)
    reg.setWrapper('cap_1', w2)
    expect(reg.get('cap_1')?.attachedWrapper).toBe(w2)
    expect(session.stopCalls()).toBe(0)
  })

  test('setWrapper on unknown captureId is a no-op', () => {
    const reg = createSessionRegistry()
    expect(() => reg.setWrapper('nope', makeWrapper(true) as unknown as HTMLElement)).not.toThrow()
  })

  test('sweepOrphans releases sessions whose wrapper is no longer connected', async () => {
    const reg = createSessionRegistry()
    const liveSession = makeSession()
    const orphanSession = makeSession()
    const liveWrapper = makeWrapper(true) as unknown as HTMLElement
    const orphanWrapper = makeWrapper(true) as unknown as HTMLElement

    reg.attach('cap_live', liveSession, liveWrapper)
    reg.attach('cap_orphan', orphanSession, orphanWrapper)

    // Detach the orphan's wrapper — simulates the chat re-render removing
    // the wrapper from the DOM during/after session.start() resolved.
    ;(orphanWrapper as unknown as FakeWrapper).isConnected = false

    await reg.sweepOrphans()

    expect(liveSession.stopCalls()).toBe(0)
    expect(orphanSession.stopCalls()).toBe(1)
    expect(reg.get('cap_live')).toBeTruthy()
    expect(reg.get('cap_orphan')).toBeNull()
  })

  test('sweep timer fires via injected scheduler and stops when registry empties', async () => {
    const { scheduler, tick, timerCount } = makeManualScheduler()
    const reg = createSessionRegistry({ scheduler })
    const session = makeSession()
    const wrapper = makeWrapper(true) as unknown as HTMLElement

    expect(timerCount()).toBe(0)
    reg.attach('cap_1', session, wrapper)
    expect(timerCount()).toBe(1)

    // Detach wrapper, drive a sweep tick — orphan should be released.
    ;(wrapper as unknown as FakeWrapper).isConnected = false
    tick()
    // sweep is async; settle the microtask queue.
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(session.stopCalls()).toBe(1)
    expect(reg.get('cap_1')).toBeNull()
  })

  test('setViewBinding teardown runs once on release, before session.stop', async () => {
    const order: string[] = []
    const session: CaptureSession = {
      start: async () => {},
      read: () => null,
      stop: async () => { order.push('stop') },
      onError: () => () => {},
    }
    const reg = createSessionRegistry()
    const wrapper = makeWrapper(true) as unknown as HTMLElement
    reg.attach('cap_1', session, wrapper)
    reg.setViewBinding('cap_1', { teardown: () => { order.push('teardown') } })

    await reg.release('cap_1', 'user')
    expect(order).toEqual(['teardown', 'stop'])
  })

  test('setViewBinding called twice tears down the previous binding', () => {
    const reg = createSessionRegistry()
    const session = makeSession()
    const wrapper = makeWrapper(true) as unknown as HTMLElement
    reg.attach('cap_1', session, wrapper)
    let downA = 0, downB = 0
    reg.setViewBinding('cap_1', { teardown: () => { downA += 1 } })
    reg.setViewBinding('cap_1', { teardown: () => { downB += 1 } })
    // First binding torn down by the swap; second still live (release runs it).
    expect(downA).toBe(1)
    expect(downB).toBe(0)
  })

  test('thrown view-binding teardown does not skip session.stop', async () => {
    const reg = createSessionRegistry()
    const session = makeSession()
    const wrapper = makeWrapper(true) as unknown as HTMLElement
    reg.attach('cap_1', session, wrapper)
    reg.setViewBinding('cap_1', { teardown: () => { throw new Error('boom') } })

    await reg.release('cap_1', 'user')
    expect(session.stopCalls()).toBe(1)
  })

  test('releaseAll releases every entry with the given reason', async () => {
    const reg = createSessionRegistry()
    const a = makeSession(), b = makeSession(), c = makeSession()
    const w = makeWrapper(true) as unknown as HTMLElement
    reg.attach('a', a, w)
    reg.attach('b', b, w)
    reg.attach('c', c, w)
    const reasons: ReleaseReason[] = []
    reg.onAllReleased((_id, r) => reasons.push(r))

    await reg.releaseAll('disconnect')
    expect(a.stopCalls()).toBe(1)
    expect(b.stopCalls()).toBe(1)
    expect(c.stopCalls()).toBe(1)
    expect(reasons).toEqual(['disconnect', 'disconnect', 'disconnect'])
  })

  test('onAllReleased subscribers fire on each release; unsubscribe stops them', async () => {
    const reg = createSessionRegistry()
    const calls: string[] = []
    const unsub = reg.onAllReleased((id) => calls.push(id))

    const session = makeSession()
    const wrapper = makeWrapper(true) as unknown as HTMLElement
    reg.attach('cap_1', session, wrapper)
    await reg.release('cap_1', 'user')
    expect(calls).toEqual(['cap_1'])

    unsub()
    reg.attach('cap_2', makeSession(), wrapper)
    await reg.release('cap_2', 'user')
    expect(calls).toEqual(['cap_1'])      // no second push after unsubscribe
  })

  test('sweepOrphans fires view-binding teardown for the orphaned session', async () => {
    const reg = createSessionRegistry()
    const session = makeSession()
    const wrapper = makeWrapper(true) as unknown as HTMLElement
    reg.attach('cap_1', session, wrapper)
    let torn = 0
    reg.setViewBinding('cap_1', { teardown: () => { torn += 1 } })

    ;(wrapper as unknown as FakeWrapper).isConnected = false
    await reg.sweepOrphans()

    expect(torn).toBe(1)
    expect(session.stopCalls()).toBe(1)
    expect(reg.get('cap_1')).toBeNull()
  })

  test('session.stop() throwing does not stall release', async () => {
    const reg = createSessionRegistry()
    const session: CaptureSession = {
      start: async () => {},
      read: () => null,
      stop: async () => { throw new Error('teardown blew up') },
      onError: () => () => {},
    }
    const wrapper = makeWrapper(true) as unknown as HTMLElement
    reg.attach('cap_1', session, wrapper)

    await reg.release('cap_1', 'user')   // must not reject
    expect(reg.get('cap_1')).toBeNull()
  })
})
