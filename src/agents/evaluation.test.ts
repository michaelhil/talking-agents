// Tests for evaluation's error classification — ensures LLM/transport failures
// produce typed `action: 'error'` decisions with the correct error code, never
// a `pass` action. Pass is reserved for genuine agent decisions (the `pass`
// tool); this distinction is what lets the UI surface real failures clearly
// (red error chip + "Change model" affordance) instead of hiding them behind
// a gray "[pass]".

import { describe, expect, test } from 'bun:test'
import type { LLMProvider } from '../core/types/llm.ts'
import { createCloudProviderError, createGatewayError, createOllamaError } from '../llm/errors.ts'
import { createAIAgent } from './ai-agent.ts'
import type { Decision } from './ai-agent.ts'
import type { AIAgentConfig } from '../core/types/agent.ts'
import type { Message } from '../core/types/messaging.ts'

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
