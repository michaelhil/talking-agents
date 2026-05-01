// Tests for evaluation's error classification — ensures LLM/transport failures
// produce typed `action: 'error'` decisions with the correct error code, never
// a `pass` action. Pass is reserved for genuine agent decisions (the `pass`
// tool); this distinction is what lets the UI surface real failures clearly
// (red error chip + "Change model" affordance) instead of hiding them behind
// a gray "[pass]".
//
// Direct unit tests for streamWithRetry / evaluate() tool-loop / streamLLM /
// callLLM live in the additional describe blocks below — they exercise the
// evaluate.ts public surface without going through createAIAgent.

import { describe, expect, test } from 'bun:test'
import type { ChatRequest, ChatResponse, LLMProvider, StreamChunk } from '../core/types/llm.ts'
import type { ToolDefinition, ToolExecutor } from '../core/types/tool.ts'
import { createCloudProviderError, createGatewayError, createOllamaError } from '../llm/errors.ts'
import { createAIAgent } from './ai-agent.ts'
import type { Decision } from './ai-agent.ts'
import type { AIAgentConfig } from '../core/types/agent.ts'
import type { Message } from '../core/types/messaging.ts'
import type { ContextResult } from './context-builder.ts'
import { evaluate, callLLM, streamLLM, streamWithRetry } from './evaluation.ts'

const makeConfig = (over: Partial<AIAgentConfig> = {}): AIAgentConfig => ({
  name: 'Tester',
  model: 'test-model',
  persona: 'You are a tester.',
  ...over,
})

const makeMessage = (over: Partial<Message> = {}): Message => ({
  id: 'm1',
  senderId: 'alice',
  content: 'hello',
  timestamp: Date.now(),
  type: 'chat',
  roomId: 'room-1',
  ...over,
})

const errProvider = (err: unknown): LLMProvider => ({
  chat: async () => { throw err },
  models: async () => [],
})

