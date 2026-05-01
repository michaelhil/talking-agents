// Tests $visibleThinkingIndicators by driving the underlying $agents and
// $selectedRoomId stores. nanostores' computed atoms recalculate eagerly on
// dependency change, so we can read the result synchronously.

import { describe, expect, test, beforeEach } from 'bun:test'
import { $agents, $selectedRoomId, $visibleThinkingIndicators } from './stores.ts'

beforeEach(() => {
  $agents.set({})
  $selectedRoomId.set(null)
})

describe('$visibleThinkingIndicators', () => {
  test('empty when no room selected', () => {
    $agents.set({
      a1: { id: 'a1', name: 'A', kind: 'ai', state: 'generating', context: 'r1', generationStarted: 100 },
    })
    $selectedRoomId.set(null)
    expect($visibleThinkingIndicators.get()).toEqual([])
  })

  test('agent generating in selected room → one entry', () => {
    $agents.set({
      a1: { id: 'a1', name: 'A', kind: 'ai', state: 'generating', context: 'r1', generationStarted: 100 },
    })
    $selectedRoomId.set('r1')
    const out = $visibleThinkingIndicators.get()
    expect(out.length).toBe(1)
    expect(out[0]).toEqual({ agentId: 'a1', agentName: 'A', startedAt: 100 })
  })

  test('agent generating in OTHER room → zero entries', () => {
    $agents.set({
      a1: { id: 'a1', name: 'A', kind: 'ai', state: 'generating', context: 'r2', generationStarted: 100 },
    })
    $selectedRoomId.set('r1')
    expect($visibleThinkingIndicators.get()).toEqual([])
  })

  test('idle agent → zero entries', () => {
    $agents.set({
      a1: { id: 'a1', name: 'A', kind: 'ai', state: 'idle', context: 'r1' },
    })
    $selectedRoomId.set('r1')
    expect($visibleThinkingIndicators.get()).toEqual([])
  })

  test('missing generationStarted falls back to a number (defensive)', () => {
    $agents.set({
      a1: { id: 'a1', name: 'A', kind: 'ai', state: 'generating', context: 'r1' },
    })
    $selectedRoomId.set('r1')
    const out = $visibleThinkingIndicators.get()
    expect(out.length).toBe(1)
    expect(typeof out[0]?.startedAt).toBe('number')
  })

  test('multiple agents — only the one in selected room shows', () => {
    $agents.set({
      a1: { id: 'a1', name: 'A', kind: 'ai', state: 'generating', context: 'r1', generationStarted: 100 },
      a2: { id: 'a2', name: 'B', kind: 'ai', state: 'generating', context: 'r2', generationStarted: 200 },
      a3: { id: 'a3', name: 'C', kind: 'ai', state: 'idle' },
    })
    $selectedRoomId.set('r1')
    const out = $visibleThinkingIndicators.get()
    expect(out.length).toBe(1)
    expect(out[0]?.agentId).toBe('a1')
  })

  test('switching rooms updates the result', () => {
    $agents.set({
      a1: { id: 'a1', name: 'A', kind: 'ai', state: 'generating', context: 'r1', generationStarted: 100 },
      a2: { id: 'a2', name: 'B', kind: 'ai', state: 'generating', context: 'r2', generationStarted: 200 },
    })
    $selectedRoomId.set('r1')
    expect($visibleThinkingIndicators.get().map(i => i.agentId)).toEqual(['a1'])
    $selectedRoomId.set('r2')
    expect($visibleThinkingIndicators.get().map(i => i.agentId)).toEqual(['a2'])
  })
})
