import { describe, expect, test } from 'bun:test'
import { resolveFallbackChain, FALLBACKABLE_CODES } from './model-fallback.ts'

describe('resolveFallbackChain', () => {
  test('returns empty when no fallback configured', () => {
    expect(resolveFallbackChain('gemini:gemini-2.5-flash')).toEqual([])
    expect(resolveFallbackChain('gemini:gemini-2.5-flash', undefined)).toEqual([])
  })

  test('string form normalises to length-1 chain', () => {
    expect(resolveFallbackChain('gemini:gemini-2.5-flash', 'anthropic:claude-haiku-4-5'))
      .toEqual(['anthropic:claude-haiku-4-5'])
  })

  test('array form passes through in order', () => {
    expect(resolveFallbackChain('gemini:gemini-2.5-flash',
      ['anthropic:claude-haiku-4-5', 'openai:gpt-4o-mini']))
      .toEqual(['anthropic:claude-haiku-4-5', 'openai:gpt-4o-mini'])
  })

  test('drops the primary model from the chain (no point retrying it)', () => {
    expect(resolveFallbackChain('anthropic:claude-haiku-4-5',
      ['anthropic:claude-haiku-4-5', 'openai:gpt-4o-mini']))
      .toEqual(['openai:gpt-4o-mini'])
  })

  test('drops duplicate fallbacks (first occurrence wins)', () => {
    expect(resolveFallbackChain('gemini:gemini-2.5-flash',
      ['anthropic:claude-haiku-4-5', 'openai:gpt-4o-mini', 'anthropic:claude-haiku-4-5']))
      .toEqual(['anthropic:claude-haiku-4-5', 'openai:gpt-4o-mini'])
  })

  test('drops empty strings', () => {
    expect(resolveFallbackChain('gemini:gemini-2.5-flash',
      ['', 'anthropic:claude-haiku-4-5', '   ']))
      .toEqual(['anthropic:claude-haiku-4-5'])
  })

  test('empty string fallback returns empty chain', () => {
    expect(resolveFallbackChain('gemini:gemini-2.5-flash', '')).toEqual([])
  })

  test('chain that is entirely the primary returns empty', () => {
    expect(resolveFallbackChain('anthropic:claude-haiku-4-5',
      ['anthropic:claude-haiku-4-5']))
      .toEqual([])
  })
})

describe('FALLBACKABLE_CODES', () => {
  test('includes upstream + per-provider account-state codes', () => {
    // Transient upstream:
    expect(FALLBACKABLE_CODES.has('rate_limited')).toBe(true)
    expect(FALLBACKABLE_CODES.has('provider_down')).toBe(true)
    expect(FALLBACKABLE_CODES.has('network')).toBe(true)
    // Per-provider state (credit-out, account-gated model, quota): the
    // next chain element is on a different provider with different
    // account state, so retry there has a chance.
    expect(FALLBACKABLE_CODES.has('model_unavailable')).toBe(true)
  })
  test('excludes auth (router pre-filters keyless providers)', () => {
    expect(FALLBACKABLE_CODES.has('no_api_key')).toBe(false)
  })
  test('excludes agent-side errors that would repeat on any provider', () => {
    expect(FALLBACKABLE_CODES.has('tool_loop_exceeded')).toBe(false)
    expect(FALLBACKABLE_CODES.has('empty_response')).toBe(false)
    expect(FALLBACKABLE_CODES.has('tools_unavailable')).toBe(false)
  })
})
