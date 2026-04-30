// ============================================================================
// End-to-end test of the bootstrap-shape wiring: real createProviderKeys,
// real buildProvidersFromConfig, real ProviderRouter, real semaphores —
// only the network destination is a fixture (a local Bun.serve responding
// with controlled bodies). No mocks; no fake provider names.
//
// This test is the regression net for the three bugs that surfaced after
// the wiki commit:
//   1. provider-gateway.ts: undefined override clobbered defaults → 30 s
//      semaphore queue timeout on every request to keyless providers.
//   2. bootstrap.ts: providerKeys not threaded → router walked keyless
//      providers (anthropic) → 401 on every chat call.
//   3. openai-compatible.ts: Gemini's "models/" prefix mismatched the
//      router's catalog membership check → gemini was filtered out of
//      candidates and requests fell through to keyless / unreachable
//      providers.
//
// If any of those regress, this test fails.
// ============================================================================

import { describe, test, expect } from 'bun:test'
import { buildProvidersFromConfig } from '../llm/providers-setup.ts'
import { createProviderKeys } from '../llm/provider-keys.ts'
import { mergeWithEnv } from '../llm/providers-store.ts'
import type { ProviderConfig } from '../llm/providers-config.ts'

// === Fixture: a real local HTTP server with scripted /models + /chat/completions
// responses. Records every request so the test can assert on who was called. ===

interface FixtureServer {
  url: string
  requests: Array<{ path: string; auth: string | null; body: unknown }>
  stop: () => void
}

const startProviderFixture = (
  _name: string,  // for caller readability only
  status: number,
  chatBody: unknown,
  modelsBody: unknown,
): FixtureServer => {
  const requests: FixtureServer['requests'] = []
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url)
      const auth = req.headers.get('authorization') ?? req.headers.get('x-api-key')
      let body: unknown
      try { body = await req.clone().json() } catch { body = undefined }
      requests.push({ path: url.pathname, auth, body })
      const respBody = url.pathname.endsWith('/models') ? modelsBody : chatBody
      return new Response(JSON.stringify(respBody), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })
  return {
    url: `http://localhost:${server.port}`,
    requests,
    stop: () => server.stop(true),
  }
}

const baseProviderConfig = (overrides: Partial<ProviderConfig>): ProviderConfig => ({
  ollamaUrl: '',
  ollamaMaxConcurrent: 2,
  baseUrls: {},
  cloud: {},
  ollamaOnly: false,
  forceFailProvider: null,
  droppedFromOrder: [],
  orderFromUser: false,
  order: ['anthropic', 'gemini'] as ReadonlyArray<string>,
  ...overrides,
})

