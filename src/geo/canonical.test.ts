import { describe, expect, test } from 'bun:test'
import { canonical } from './canonical.ts'

describe('canonical', () => {
  test('strips diacritics', () => {
    expect(canonical('São Paulo')).toBe('sao paulo')
    expect(canonical('Zürich')).toBe('zurich')
    expect(canonical('Ålesund')).toBe('alesund')   // å is NFD-decomposable
  })

  test('explicit base-letter folds', () => {
    expect(canonical('Tromsø')).toBe('tromso')
    expect(canonical('København')).toBe('kobenhavn')
    expect(canonical('Bærum')).toBe('baerum')
    expect(canonical('Straße')).toBe('strasse')
  })

  test('lowercases', () => {
    expect(canonical('BERGEN')).toBe('bergen')
    expect(canonical('Oslo')).toBe('oslo')
  })

  test('collapses whitespace', () => {
    expect(canonical('  ENGM  ')).toBe('engm')
    expect(canonical('Karl  Johans   gate')).toBe('karl johans gate')
    expect(canonical('\tBergen\n')).toBe('bergen')
  })

  test('preserves punctuation', () => {
    expect(canonical('St. Louis')).toBe('st. louis')
    expect(canonical('Bergen, Norway')).toBe('bergen, norway')
  })

  test('idempotent', () => {
    const once = canonical('Tromsø')
    expect(canonical(once)).toBe(once)
  })

  test('empty / whitespace input', () => {
    expect(canonical('')).toBe('')
    expect(canonical('   ')).toBe('')
  })
})