describe('Evaluation — error classification', () => {
  test('cloud auth error → no_api_key', async () => {
    const decisions: Decision[] = []
    const provider = errProvider(createCloudProviderError({
      code: 'auth', provider: 'anthropic', message: 'invalid api key', status: 401,
    }))
    const agent = createAIAgent(makeConfig(), provider, (d) => { decisions.push(d) })
    agent.receive(makeMessage())
    await agent.whenIdle()

    expect(decisions[0]!.response.action).toBe('error')
    if (decisions[0]!.response.action === 'error') {
      expect(decisions[0]!.response.code).toBe('no_api_key')
      expect(decisions[0]!.response.providerHint).toBe('anthropic')
    }
  })

  test('cloud bad_request → model_unavailable', async () => {
    const decisions: Decision[] = []
    const provider = errProvider(createCloudProviderError({
      code: 'bad_request', provider: 'groq', message: 'unknown model', status: 400,
    }))
    const agent = createAIAgent(makeConfig(), provider, (d) => { decisions.push(d) })
    agent.receive(makeMessage())
    await agent.whenIdle()

    if (decisions[0]!.response.action === 'error') {
      expect(decisions[0]!.response.code).toBe('model_unavailable')
      expect(decisions[0]!.response.providerHint).toBe('groq')
    } else {
      throw new Error('expected error action')
    }
  })

  test('cloud rate_limit → rate_limited', async () => {
    const decisions: Decision[] = []
    const provider = errProvider(createCloudProviderError({
      code: 'rate_limit', provider: 'gemini', message: '429 too many requests', status: 429,
    }))
    const agent = createAIAgent(makeConfig(), provider, (d) => { decisions.push(d) })
    agent.receive(makeMessage())
    await agent.whenIdle()

    if (decisions[0]!.response.action === 'error') {
      expect(decisions[0]!.response.code).toBe('rate_limited')
    } else {
      throw new Error('expected error action')
    }
  })

  test('cloud provider_down → provider_down', async () => {
    const decisions: Decision[] = []
    const provider = errProvider(createCloudProviderError({
      code: 'provider_down', provider: 'cerebras', message: '503 service unavailable', status: 503,
    }))
    const agent = createAIAgent(makeConfig(), provider, (d) => { decisions.push(d) })
    agent.receive(makeMessage())
    await agent.whenIdle()

    if (decisions[0]!.response.action === 'error') {
      expect(decisions[0]!.response.code).toBe('provider_down')
    } else {
      throw new Error('expected error action')
    }
  })

  test('ollama 4xx → model_unavailable', async () => {
    const decisions: Decision[] = []
    const provider = errProvider(createOllamaError(404, 'model "qwen99" not found'))
    const agent = createAIAgent(makeConfig(), provider, (d) => { decisions.push(d) })
    agent.receive(makeMessage())
    await agent.whenIdle()

    if (decisions[0]!.response.action === 'error') {
      expect(decisions[0]!.response.code).toBe('model_unavailable')
      expect(decisions[0]!.response.providerHint).toBe('ollama')
    } else {
      throw new Error('expected error action')
    }
  })

  test('gateway error → provider_down', async () => {
    const decisions: Decision[] = []
    const provider = errProvider(createGatewayError('circuit_open', 'circuit open for ollama'))
    const agent = createAIAgent(makeConfig(), provider, (d) => { decisions.push(d) })
    agent.receive(makeMessage())
    await agent.whenIdle()

    if (decisions[0]!.response.action === 'error') {
      expect(decisions[0]!.response.code).toBe('provider_down')
    } else {
      throw new Error('expected error action')
    }
  })

  test('network-shaped error → network', async () => {
    const decisions: Decision[] = []
    const provider = errProvider(new Error('fetch failed: ECONNREFUSED'))
    const agent = createAIAgent(makeConfig(), provider, (d) => { decisions.push(d) })
    agent.receive(makeMessage())
    await agent.whenIdle()

    if (decisions[0]!.response.action === 'error') {
      expect(decisions[0]!.response.code).toBe('network')
    } else {
      throw new Error('expected error action')
    }
  })

  test('unknown error → unknown', async () => {
    const decisions: Decision[] = []
    const provider = errProvider(new Error('something weird happened'))
    const agent = createAIAgent(makeConfig(), provider, (d) => { decisions.push(d) })
    agent.receive(makeMessage())
    await agent.whenIdle()

    if (decisions[0]!.response.action === 'error') {
      expect(decisions[0]!.response.code).toBe('unknown')
    } else {
      throw new Error('expected error action')
    }
  })

  test('empty content from LLM → action:error / code:empty_response (NOT pass)', async () => {
    const decisions: Decision[] = []
    const provider: LLMProvider = {
      chat: async () => ({ content: '', generationMs: 5, tokensUsed: { prompt: 1, completion: 0 } }),
      models: async () => [],
    }
    const agent = createAIAgent(makeConfig(), provider, (d) => { decisions.push(d) })
    agent.receive(makeMessage())
    await agent.whenIdle()

    expect(decisions[0]!.response.action).toBe('error')
    if (decisions[0]!.response.action === 'error') {
      expect(decisions[0]!.response.code).toBe('empty_response')
    }
  })

  test('a real `pass` tool call still produces action:pass (sanity check)', async () => {
    const decisions: Decision[] = []
    const provider: LLMProvider = {
      chat: async () => ({
        content: '',
        generationMs: 5,
        tokensUsed: { prompt: 1, completion: 0 },
        toolCalls: [{ function: { name: 'pass', arguments: { reason: 'no input' } } }],
      }),
      models: async () => [],
    }
    const agent = createAIAgent(
      makeConfig(),
      provider,
      (d) => { decisions.push(d) },
      {
        toolDefinitions: [{ type: 'function', function: { name: 'pass', description: 'decline', parameters: {} } }],
        toolExecutor: async () => [],
      },
    )
    agent.receive(makeMessage())
    await agent.whenIdle()

    expect(decisions[0]!.response.action).toBe('pass')
    if (decisions[0]!.response.action === 'pass') {
      expect(decisions[0]!.response.reason).toBe('no input')
    }
  })
})

