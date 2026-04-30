import { describe, test, expect } from 'bun:test'
import { createOpenAICompatibleProvider } from './openai-compatible.ts'
import { isCloudProviderError } from './errors.ts'

// A minimal fixture server: each test starts its own Bun.serve, captures the
// incoming request for assertion, and returns the scripted response.

interface ScriptedResponse {
  readonly status: number
  readonly body: string
  readonly headers?: Record<string, string>
  readonly streamLines?: ReadonlyArray<string>   // SSE frames (each becomes "data: <line>\n\n")
}

const startFixture = (script: (req: Request) => ScriptedResponse): { url: string; stop: () => void; last: { request?: Request; body?: unknown } } => {
  const last: { request?: Request; body?: unknown } = {}
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      last.request = req
      try { last.body = await req.clone().json() } catch { last.body = undefined }
      const scripted = script(req)
      if (scripted.streamLines) {
        const encoder = new TextEncoder()
        const stream = new ReadableStream({
          start(controller) {
            for (const line of scripted.streamLines!) {
              controller.enqueue(encoder.encode(`data: ${line}\n\n`))
            }
            controller.close()
          },
        })
        return new Response(stream, {
          status: scripted.status,
          headers: {
            'Content-Type': 'text/event-stream',
            ...(scripted.headers ?? {}),
          },
        })
      }
      return new Response(scripted.body, {
        status: scripted.status,
        headers: scripted.headers ?? { 'Content-Type': 'application/json' },
      })
    },
  })
  return {
    url: `http://localhost:${server.port}`,
    stop: () => server.stop(true),
    last,
  }
}

