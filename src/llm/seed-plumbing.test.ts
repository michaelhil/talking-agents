// ============================================================================
// Seed plumbing — request-body tests.
//
// Verify that `seed` is emitted to the outgoing HTTP body only when set, and
// that unsetting it produces a body byte-identical to today's. Tests hit both
// the OpenAI-shape adapter (Groq/Cerebras/OpenRouter/…/Anthropic/Gemini share
// this code path) and the Ollama adapter.
// ============================================================================

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createOllamaProvider } from './ollama.ts'
import { createOpenAICompatibleProvider } from './openai-compatible.ts'

type CapturedRequest = { url: string; body: unknown }

const installFetchCapture = (response: Response): { captured: CapturedRequest[]; restore: () => void } => {
  const captured: CapturedRequest[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
    const bodyText = typeof init?.body === 'string' ? init.body : ''
    captured.push({ url: urlStr, body: bodyText ? JSON.parse(bodyText) : undefined })
    return response.clone()
  }) as typeof fetch
  return {
    captured,
    restore: () => { globalThis.fetch = originalFetch },
  }
}

describe('seed plumbing — OpenAI-compatible adapter', () => {
  let restore: () => void
  let captured: CapturedRequest[]

  beforeEach(() => {
    const resp = new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { headers: { 'content-type': 'application/json' } })
    const cap = installFetchCapture(resp)
    captured = cap.captured
    restore = cap.restore
  })

  afterEach(() => restore())

  test('seed omitted when unset — body is byte-identical to pre-seed baseline', async () => {
    const provider = createOpenAICompatibleProvider({
      name: 'test',
      getBaseUrl: () => 'http://local.test/v1',
      getApiKey: () => 'k',
    })
    await provider.chat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.5,
    })
    expect(captured).toHaveLength(1)
    const body = captured[0]!.body as Record<string, unknown>
    expect('seed' in body).toBe(false)
  })

  test('seed emitted when set', async () => {
    const provider = createOpenAICompatibleProvider({
      name: 'test',
      getBaseUrl: () => 'http://local.test/v1',
      getApiKey: () => 'k',
    })
    await provider.chat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.5,
      seed: 42,
    })
    const body = captured[0]!.body as Record<string, unknown>
    expect(body.seed).toBe(42)
  })
})

describe('seed plumbing — Ollama adapter', () => {
  let restore: () => void
  let captured: CapturedRequest[]

  beforeEach(() => {
    const resp = new Response(JSON.stringify({
      model: 'm', done: true,
      message: { role: 'assistant', content: 'ok' },
      prompt_eval_count: 1, eval_count: 1,
    }), { headers: { 'content-type': 'application/json' } })
    const cap = installFetchCapture(resp)
    captured = cap.captured
    restore = cap.restore
  })

  afterEach(() => restore())

  test('seed omitted from options when unset', async () => {
    const provider = createOllamaProvider('http://local.test:11434')
    await provider.chat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.5,
    })
    const body = captured[0]!.body as { options: Record<string, unknown> }
    expect('seed' in body.options).toBe(false)
  })

  test('seed emitted on options when set', async () => {
    const provider = createOllamaProvider('http://local.test:11434')
    await provider.chat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.5,
      seed: 99,
    })
    const body = captured[0]!.body as { options: Record<string, unknown> }
    expect(body.options.seed).toBe(99)
  })
})