// ============================================================================
// Direct evaluate() / streamWithRetry / streamLLM / callLLM tests.
// Real LLMProvider implementations as fixtures (no mocks).
// ============================================================================

const baseContextResult = (): ContextResult => ({
  messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
  ],
  flushInfo: { ids: new Set<string>(), triggerRoomId: 'room-1' },
  warnings: [],
})

const asyncIterFromArray = <T>(items: ReadonlyArray<T>): AsyncIterable<T> => ({
  [Symbol.asyncIterator]: () => {
    let i = 0
    return {
      next: async () => i < items.length
        ? { value: items[i++]!, done: false }
        : { value: undefined as unknown as T, done: true },
    }
  },
})

interface StaticProviderOptions {
  readonly content?: string
  readonly toolCalls?: ChatResponse['toolCalls']
  readonly streamChunks?: ReadonlyArray<StreamChunk>
}

const makeStaticProvider = (opts: StaticProviderOptions = {}): LLMProvider => {
  const { content = '', toolCalls, streamChunks } = opts
  const chat = async (): Promise<ChatResponse> => ({
    content,
    generationMs: 1,
    tokensUsed: { prompt: 5, completion: 2 },
    ...(toolCalls ? { toolCalls } : {}),
  })
  if (streamChunks) {
    return {
      chat,
      stream: () => asyncIterFromArray(streamChunks),
      models: async () => ['test-model'],
    }
  }
  return { chat, models: async () => ['test-model'] }
}

interface FlakyState { attempts: number }
const makeFlakyProvider = (
  failures: number,
  errorFactory: () => Error,
  successContent = 'ok',
): { provider: LLMProvider; state: FlakyState } => {
  const state: FlakyState = { attempts: 0 }
  const provider: LLMProvider = {
    chat: async (): Promise<ChatResponse> => {
      state.attempts++
      if (state.attempts <= failures) throw errorFactory()
      return {
        content: successContent,
        generationMs: 1,
        tokensUsed: { prompt: 1, completion: 1 },
      }
    },
    models: async () => ['test-model'],
  }
  return { provider, state }
}

const makeScriptedProvider = (
  scripts: ReadonlyArray<{ content?: string; toolCalls?: ChatResponse['toolCalls'] }>,
): { provider: LLMProvider; calls: ChatRequest[] } => {
  const calls: ChatRequest[] = []
  let i = 0
  const provider: LLMProvider = {
    chat: async (request): Promise<ChatResponse> => {
      calls.push(request)
      const s = scripts[Math.min(i++, scripts.length - 1)]!
      return {
        content: s.content ?? '',
        generationMs: 1,
        tokensUsed: { prompt: 1, completion: 1 },
        ...(s.toolCalls ? { toolCalls: s.toolCalls } : {}),
      }
    },
    models: async () => ['test-model'],
  }
  return { provider, calls }
}

const passToolDef: ToolDefinition = {
  type: 'function',
  function: {
    name: 'pass',
    description: 'Decline',
    parameters: { type: 'object', properties: {}, required: [] },
  },
}

const baseConfig: AIAgentConfig = {
  name: 'TestBot', model: 'test-model', persona: 'tester', historyLimit: 10,
}

// ---------------------------------------------------------------------------
// streamWithRetry — direct retry/backoff tests. LLM_RETRY_DELAY_MS is a
// private 1000ms const; each retry test tolerates ~1–2s wall time.
// ---------------------------------------------------------------------------

