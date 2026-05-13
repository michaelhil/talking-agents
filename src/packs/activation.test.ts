import { describe, expect, test } from 'bun:test'
import { effectiveActivePacks, effectiveActivePackSet, isPackActiveInRoom } from './activation.ts'

const room = (packs: string[]) => ({ getActivePacks: () => packs })

describe('effectiveActivePacks', () => {
  test('empty room → implicit packs only', () => {
    expect(effectiveActivePacks(room([]))).toEqual(['core', 'local', 'demos', 'pwr-ops'])
  })

  test('one explicit pack → implicit + pack', () => {
    expect(effectiveActivePacks(room(['aviation']))).toEqual(['core', 'local', 'demos', 'pwr-ops', 'aviation'])
  })

  test('preserves explicit order', () => {
    expect(effectiveActivePacks(room(['z', 'a', 'm']))).toEqual(['core', 'local', 'demos', 'pwr-ops', 'z', 'a', 'm'])
  })
})

describe('effectiveActivePackSet', () => {
  test('contains implicit + explicit', () => {
    const s = effectiveActivePackSet(room(['aviation']))
    expect(s.has('core')).toBe(true)
    expect(s.has('local')).toBe(true)
    expect(s.has('aviation')).toBe(true)
    expect(s.has('cafes')).toBe(false)
  })
})

describe('isPackActiveInRoom', () => {
  test('core/local always active', () => {
    expect(isPackActiveInRoom(room([]), 'core')).toBe(true)
    expect(isPackActiveInRoom(room([]), 'local')).toBe(true)
  })

  test('inactive pack → false', () => {
    expect(isPackActiveInRoom(room(['aviation']), 'cafes')).toBe(false)
  })

  test('active pack → true', () => {
    expect(isPackActiveInRoom(room(['aviation']), 'aviation')).toBe(true)
  })
})
