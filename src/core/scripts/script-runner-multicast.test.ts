// nextSpeaker activation policy — addressing-driven with round-robin fallback.
// These tests exercise the pure function only; full runner integration is
// covered by the (broader) runner tests.

import { describe, test, expect } from 'bun:test'
import { __testNextSpeaker as nextSpeaker } from './script-runner.ts'

const cast2 = [{ name: 'Alex' }, { name: 'Sam' }]
const cast3 = [{ name: 'Alex' }, { name: 'Sam' }, { name: 'Carol' }]

describe('nextSpeaker — round-robin (no addressing)', () => {
  test('binary cast: A → B → A (preserves the prior otherCast behavior)', () => {
    expect(nextSpeaker(cast2, 'Alex', undefined)).toBe('Sam')
    expect(nextSpeaker(cast2, 'Sam', undefined)).toBe('Alex')
  })

  test('3-cast: cycles A → B → C → A', () => {
    expect(nextSpeaker(cast3, 'Alex', undefined)).toBe('Sam')
    expect(nextSpeaker(cast3, 'Sam', undefined)).toBe('Carol')
    expect(nextSpeaker(cast3, 'Carol', undefined)).toBe('Alex')
  })

  test('current name not in cast: falls back to first member', () => {
    expect(nextSpeaker(cast3, 'Ghost', undefined)).toBe('Alex')
  })
})

describe('nextSpeaker — addressing-driven', () => {
  test('valid addressing skips round-robin order', () => {
    // From Alex, round-robin would activate Sam. Addressing says Carol.
    expect(nextSpeaker(cast3, 'Alex', 'Carol')).toBe('Carol')
  })

  test('addressing valid + same as round-robin choice still works', () => {
    expect(nextSpeaker(cast3, 'Alex', 'Sam')).toBe('Sam')
  })

  test('invalid addressing falls back to round-robin', () => {
    expect(nextSpeaker(cast3, 'Alex', 'Ghost')).toBe('Sam')
  })

  test('self-addressing falls back to round-robin (avoids infinite-self-turn)', () => {
    expect(nextSpeaker(cast3, 'Alex', 'Alex')).toBe('Sam')
  })

  test('empty-string addressing falls back to round-robin', () => {
    expect(nextSpeaker(cast3, 'Alex', '')).toBe('Sam')
  })
})
