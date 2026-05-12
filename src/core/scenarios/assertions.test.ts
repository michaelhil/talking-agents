import { describe, expect, test } from 'bun:test'
import { assertDemoIsHandsFree } from './assertions.ts'
import type { Scenario } from './types.ts'

const baseScenario = (overrides: Partial<Scenario>): Scenario => ({
  id: 'demos/x',
  pack: 'demos',
  name: 'x',
  title: 'X',
  source: '',
  narration: '',
  ops: [],
  ...overrides,
})

describe('assertDemoIsHandsFree', () => {
  test('passes when category is not demo even with click waits', () => {
    const s = baseScenario({
      category: 'tutorial',
      ops: [
        { kind: 'guide-tooltip', line: 5, selector: 'textarea', body: 'click me', waitFor: { type: 'click' } },
      ],
    })
    expect(() => assertDemoIsHandsFree(s)).not.toThrow()
  })

  test('passes when category is demo and no click waits exist', () => {
    const s = baseScenario({
      category: 'demo',
      ops: [
        { kind: 'create-room', line: 1, name: 'R' },
        { kind: 'guide-toast', line: 2, body: 'done' },
      ],
    })
    expect(() => assertDemoIsHandsFree(s)).not.toThrow()
  })

  test('passes when category is demo with timer-wait guides', () => {
    const s = baseScenario({
      category: 'demo',
      ops: [
        { kind: 'guide-modal', line: 3, title: 't', body: 'b', waitFor: { type: 'timer', seconds: 2 } },
      ],
    })
    expect(() => assertDemoIsHandsFree(s)).not.toThrow()
  })

  test('throws when a demo uses guide-tooltip waitFor: click', () => {
    const s = baseScenario({
      category: 'demo',
      ops: [
        { kind: 'guide-tooltip', line: 7, selector: '#x', body: 'click', waitFor: { type: 'click' } },
      ],
    })
    expect(() => assertDemoIsHandsFree(s)).toThrow(/category: demo/)
    expect(() => assertDemoIsHandsFree(s)).toThrow(/line 7/)
  })

  test('throws when a demo uses guide-modal waitFor: click', () => {
    const s = baseScenario({
      category: 'demo',
      ops: [
        { kind: 'guide-modal', line: 12, title: 't', body: 'b', waitFor: { type: 'click' } },
      ],
    })
    expect(() => assertDemoIsHandsFree(s)).toThrow(/guide-modal/)
  })

  test('passes when category is undefined (defaults safely)', () => {
    const s = baseScenario({
      ops: [
        { kind: 'guide-tooltip', line: 1, selector: '#x', body: 'click', waitFor: { type: 'click' } },
      ],
    })
    expect(() => assertDemoIsHandsFree(s)).not.toThrow()
  })
})