describe('createOpenAICompatibleProvider', () => {
  test('chat happy path: request shape + response parsing', async () => {
    const fx = startFixture(() => ({
      status: 200,
      body: JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'hello back' } }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }),
    }))
    try {
      const provider = createOpenAICompatibleProvider({
        name: 'test', baseUrl: fx.url, getApiKey: () => 'sk-test',
      })
      const response = await provider.chat({
        model: 'm1',
        messages: [{ role: 'user', content: 'hi' }],
      })
      expect(response.content).toBe('hello back')
      expect(response.tokensUsed).toEqual({ prompt: 5, completion: 3 })
      expect(fx.last.request?.headers.get('authorization')).toBe('Bearer sk-test')
      expect(fx.last.body).toMatchObject({ model: 'm1', stream: false })
    } finally {
      fx.stop()
    }
  })

  test('429 with integer Retry-After → rate_limit error carries retryAfterMs', async () => {
    const fx = startFixture(() => ({
      status: 429,
      body: 'Too many requests',
      headers: { 'Retry-After': '12' },
    }))
    try {
      const provider = createOpenAICompatibleProvider({
        name: 'test', baseUrl: fx.url, getApiKey: () => 'k',
      })
      let caught: unknown
      try { await provider.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }) }
      catch (err) { caught = err }
      expect(isCloudProviderError(caught)).toBe(true)
      if (isCloudProviderError(caught)) {
        expect(caught.code).toBe('rate_limit')
        expect(caught.retryAfterMs).toBe(12_000)
      }
    } finally { fx.stop() }
  })

  test('429 with HTTP-date Retry-After → parsed to future ms', async () => {
    const future = new Date(Date.now() + 30_000).toUTCString()
    const fx = startFixture(() => ({
      status: 429, body: 'slow down',
      headers: { 'Retry-After': future },
    }))
    try {
      const provider = createOpenAICompatibleProvider({ name: 'test', baseUrl: fx.url, getApiKey: () => 'k' })
      let caught: unknown
      try { await provider.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }) }
      catch (err) { caught = err }
      expect(isCloudProviderError(caught)).toBe(true)
      if (isCloudProviderError(caught)) {
        expect(caught.code).toBe('rate_limit')
        // Should be around 30s (minus test jitter)
        expect(caught.retryAfterMs ?? 0).toBeGreaterThan(25_000)
        expect(caught.retryAfterMs ?? 0).toBeLessThan(35_000)
      }
    } finally { fx.stop() }
  })

  test('401 → auth error (no retryAfterMs)', async () => {
    const fx = startFixture(() => ({ status: 401, body: 'invalid key' }))
    try {
      const provider = createOpenAICompatibleProvider({ name: 'test', baseUrl: fx.url, getApiKey: () => 'bad' })
      let caught: unknown
      try { await provider.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }) }
      catch (err) { caught = err }
      expect(isCloudProviderError(caught)).toBe(true)
      if (isCloudProviderError(caught)) {
        expect(caught.code).toBe('auth')
      }
    } finally { fx.stop() }
  })

  test('streaming: tool_calls accumulated from deltas', async () => {
    const fx = startFixture(() => ({
      status: 200, body: '',
      streamLines: [
        JSON.stringify({ choices: [{ delta: { content: 'Thinking' } }] }),
        JSON.stringify({ choices: [{ delta: { content: '...' } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call1', function: { name: 'add', arguments: '{"a":' } }] } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1, "b":2}' } }] } }] }),
        JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }] }),
        '[DONE]',
      ],
    }))
    try {
      const provider = createOpenAICompatibleProvider({ name: 'test', baseUrl: fx.url, getApiKey: () => 'k' })
      const chunks: Array<{ delta: string; done: boolean; toolCalls?: ReadonlyArray<{ function: { name: string; arguments: Record<string, unknown> } }> }> = []
      for await (const chunk of provider.stream!({ model: 'm', messages: [{ role: 'user', content: 'x' }] })) {
        chunks.push(chunk as { delta: string; done: boolean; toolCalls?: ReadonlyArray<{ function: { name: string; arguments: Record<string, unknown> } }> })
      }
      const finalChunk = chunks.find(c => c.done)
      expect(finalChunk).toBeDefined()
      expect(finalChunk?.toolCalls).toBeDefined()
      expect(finalChunk?.toolCalls?.[0]?.function.name).toBe('add')
      expect(finalChunk?.toolCalls?.[0]?.function.arguments).toEqual({ a: 1, b: 2 })
    } finally { fx.stop() }
  })

  test('streaming: parallel tool_calls without index split into separate slots (Gemini-style)', async () => {
    // Gemini's OpenAI-compat streams parallel tool calls as full-object
    // argument strings in successive deltas, with no `index` and no `id`.
    // The accumulator must split them when it sees a complete-JSON buffer
    // followed by a fresh '{' fragment — otherwise both args concatenate
    // to `{...}{...}` and JSON.parse fails.
    const fx = startFixture(() => ({
      status: 200, body: '',
      streamLines: [
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { name: 'web_search', arguments: '{"query":"first"}' } }] } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { name: 'web_search', arguments: '{"query":"second"}' } }] } }] }),
        JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }] }),
        '[DONE]',
      ],
    }))
    try {
      const provider = createOpenAICompatibleProvider({ name: 'gemini', baseUrl: fx.url, getApiKey: () => 'k' })
      const chunks: Array<{ delta: string; done: boolean; toolCalls?: ReadonlyArray<{ function: { name: string; arguments: Record<string, unknown> } }> }> = []
      for await (const chunk of provider.stream!({ model: 'm', messages: [{ role: 'user', content: 'x' }] })) {
        chunks.push(chunk as never)
      }
      const finalChunk = chunks.find(c => c.done)
      expect(finalChunk?.toolCalls).toBeDefined()
      expect(finalChunk?.toolCalls).toHaveLength(2)
      expect(finalChunk?.toolCalls?.[0]?.function.arguments).toEqual({ query: 'first' })
      expect(finalChunk?.toolCalls?.[1]?.function.arguments).toEqual({ query: 'second' })
    } finally { fx.stop() }
  })

  test('streaming: <think>...</think> extracted to thinking field', async () => {
    const fx = startFixture(() => ({
      status: 200, body: '',
      streamLines: [
        JSON.stringify({ choices: [{ delta: { content: '<think>reasoning step</think>' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'final answer' } }] }),
        JSON.stringify({ choices: [{ finish_reason: 'stop', delta: {} }] }),
        '[DONE]',
      ],
    }))
    try {
      const provider = createOpenAICompatibleProvider({ name: 'test', baseUrl: fx.url, getApiKey: () => 'k' })
      const chunks: Array<{ delta: string; done: boolean; thinking?: string }> = []
      for await (const chunk of provider.stream!({ model: 'm', messages: [{ role: 'user', content: 'x' }] })) {
        chunks.push(chunk as { delta: string; done: boolean; thinking?: string })
      }
      const allThinking = chunks.map(c => c.thinking ?? '').join('')
      const allContent = chunks.map(c => c.delta).join('')
      expect(allThinking).toContain('reasoning step')
      expect(allContent).toContain('final answer')
      expect(allContent).not.toContain('<think>')
    } finally { fx.stop() }
  })

  test('models() returns list from /models endpoint', async () => {
    const fx = startFixture(() => ({
      status: 200,
      body: JSON.stringify({ data: [{ id: 'alpha' }, { id: 'beta' }] }),
    }))
    try {
      const provider = createOpenAICompatibleProvider({ name: 'test', baseUrl: fx.url, getApiKey: () => 'k' })
      const list = await provider.models()
      expect(list).toEqual(['alpha', 'beta'])
    } finally { fx.stop() }
  })

  test('models() strips Gemini "models/" id prefix so router catalog match works', async () => {
    // Regression: the Gemini OpenAI-compat /models endpoint returns ids in
    // the form "models/gemini-2.5-flash-lite". Without stripping, the
    // router's `list.includes(modelId)` membership check fails for unprefixed
    // user-facing names ("gemini-2.5-flash-lite") and gemini gets filtered
    // out of candidates — the request falls through to ollama (or whichever
    // catalog-empty optimistic-include provider is next), which on a host
    // without ollama hangs forever or returns "Unable to connect". This was
    // the root cause of "Send does nothing" on samsinn.app.
    const fx = startFixture(() => ({
      status: 200,
      body: JSON.stringify({
        data: [
          { id: 'models/gemini-2.5-flash-lite' },
          { id: 'models/gemini-2.5-pro' },
          { id: 'plain-id-no-prefix' },        // non-gemini ids unchanged
        ],
      }),
    }))
    try {
      const provider = createOpenAICompatibleProvider({ name: 'gemini', baseUrl: fx.url, getApiKey: () => 'k' })
      const list = await provider.models()
      expect(list).toEqual(['gemini-2.5-flash-lite', 'gemini-2.5-pro', 'plain-id-no-prefix'])
    } finally { fx.stop() }
  })

  test('non-streaming tool_calls: arguments string parsed to object', async () => {
    const fx = startFixture(() => ({
      status: 200,
      body: JSON.stringify({
        choices: [{
          message: {
            role: 'assistant', content: '',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'do_thing', arguments: '{"x":42}' } }],
          },
        }],
      }),
    }))
    try {
      const provider = createOpenAICompatibleProvider({ name: 'test', baseUrl: fx.url, getApiKey: () => 'k' })
      const response = await provider.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] })
      expect(response.toolCalls?.[0]?.function.arguments).toEqual({ x: 42 })
    } finally { fx.stop() }
  })

  // === Anthropic prompt-cache markers ===

  const okBody = JSON.stringify({
    choices: [{ message: { role: 'assistant', content: 'ok' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  })

  const sampleTools = [
    { type: 'function' as const, function: { name: 'a', description: 'A', parameters: { type: 'object' } } },
    { type: 'function' as const, function: { name: 'b', description: 'B', parameters: { type: 'object' } } },
    { type: 'function' as const, function: { name: 'c', description: 'C', parameters: { type: 'object' } } },
  ]

  test('Anthropic + tools: cache_control on last tool top-level (not inside .function); earlier tools clean', async () => {
    const fx = startFixture(() => ({ status: 200, body: okBody }))
    try {
      const provider = createOpenAICompatibleProvider({ name: 'anthropic', baseUrl: fx.url, getApiKey: () => 'k' })
      await provider.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], tools: sampleTools })
      const tools = (fx.last.body as { tools?: ReadonlyArray<Record<string, unknown>> }).tools!
      expect(tools).toHaveLength(3)
      expect(tools[0]).not.toHaveProperty('cache_control')
      expect(tools[1]).not.toHaveProperty('cache_control')
      expect(tools[2]?.cache_control).toEqual({ type: 'ephemeral' })
      // Top-level on the entry, NOT nested under .function
      expect((tools[2]?.function as Record<string, unknown> | undefined)?.cache_control).toBeUndefined()
    } finally { fx.stop() }
  })

  test('Anthropic + systemBlocks + tools: BOTH markers present (two breakpoints)', async () => {
    const fx = startFixture(() => ({ status: 200, body: okBody }))
    try {
      const provider = createOpenAICompatibleProvider({ name: 'anthropic', baseUrl: fx.url, getApiKey: () => 'k' })
      await provider.chat({
        model: 'm',
        messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'x' }],
        systemBlocks: [
          { text: 'stable', cacheable: true },
          { text: 'volatile', cacheable: false },
        ],
        tools: sampleTools,
      })
      const body = fx.last.body as { tools?: ReadonlyArray<Record<string, unknown>>; messages?: ReadonlyArray<{ role: string; content: ReadonlyArray<{ text: string; cache_control?: { type: string } }> }> }
      // Tools-side marker on last entry
      expect(body.tools![2]?.cache_control).toEqual({ type: 'ephemeral' })
      // System-side marker on the last cacheable part
      const sysParts = body.messages![0]!.content
      const stable = sysParts.find(p => p.text === 'stable')!
      const volatile = sysParts.find(p => p.text === 'volatile')!
      expect(stable.cache_control).toEqual({ type: 'ephemeral' })
      expect(volatile.cache_control).toBeUndefined()
    } finally { fx.stop() }
  })

  test('Anthropic + systemBlocks + no tools: system marker still present (regression guard)', async () => {
    const fx = startFixture(() => ({ status: 200, body: okBody }))
    try {
      const provider = createOpenAICompatibleProvider({ name: 'anthropic', baseUrl: fx.url, getApiKey: () => 'k' })
      await provider.chat({
        model: 'm',
        messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'x' }],
        systemBlocks: [{ text: 'stable', cacheable: true }],
      })
      const body = fx.last.body as { tools?: unknown; messages: ReadonlyArray<{ role: string; content: ReadonlyArray<{ text: string; cache_control?: { type: string } }> }> }
      expect(body.tools).toBeUndefined()
      expect(body.messages[0]!.content[0]!.cache_control).toEqual({ type: 'ephemeral' })
    } finally { fx.stop() }
  })

  test('Anthropic + empty tools array: no marker, no crash', async () => {
    const fx = startFixture(() => ({ status: 200, body: okBody }))
    try {
      const provider = createOpenAICompatibleProvider({ name: 'anthropic', baseUrl: fx.url, getApiKey: () => 'k' })
      await provider.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [] })
      const body = fx.last.body as { tools?: unknown }
      expect(body.tools).toBeUndefined()
    } finally { fx.stop() }
  })

  test('non-Anthropic providers: no cache_control leaks anywhere on tools or system', async () => {
    const others = ['gemini', 'groq', 'cerebras', 'openrouter', 'mistral', 'sambanova', 'ollama'] as const
    for (const name of others) {
      const fx = startFixture(() => ({ status: 200, body: okBody }))
      try {
        const provider = createOpenAICompatibleProvider({ name, baseUrl: fx.url, getApiKey: () => 'k' })
        await provider.chat({
          model: 'm',
          messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'x' }],
          systemBlocks: [{ text: 'stable', cacheable: true }],
          tools: sampleTools,
        })
        const body = fx.last.body as { tools?: ReadonlyArray<Record<string, unknown>>; messages: ReadonlyArray<{ content: unknown }> }
        for (const t of body.tools ?? []) {
          expect(t.cache_control).toBeUndefined()
        }
        // System message stays a plain string for non-Anthropic.
        expect(typeof body.messages[0]!.content).toBe('string')
      } finally { fx.stop() }
    }
  })

  test('failover safety: input ChatRequest.tools reference is unchanged after Anthropic call', async () => {
    const fx = startFixture(() => ({ status: 200, body: okBody }))
    try {
      const provider = createOpenAICompatibleProvider({ name: 'anthropic', baseUrl: fx.url, getApiKey: () => 'k' })
      const tools = sampleTools
      await provider.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], tools })
      // Caller's array and entries remain untouched — adapter must not
      // mutate the shared reference (router uses the same ChatRequest
      // across failover attempts to other providers).
      expect(tools).toHaveLength(3)
      for (const t of tools) {
        expect(t).not.toHaveProperty('cache_control')
      }
    } finally { fx.stop() }
  })
})