describe('streamWithRetry', () => {
  const baseRequest: ChatRequest = { model: 'test-model', messages: [] }

  test('retries once on transient error then succeeds', async () => {
    const { provider, state } = makeFlakyProvider(
      1, () => createOllamaError(500, 'transient blip'), 'recovered',
    )
    const result = await streamWithRetry(provider, baseConfig, baseRequest)
    expect(result.content).toBe('recovered')
    expect(state.attempts).toBe(2)
  }, 5000)

  test('exhausts retries and throws after LLM_RETRIES+1 attempts', async () => {
    const { provider, state } = makeFlakyProvider(
      99, () => createOllamaError(500, 'always failing'), 'never',
    )
    await expect(streamWithRetry(provider, baseConfig, baseRequest))
      .rejects.toThrow('always failing')
    // LLM_RETRIES = 2 → up to 3 attempts.
    expect(state.attempts).toBe(3)
  }, 8000)

  test('does not retry permanent ollama errors', async () => {
    const { provider, state } = makeFlakyProvider(
      99, () => createOllamaError(404, 'model not found'), 'never',
    )
    await expect(streamWithRetry(provider, baseConfig, baseRequest))
      .rejects.toThrow('model not found')
    expect(state.attempts).toBe(1)
  })

  test('does not retry when AbortSignal is aborted', async () => {
    const { provider, state } = makeFlakyProvider(
      99, () => createOllamaError(500, 'transient'), 'never',
    )
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(streamWithRetry(provider, baseConfig, baseRequest, undefined, ctrl.signal))
      .rejects.toThrow('transient')
    expect(state.attempts).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// evaluate() — tool loop, exhaustion, truncation. The pass-tool short-circuit
// is already covered above via createAIAgent.
// ---------------------------------------------------------------------------

describe('evaluate (tool loop)', () => {
  test('plain content → respond decision', async () => {
    const provider = makeStaticProvider({ content: 'hello world' })
    const result = await evaluate(
      baseContextResult(), baseConfig, provider, undefined, 5, 'room-1',
    )
    const r = result.decision.response
    expect(r.action).toBe('respond')
    if (r.action === 'respond') expect(r.content).toBe('hello world')
  })

  test('one tool round → result feeds next call → final content', async () => {
    const { provider, calls } = makeScriptedProvider([
      { toolCalls: [{ function: { name: 'echo', arguments: { text: 'hi' } } }] },
      { content: 'final answer' },
    ])
    const exec: ToolExecutor = async (toolCalls) =>
      toolCalls.map(c => ({ success: true, data: { echoed: c.arguments.text } }))
    const result = await evaluate(
      baseContextResult(), baseConfig, provider, exec, 5, 'room-1',
      { toolDefinitions: [] },
    )
    const r = result.decision.response
    expect(r.action).toBe('respond')
    if (r.action === 'respond') expect(r.content).toBe('final answer')
    expect(calls).toHaveLength(2)
    // Second call sees tool result injected as user message.
    const last = calls[1]!
    const userMsgs = last.messages.filter(m => m.role === 'user')
    expect(userMsgs.some(m => m.content.includes('echoed'))).toBe(true)
    // toolTrace populated.
    expect(result.decision.toolTrace).toHaveLength(1)
    expect(result.decision.toolTrace![0]!.tool).toBe('echo')
    expect(result.decision.toolTrace![0]!.success).toBe(true)
  })

  test('multi-round tool loop (2 tools then content)', async () => {
    const { provider, calls } = makeScriptedProvider([
      { toolCalls: [{ function: { name: 'a', arguments: {} } }] },
      { toolCalls: [{ function: { name: 'b', arguments: {} } }] },
      { content: 'done' },
    ])
    const exec: ToolExecutor = async (toolCalls) =>
      toolCalls.map(() => ({ success: true, data: 'ok' }))
    const result = await evaluate(
      baseContextResult(), baseConfig, provider, exec, 5, 'room-1',
      { toolDefinitions: [] },
    )
    expect(calls).toHaveLength(3)
    const r = result.decision.response
    if (r.action === 'respond') expect(r.content).toBe('done')
    expect(result.decision.toolTrace).toHaveLength(2)
  })

  test('tool calls without executor → tools_unavailable', async () => {
    const provider = makeStaticProvider({
      toolCalls: [{ function: { name: 'echo', arguments: {} } }],
    })
    const result = await evaluate(
      baseContextResult(), baseConfig, provider, undefined, 5, 'room-1',
      { toolDefinitions: [passToolDef] },
    )
    const r = result.decision.response
    expect(r.action).toBe('error')
    if (r.action === 'error') expect(r.code).toBe('tools_unavailable')
  })

  test('iteration cap with prior text → respond with partial-result footer', async () => {
    // Every round emits both content AND a tool call → loop never ends via
    // content; surfaces as exhaustion, BUT lastAssistantText was captured
    // and is delivered with a footer instead of a bare error.
    const { provider } = makeScriptedProvider([
      { content: 'partial answer', toolCalls: [{ function: { name: 'a', arguments: {} } }] },
      { content: 'still working', toolCalls: [{ function: { name: 'a', arguments: {} } }] },
      { content: 'still working', toolCalls: [{ function: { name: 'a', arguments: {} } }] },
    ])
    const exec: ToolExecutor = async (calls) =>
      calls.map(() => ({ success: true, data: 'k' }))
    // maxToolIterations = 1 → 2 rounds (0 and 1) before exhaustion.
    const result = await evaluate(
      baseContextResult(), baseConfig, provider, exec, 1, 'room-1',
      { toolDefinitions: [] },
    )
    const r = result.decision.response
    expect(r.action).toBe('respond')
    if (r.action === 'respond') {
      expect(r.content).toContain('still working')
      expect(r.content).toContain('partial result')
    }
  })

  test('tool result > maxToolResultChars truncated when fed back', async () => {
    const huge = 'x'.repeat(10_000)
    const { provider, calls } = makeScriptedProvider([
      { toolCalls: [{ function: { name: 'big', arguments: {} } }] },
      { content: 'done' },
    ])
    const exec: ToolExecutor = async (toolCalls) =>
      toolCalls.map(() => ({ success: true, data: huge }))
    await evaluate(
      baseContextResult(),
      { ...baseConfig, maxToolResultChars: 100 },
      provider, exec, 5, 'room-1',
      { toolDefinitions: [] },
    )
    const second = calls[1]!
    const truncMsg = second.messages.find(m =>
      m.role === 'user' && m.content.includes('characters omitted'))
    expect(truncMsg).toBeDefined()
    // The full 10k string must NOT appear in the next request.
    expect(second.messages.some(m => m.content.includes(huge))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// streamLLM / callLLM
// ---------------------------------------------------------------------------

describe('streamLLM', () => {
  test('yields deltas from provider stream', async () => {
    const provider = makeStaticProvider({
      streamChunks: [
        { delta: 'hel', done: false },
        { delta: 'lo', done: false },
        { delta: '', done: true, tokensUsed: { prompt: 1, completion: 1 } },
      ],
    })
    const got: string[] = []
    for await (const chunk of streamLLM(provider, {
      model: 'm', messages: [{ role: 'user', content: 'x' }],
    })) {
      if (chunk) got.push(chunk)
    }
    expect(got).toEqual(['hel', 'lo'])
  })

  test('falls back to chat() when provider has no stream method', async () => {
    const provider = makeStaticProvider({ content: 'whole answer' })
    expect(provider.stream).toBeUndefined()
    const got: string[] = []
    for await (const chunk of streamLLM(provider, {
      model: 'm', messages: [{ role: 'user', content: 'x' }],
    })) {
      got.push(chunk)
    }
    expect(got).toEqual(['whole answer'])
  })
})

describe('callLLM', () => {
  test('returns raw chat content', async () => {
    const provider = makeStaticProvider({ content: 'sync result' })
    const out = await callLLM(provider, {
      model: 'm', messages: [{ role: 'user', content: 'q' }],
    })
    expect(out).toBe('sync result')
  })
})
