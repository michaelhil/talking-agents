// ============================================================================
// Tests for validateBootstrap. Each contract gets a positive case (passes
// with valid input) and a negative case (throws with the bug-class message
// it documents).
//
// Note: this test constructs MINIMAL System-shaped objects matching the
// surface validateBootstrap reads (.providerKeys, .providerConfig.order,
// .gateways, .llm). That's a real partial — not a stub of business logic
// — because validateBootstrap deliberately doesn't look at deep internals.
// ============================================================================

import { describe, test, expect } from 'bun:test'
import { validateBootstrap } from './validate.ts'

const validSystem = (overrides: Record<string, unknown> = {}): Parameters<typeof validateBootstrap>[0] => ({
  providerKeys: {} as never,
  providerConfig: { order: ['gemini'] } as never,
  gateways: {
    gemini: {
      getConfig: () => ({ maxConcurrent: 3, maxQueueDepth: 6, queueTimeoutMs: 30_000, circuitBreakerThreshold: 5, circuitBreakerCooldownMs: 15_000 }),
    } as never,
  } as never,
  llm: {} as never,
  ...overrides,
} as unknown as Parameters<typeof validateBootstrap>[0])

describe('validateBootstrap', () => {
  test('passes with a fully-wired system', () => {
    expect(() => validateBootstrap(validSystem())).not.toThrow()
  })

  test('throws when providerKeys is missing (commit d0c1f73 contract)', () => {
    expect(() => validateBootstrap(validSystem({ providerKeys: undefined as never })))
      .toThrow(/providerKeys is missing.*d0c1f73/)
  })

  test('throws when a gateway has undefined maxConcurrent (commit f04e61e contract)', () => {
    const sys = validSystem({
      gateways: {
        gemini: {
          getConfig: () => ({ maxConcurrent: undefined, maxQueueDepth: 6, queueTimeoutMs: 30_000, circuitBreakerThreshold: 5, circuitBreakerCooldownMs: 15_000 }),
        } as never,
      } as never,
    })
    expect(() => validateBootstrap(sys)).toThrow(/maxConcurrent.*undefined.*f04e61e/)
  })

  test('throws when a gateway has zero maxConcurrent', () => {
    const sys = validSystem({
      gateways: {
        gemini: {
          getConfig: () => ({ maxConcurrent: 0, maxQueueDepth: 6, queueTimeoutMs: 30_000, circuitBreakerThreshold: 5, circuitBreakerCooldownMs: 15_000 }),
        } as never,
      } as never,
    })
    expect(() => validateBootstrap(sys)).toThrow(/maxConcurrent.*0/)
  })

  test('skips gateways not in the configured order (allowed missing)', () => {
    // Order says ['gemini', 'ollama'] but only gemini gateway is constructed.
    // Validate skips ollama gracefully — it's fine to not have a gateway for
    // every name in the order (e.g. test paths that pin a single provider).
    const sys = validSystem({
      providerConfig: { order: ['gemini', 'ollama'] } as never,
    })
    expect(() => validateBootstrap(sys)).not.toThrow()
  })

  test('throws when llm is missing', () => {
    expect(() => validateBootstrap(validSystem({ llm: undefined as never })))
      .toThrow(/llm.*missing/)
  })
})