describe('bootstrap end-to-end: real wiring with fixture endpoints', () => {

  test('keyless anthropic is skipped, gemini gets the chat (Bug 2 regression)', async () => {
    const anthropicFx = startProviderFixture(
      'anthropic',
      401,
      { error: { message: 'no key' } },
      { data: [] },
    )
    const geminiFx = startProviderFixture(
      'gemini',
      200,
      {
        choices: [{ message: { role: 'assistant', content: 'hi back' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      },
      // Gemini's real /models returns "models/" prefixed ids — the test
      // explicitly mirrors that so Bug 3 is also covered (the strip must
      // make this match the user-facing "gemini-2.5-flash-lite").
      { data: [{ id: 'models/gemini-2.5-flash-lite' }] },
    )

    try {
      // Real provider-keys store — only gemini gets a key.
      const providerKeys = createProviderKeys(mergeWithEnv({ version: 1, providers: {} }, { env: {} as Record<string, string | undefined> }))
      providerKeys.set('gemini', 'real-fixture-key')

      const setup = buildProvidersFromConfig(baseProviderConfig({}), {
        providerKeys,
        baseUrlOverrides: {
          anthropic: anthropicFx.url,
          gemini: geminiFx.url,
        },
      })

      // Pre-populate gemini's catalog by calling models() — same as
      // warmProviderModels does at boot. This validates the strip
      // (Bug 3): if the strip is removed, the catalog will hold
      // "models/gemini-2.5-flash-lite" and the router's membership
      // check against the user-facing "gemini-2.5-flash-lite" fails.
      await setup.gateways['gemini']!.refreshModels()

      const response = await setup.router.chat({
        model: 'gemini-2.5-flash-lite',  // unprefixed, like the seed
        messages: [{ role: 'user', content: 'hi' }],
      })

      expect(response.content).toBe('hi back')
      expect(response.provider).toBe('gemini')

      // Anthropic must not have been called — providerKeys filter must
      // have skipped it. Bug 2 regression: pre-fix, anthropic got the
      // request and returned 401.
      const anthropicChat = anthropicFx.requests.filter(r => r.path.includes('/chat/completions'))
      expect(anthropicChat).toHaveLength(0)

      // Gemini must have been called.
      const geminiChat = geminiFx.requests.filter(r => r.path.includes('/chat/completions'))
      expect(geminiChat).toHaveLength(1)
      expect(geminiChat[0]?.auth).toBe('Bearer real-fixture-key')
    } finally {
      anthropicFx.stop()
      geminiFx.stop()
    }
  })

  test('keyless provider does NOT hang at semaphore acquire (Bug 1 regression)', async () => {
    // Pre-fix shape: maxConcurrent on a keyless provider was undefined,
    // so semaphore.acquire queued forever and timed out at 30s. With Bun's
    // default 5s test timeout, this test would hang and fail. Post-fix the
    // request returns instantly (skipped because keyless).
    //
    // We achieve this by NOT giving anthropic a key. If the gateway's
    // semaphore is broken, even the path through providerKeys.isEnabled →
    // skipped wouldn't matter — but the semaphore is constructed during
    // gateway creation regardless of key. We probe the gateway DIRECTLY to
    // confirm its config is sane (which is what Bug 1 broke).
    const fx = startProviderFixture('anthropic', 200, {}, { data: [] })
    try {
      const providerKeys = createProviderKeys(mergeWithEnv({ version: 1, providers: {} }, { env: {} as Record<string, string | undefined> }))
      // No keys set — every provider is keyless.
      const setup = buildProvidersFromConfig(baseProviderConfig({}), {
        providerKeys,
        baseUrlOverrides: { anthropic: fx.url },
      })

      // Every gateway in the order must have a positive numeric maxConcurrent.
      // This is the same contract validateBootstrap enforces; testing it here
      // catches the regression at unit-test time without needing a full
      // System construction.
      for (const name of ['anthropic', 'gemini']) {
        const gw = setup.gateways[name]
        expect(gw).toBeDefined()
        expect(typeof gw!.getConfig().maxConcurrent).toBe('number')
        expect(gw!.getConfig().maxConcurrent).toBeGreaterThan(0)
      }
    } finally {
      fx.stop()
    }
  })

  test('Gemini "models/" prefix is stripped so router catalog matches (Bug 3 regression)', async () => {
    // Direct test of the catalog-membership path: gemini's /models returns
    // "models/gemini-2.5-flash-lite". The strip in openai-compatible.ts
    // must produce a catalog entry that matches the user-facing
    // "gemini-2.5-flash-lite". If the strip regresses, the router filters
    // gemini OUT of unprefixed-model candidates (Bug 3).
    const geminiFx = startProviderFixture(
      'gemini',
      200,
      { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      { data: [{ id: 'models/gemini-2.5-flash-lite' }, { id: 'models/gemini-2.5-pro' }] },
    )
    try {
      const providerKeys = createProviderKeys(mergeWithEnv({ version: 1, providers: {} }, { env: {} as Record<string, string | undefined> }))
      providerKeys.set('gemini', 'k')

      const setup = buildProvidersFromConfig(baseProviderConfig({ order: ['gemini'] }), {
        providerKeys,
        baseUrlOverrides: { gemini: geminiFx.url },
      })
      await setup.gateways['gemini']!.refreshModels()

      const list = setup.gateways['gemini']!.getHealth().availableModels
      expect(list).toContain('gemini-2.5-flash-lite')
      expect(list).toContain('gemini-2.5-pro')
      expect(list).not.toContain('models/gemini-2.5-flash-lite')
    } finally {
      geminiFx.stop()
    }
  })
})
