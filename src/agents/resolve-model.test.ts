import { describe, expect, test } from 'bun:test'
import { resolveEffectiveModel } from './resolve-model.ts'

const inSet = (set: ReadonlyArray<string>) => (m: string) => set.includes(m)

describe('resolveEffectiveModel', () => {
  test('preferred is available → use it, no fallback', () => {
    const out = resolveEffectiveModel('groq:llama-3.3-70b-versatile', inSet(['groq:llama-3.3-70b-versatile', 'gemini:gemini-2.5-flash-lite']), 'gemini:gemini-2.5-flash-lite')
    expect(out.model).toBe('groq:llama-3.3-70b-versatile')
    expect(out.fallback).toBe(false)
    expect(out.reason).toBe('preferred_available')
  })

  test('preferred is unavailable → fall back', () => {
    const out = resolveEffectiveModel('anthropic:claude-haiku-4-5', inSet(['groq:llama-3.3-70b-versatile']), 'groq:llama-3.3-70b-versatile')
    expect(out.model).toBe('groq:llama-3.3-70b-versatile')
    expect(out.fallback).toBe(true)
    expect(out.reason).toBe('preferred_unavailable')
  })

  test('preferred is blank → use fallback', () => {
    const out = resolveEffectiveModel('', inSet(['groq:llama-3.3-70b-versatile']), 'groq:llama-3.3-70b-versatile')
    expect(out.model).toBe('groq:llama-3.3-70b-versatile')
    expect(out.fallback).toBe(true)
    expect(out.reason).toBe('preferred_blank')
  })

  test('preferred unavailable AND no fallback → return preferred (let LLM call fail with typed error)', () => {
    const out = resolveEffectiveModel('anthropic:claude-haiku-4-5', inSet([]), '')
    expect(out.model).toBe('anthropic:claude-haiku-4-5')
    expect(out.fallback).toBe(false)
    expect(out.reason).toBe('preferred_unavailable')
  })

  test('preferred blank AND no fallback → return blank (caller decides what to do)', () => {
    const out = resolveEffectiveModel('', inSet([]), '')
    expect(out.model).toBe('')
    expect(out.fallback).toBe(true)
    expect(out.reason).toBe('preferred_blank')
  })

  test('whitespace-only preferred is treated as blank', () => {
    const out = resolveEffectiveModel('   ', inSet(['x']), 'x')
    expect(out.model).toBe('x')
    expect(out.reason).toBe('preferred_blank')
  })
})
