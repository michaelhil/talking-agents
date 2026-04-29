// ============================================================================
// Regression test: providerKeys MUST flow into router.isProviderEnabled.
//
// Production bug (samsinn.app silent on Send):
//   bootstrap.ts called buildProvidersFromConfig(config, { limitMetrics })
//   WITHOUT providerKeys. providers-setup.ts then built the router with
//   isProviderEnabled = undefined, so router.isEnabled returned true for
//   every provider in the order. anthropic was first, no key → 401 on
//   every chat call. The agent's evaluate caught the auth error and posted
//   `[pass] LLM error: anthropic auth error 401`. The user-facing symptom
//   was "Send a message, nothing happens" — Helper passed silently.
//
// The fix: bootstrap constructs providerKeys early, threads it into
// buildProvidersFromConfig AND into createSharedRuntime so a single
// instance is shared.
//
// What this test pins down: a freshly-built router with providerKeys for
// only one provider must NOT route to keyless providers, even when their
// names are listed in the order.
// ============================================================================

import { describe, test, expect } from 'bun:test'
import { buildProvidersFromConfig } from './providers-setup.ts'
import { createProviderKeys } from './provider-keys.ts'
import type { ProviderConfig } from './providers-config.ts'

describe('providerKeys wiring (regression — samsinn.app silent Send)', () => {
  const baseConfig: ProviderConfig = {
    order: ['anthropic', 'gemini', 'cerebras', 'groq', 'openrouter', 'mistral', 'sambanova', 'ollama'] as ReadonlyArray<string>,
    ollamaUrl: '',
    ollamaMaxConcurrent: 2,
    cloud: {},  // intentional — keys come via providerKeys, not config
    ollamaOnly: false,
    forceFailProvider: null,
    droppedFromOrder: [],
    orderFromUser: false,
  }

  test('router.chat skips keyless providers when providerKeys is wired', async () => {
    const providerKeys = createProviderKeys({
      cloud: {},
      ollama: { enabled: true, maxConcurrent: undefined },
    })
    // Only set a key for one provider — gemini.
    providerKeys.set('gemini', 'fake-but-present')

    const setup = buildProvidersFromConfig(baseConfig, { providerKeys })

    // Substitute fake stream + chat that record which provider got called.
    const calls: string[] = []
    for (const name of baseConfig.order) {
      const gw = setup.gateways[name]
      if (!gw) continue
      const real = gw.chat
      ;(gw as { chat: typeof real }).chat = async (req, opts) => {
        calls.push(name)
        return real(req, opts).catch(err => { throw err })
      }
    }

    // Try chat with an unprefixed model. Pre-fix: router walks anthropic
    // first (no key), 401, throw. Post-fix: anthropic is filtered, gemini
    // is the first candidate.
    try {
      await setup.router.chat({
        model: 'gemini-2.5-flash-lite',
        messages: [{ role: 'user', content: 'hi' }],
      })
    } catch {
      // Expected to fail — fake-but-present key won't authenticate to real
      // gemini. We only care WHO was called.
    }

    // Pre-fix would have called anthropic. Post-fix calls gemini only.
    expect(calls).not.toContain('anthropic')
    expect(calls).not.toContain('cerebras')
    expect(calls).not.toContain('groq')
    expect(calls).not.toContain('openrouter')
    expect(calls).not.toContain('mistral')
    expect(calls).not.toContain('sambanova')
    expect(calls).toContain('gemini')
  })

  test('without providerKeys (BUG SHAPE): every provider in order is candidate', async () => {
    // This documents the pre-fix behavior — buildProvidersFromConfig with
    // no providerKeys → router has no isProviderEnabled filter → walks all.
    const setup = buildProvidersFromConfig(baseConfig, {})  // no providerKeys

    const calls: string[] = []
    for (const name of baseConfig.order) {
      const gw = setup.gateways[name]
      if (!gw) continue
      ;(gw as { chat: typeof gw.chat }).chat = async () => {
        calls.push(name)
        throw new Error(`fake fail for ${name}`)
      }
    }

    try {
      await setup.router.chat({
        model: 'gemini-2.5-flash-lite',
        messages: [{ role: 'user', content: 'hi' }],
      })
    } catch { /* expected */ }

    // Pre-fix: anthropic IS attempted (the bug). This test pins down that
    // shape so a future refactor that changes the unprefixed-model fallback
    // semantics has to re-think it deliberately.
    expect(calls[0]).toBe('anthropic')
  })
})
