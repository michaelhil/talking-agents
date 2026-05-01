import { describe, expect, test } from 'bun:test'
import { createConcurrencyManager } from './concurrency.ts'

describe('ConcurrencyManager — getStartedAt', () => {
  test('undefined when idle', () => {
    const cm = createConcurrencyManager('agent-1')
    expect(cm.getStartedAt()).toBeUndefined()
    expect(cm.state.getStartedAt()).toBeUndefined()
  })

  test('returns a number after startGeneration', () => {
    const cm = createConcurrencyManager('agent-1')
    const before = Date.now()
    cm.startGeneration('room-a')
    const after = Date.now()
    const t = cm.getStartedAt()
    expect(t).toBeDefined()
    expect(t!).toBeGreaterThanOrEqual(before)
    expect(t!).toBeLessThanOrEqual(after)
    expect(cm.state.getStartedAt()).toBe(t!)
  })

  test('cleared after endGeneration', () => {
    const cm = createConcurrencyManager('agent-1')
    cm.startGeneration('room-a')
    expect(cm.getStartedAt()).toBeDefined()
    cm.endGeneration('room-a')
    expect(cm.getStartedAt()).toBeUndefined()
    expect(cm.state.getStartedAt()).toBeUndefined()
  })

  test('cleared after cancelAll', () => {
    const cm = createConcurrencyManager('agent-1')
    cm.startGeneration('room-a')
    expect(cm.getStartedAt()).toBeDefined()
    cm.cancelAll()
    expect(cm.getStartedAt()).toBeUndefined()
  })

  test('subscriber receives startedAt as 4th arg', () => {
    const cm = createConcurrencyManager('agent-1')
    const calls: Array<{ state: string; ctx?: string; ts?: number }> = []
    cm.state.subscribe((state, _id, context, startedAt) => {
      calls.push({ state, ctx: context, ts: startedAt })
    })
    cm.startGeneration('room-a')
    cm.notifyState('generating', 'room-a')
    cm.endGeneration('room-a')

    expect(calls.length).toBe(2)
    expect(calls[0]?.state).toBe('generating')
    expect(calls[0]?.ctx).toBe('room-a')
    expect(typeof calls[0]?.ts).toBe('number')
    // After endGeneration → notifyState('idle') → startedAt is already cleared.
    expect(calls[1]?.state).toBe('idle')
    expect(calls[1]?.ts).toBeUndefined()
  })
})
