import { describe, expect, test } from 'bun:test'
import { resolveModelFallback, FALLBACKABLE_CODES } from './model-fallback.ts'

describe('resolveModelFallback', () => {
  test('explicit fallback wins over implicit', () => {
    expect(resolveModelFallback('gemini:gemini-2.5-pro', 'cerebras:qwen-3-235b'))
      .toBe('cerebras:qwen-3-235b')
  })

  test('implicit Pro→Flash when no explicit', () => {
    expect(resolveModelFallback('gemini:gemini-2.5-pro'))
      .toBe('gemini:gemini-2.5-flash')
  })

  test('null when explicit equals primary (avoid retrying same model)', () => {
    expect(resolveModelFallback('gemini:gemini-2.5-pro', 'gemini:gemini-2.5-pro'))
      .toBeNull()
  })

  test('null for models with no explicit and no implicit mapping', () => {
    expect(resolveModelFallback('gemini:gemini-2.5-flash')).toBeNull()
    expect(resolveModelFallback('anthropic:claude-sonnet-4-6')).toBeNull()
    expect(resolveModelFallback('cerebras:qwen-3-235b')).toBeNull()
  })

  test('explicit empty string treated as no explicit (use implicit if any)', () => {
    expect(resolveModelFallback('gemini:gemini-2.5-pro', ''))
      .toBe('gemini:gemini-2.5-flash')
  })
})

describe('FALLBACKABLE_CODES', () => {
  test('includes the three transient upstream codes', () => {
    expect(FALLBACKABLE_CODES.has('rate_limited')).toBe(true)
    expect(FALLBACKABLE_CODES.has('provider_down')).toBe(true)
    expect(FALLBACKABLE_CODES.has('network')).toBe(true)
  })
  test('excludes config-level errors', () => {
    expect(FALLBACKABLE_CODES.has('no_api_key')).toBe(false)
    expect(FALLBACKABLE_CODES.has('model_unavailable')).toBe(false)
  })
  test('excludes agent-side errors', () => {
    expect(FALLBACKABLE_CODES.has('tool_loop_exceeded')).toBe(false)
    expect(FALLBACKABLE_CODES.has('empty_response')).toBe(false)
    expect(FALLBACKABLE_CODES.has('tools_unavailable')).toBe(false)
  })
})
