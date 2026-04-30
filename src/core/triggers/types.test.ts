import { describe, test, expect } from 'bun:test'
import {
  validateTriggerInput,
  computeDueTriggers,
  MIN_INTERVAL_SEC,
  MAX_INTERVAL_SEC,
  type Trigger,
  type AgentTriggerSnapshot,
} from './types.ts'

const validBody = (): Record<string, unknown> => ({
  name: 'Check vatsim',
  prompt: 'Check vatsim status and report changes.',
  mode: 'execute',
  intervalSec: 300,
  enabled: true,
  roomId: 'room-1',
})

describe('validateTriggerInput', () => {
  test('accepts a fully-valid AI execute body', () => {
    expect(validateTriggerInput(validBody(), 'ai')).toBeNull()
  })

  test('accepts post mode for human', () => {
    expect(validateTriggerInput({ ...validBody(), mode: 'post' }, 'human')).toBeNull()
  })

  test('rejects execute mode for human', () => {
    expect(validateTriggerInput(validBody(), 'human')).toMatch(/human/)
  })

  test('rejects empty name', () => {
    expect(validateTriggerInput({ ...validBody(), name: '   ' }, 'ai')).toMatch(/name/)
  })

  test('rejects empty prompt', () => {
    expect(validateTriggerInput({ ...validBody(), prompt: '' }, 'ai')).toMatch(/prompt/)
  })

  test('rejects missing roomId', () => {
    expect(validateTriggerInput({ ...validBody(), roomId: '' }, 'ai')).toMatch(/roomId/)
  })

  test('rejects intervalSec below minimum', () => {
    expect(validateTriggerInput({ ...validBody(), intervalSec: MIN_INTERVAL_SEC - 1 }, 'ai')).toMatch(/intervalSec/)
  })

  test('accepts intervalSec at the minimum', () => {
    expect(validateTriggerInput({ ...validBody(), intervalSec: MIN_INTERVAL_SEC }, 'ai')).toBeNull()
  })

  test('rejects intervalSec above maximum', () => {
    expect(validateTriggerInput({ ...validBody(), intervalSec: MAX_INTERVAL_SEC + 1 }, 'ai')).toMatch(/intervalSec/)
  })

  test('rejects unknown mode', () => {
    expect(validateTriggerInput({ ...validBody(), mode: 'sing' }, 'ai')).toMatch(/mode/)
  })

  test('rejects non-numeric intervalSec', () => {
    expect(validateTriggerInput({ ...validBody(), intervalSec: 'fast' }, 'ai')).toMatch(/intervalSec/)
  })
})

const mkTrigger = (overrides: Partial<Trigger> = {}): Trigger => ({
  id: overrides.id ?? 't1',
  name: 'check',
  prompt: 'do the thing',
  mode: 'execute',
  intervalSec: 60,
  enabled: true,
  roomId: 'r1',
  ...overrides,
})

describe('computeDueTriggers', () => {
  const agent = (id: string, isBusy: boolean, triggers: Trigger[]): AgentTriggerSnapshot => ({
    agentId: id, isBusy, triggers,
  })

  test('fires when lastFiredAt undefined and agent idle', () => {
    const due = computeDueTriggers([agent('a', false, [mkTrigger()])], 1_000_000)
    expect(due).toEqual([{ agentId: 'a', triggerId: 't1' }])
  })

  test('skips disabled triggers', () => {
    const due = computeDueTriggers([agent('a', false, [mkTrigger({ enabled: false })])], 1_000_000)
    expect(due).toHaveLength(0)
  })

  test('skips when agent is busy', () => {
    const due = computeDueTriggers([agent('a', true, [mkTrigger()])], 1_000_000)
    expect(due).toHaveLength(0)
  })

  test('skips triggers not yet due', () => {
    // Just fired 30s ago, interval 60s → not due
    const due = computeDueTriggers(
      [agent('a', false, [mkTrigger({ lastFiredAt: 970_000 })])],
      1_000_000,
    )
    expect(due).toHaveLength(0)
  })

  test('fires triggers exactly at the boundary', () => {
    // Last fired 60_000ms ago + 60s interval = due at exactly now
    const due = computeDueTriggers(
      [agent('a', false, [mkTrigger({ lastFiredAt: 940_000 })])],
      1_000_000,
    )
    expect(due).toHaveLength(1)
  })

  test('returns one entry per due trigger across multiple agents', () => {
    const due = computeDueTriggers([
      agent('a', false, [mkTrigger({ id: 't1' })]),
      agent('b', false, [mkTrigger({ id: 't2' })]),
      agent('c', true,  [mkTrigger({ id: 't3' })]), // busy → skipped
    ], 1_000_000)
    expect(due.map(d => d.triggerId).sort()).toEqual(['t1', 't2'])
  })
})
