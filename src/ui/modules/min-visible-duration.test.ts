import { describe, expect, test } from 'bun:test'
import { computeMinVisibleDecision, type MinVisibleEntry } from './min-visible-duration.ts'

const MIN_MS = 400

describe('computeMinVisibleDecision', () => {
  test('new id in visible set → toCreate', () => {
    const d = computeMinVisibleDecision(new Map(), new Set(['a']), 1000, MIN_MS)
    expect(d.toCreate).toEqual(['a'])
    expect(d.toRemoveImmediately).toEqual([])
    expect(d.toScheduleRemove).toEqual([])
  })

  test('existing id still visible → no-op', () => {
    const cur = new Map<string, MinVisibleEntry>([['a', { createdAt: 1000 }]])
    const d = computeMinVisibleDecision(cur, new Set(['a']), 1500, MIN_MS)
    expect(d.toCreate).toEqual([])
    expect(d.toRemoveImmediately).toEqual([])
    expect(d.toScheduleRemove).toEqual([])
    expect(d.toCancelRemoval).toEqual([])
  })

  test('existing id left set, hold elapsed → toRemoveImmediately', () => {
    const cur = new Map<string, MinVisibleEntry>([['a', { createdAt: 1000 }]])
    const d = computeMinVisibleDecision(cur, new Set(), 1500, MIN_MS)
    expect(d.toRemoveImmediately).toEqual(['a'])
    expect(d.toScheduleRemove).toEqual([])
  })

  test('existing id left set, hold not elapsed → toScheduleRemove with remaining ms', () => {
    const cur = new Map<string, MinVisibleEntry>([['a', { createdAt: 1000 }]])
    const d = computeMinVisibleDecision(cur, new Set(), 1100, MIN_MS)
    expect(d.toScheduleRemove).toEqual([{ id: 'a', delayMs: 300 }])
    expect(d.toRemoveImmediately).toEqual([])
  })

  test('id with pending removal comes back into set → toCancelRemoval', () => {
    const cur = new Map<string, MinVisibleEntry>([
      ['a', { createdAt: 1000, pendingRemovalHandle: 42 }],
    ])
    const d = computeMinVisibleDecision(cur, new Set(['a']), 1100, MIN_MS)
    expect(d.toCancelRemoval).toEqual(['a'])
    expect(d.toCreate).toEqual([])
  })

  test('id already pending removal stays pending if still not visible', () => {
    const cur = new Map<string, MinVisibleEntry>([
      ['a', { createdAt: 1000, pendingRemovalHandle: 42 }],
    ])
    const d = computeMinVisibleDecision(cur, new Set(), 1100, MIN_MS)
    // Already scheduled — don't reschedule, don't remove.
    expect(d.toScheduleRemove).toEqual([])
    expect(d.toRemoveImmediately).toEqual([])
    expect(d.toCancelRemoval).toEqual([])
  })

  test('mix: one new, one leaving with hold remaining, one stable', () => {
    const cur = new Map<string, MinVisibleEntry>([
      ['stable', { createdAt: 500 }],
      ['leaving', { createdAt: 900 }],
    ])
    const d = computeMinVisibleDecision(cur, new Set(['stable', 'new']), 1000, MIN_MS)
    expect(d.toCreate).toEqual(['new'])
    expect(d.toScheduleRemove).toEqual([{ id: 'leaving', delayMs: 300 }])
    expect(d.toRemoveImmediately).toEqual([])
    expect(d.toCancelRemoval).toEqual([])
  })

  test('boundary: remaining = 0 → toRemoveImmediately', () => {
    const cur = new Map<string, MinVisibleEntry>([['a', { createdAt: 1000 }]])
    const d = computeMinVisibleDecision(cur, new Set(), 1400, MIN_MS)
    expect(d.toRemoveImmediately).toEqual(['a'])
  })
})
