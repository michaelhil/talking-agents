// LLMService — chain walk, cooldown skip, network retry, chain_switch event.
//
// Uses a hand-rolled fake ProviderRouter (LLMProvider + getMonitorSnapshot)
// so we can drive every code path deterministically without booting the
// gateway/circuit-breaker stack.

import { describe, expect, test } from 'bun:test'
import type { ChatRequest, ChatResponse, StreamChunk } from '../core/types/llm.ts'
import type { MonitorState } from './provider-monitor.ts'
import type { ProviderRouter } from './router.ts'
import { createCloudProviderError } from './errors.ts'
import { createLLMService } from './llm-service.ts'

interface FakeRouterOpts {
  readonly chat?: (req: ChatRequest) => Promise<ChatResponse>
  readonly stream?: (req: ChatRequest, signal?: AbortSignal) => AsyncIterable<StreamChunk>
  readonly monitorSnapshot?: Record<string, MonitorState | null>
}

const fakeRouter = (opts: FakeRouterOpts): ProviderRouter => ({
  chat: opts.chat ?? (async () => ({ content: 'ok', generationMs: 1, tokensUsed: { prompt: 1, completion: 1 } })),
  stream: opts.stream ?? (async function*() {
    yield { delta: 'ok', done: false }
    yield { delta: '', done: true, tokensUsed: { prompt: 1, completion: 1 } }
  }),
  models: async () => [],
  onRoutingEvent: () => {},
  getProviderNames: () => [],
  getAggregatedMetrics: () => ({
    byProvider: {}, lastSuccessByModel: {},
    routingEvents: { bound: 0, allFailed: 0, streamFailed: 0 },
  }),
  getMonitorSnapshot: () => opts.monitorSnapshot ?? {},
  getOrder: () => [],
  setOrder: () => {},
  dispose: () => {},
})

const okChat = async (model: string): Promise<ChatResponse> => ({
  content: `from:${model}`,
  generationMs: 1,
  tokensUsed: { prompt: 1, completion: 1 },
  provider: model.split(':')[0] ?? 'unknown',
})

describe('LLMService — cooldown skip', () => {
  test('primary in backoff with retryAt > now+1s → routed to chain[0]', async () => {
    const calls: string[] = []
    const router = fakeRouter({
      chat: async (req) => { calls.push(req.model); return okChat(req.model) },
      monitorSnapshot: {
        gemini: {
          sub: 'backoff', retryAt: Date.now() + 30_000,
          reason: 'rate_limit', since: Date.now(), modelCount: 0,
          lastError: null, lastErrorAt: null, consecutiveFailures: 1,
        },
      },
    })
    const svc = createLLMService({
      router,
      getSystemChain: () => ['openai:gpt-4o-mini'],
    })
    const provider = svc.bound({ source: 'agent' })
    const res = await provider.chat({ model: 'gemini:gemini-2.5-flash', messages: [] })
    // Primary skipped — first call is to chain[0].
    expect(calls[0]).toBe('openai:gpt-4o-mini')
    expect(res.content).toContain('openai:gpt-4o-mini')
  })
})

describe('LLMService — chain walk on fallbackable error', () => {
  test('chunk-0 stream failure on primary walks to chain[0]; emits chain_switch once', async () => {
    const events: Array<{ preferred: string; effective: string }> = []
    const calls: string[] = []
    const router = fakeRouter({
      stream: function (req: ChatRequest) {
        calls.push(req.model)
        if (req.model === 'primary') {
          return (async function*() {
            throw createCloudProviderError({
              code: 'rate_limit', provider: 'gemini', status: 429,
              message: 'rate limited',
            })
            // eslint-disable-next-line no-unreachable
            yield {} as StreamChunk
          })()
        }
        return (async function*() {
          yield { delta: 'pong', done: false }
          yield { delta: '', done: true, tokensUsed: { prompt: 1, completion: 1 } }
        })()
      },
    })
    const svc = createLLMService({ router })
    const provider = svc.bound({
      source: 'agent',
      fallbackChain: ['fallback'],
      onChainSwitch: (preferred, effective) => events.push({ preferred, effective }),
    })

    let collected = ''
    const stream = provider.stream!({ model: 'primary', messages: [] })
    for await (const chunk of stream) {
      if (chunk.delta) collected += chunk.delta
    }
    expect(collected).toBe('pong')
    expect(calls).toEqual(['primary', 'fallback'])
    expect(events).toEqual([{ preferred: 'primary', effective: 'fallback' }])
  })
})

describe('LLMService — bare network retry', () => {
  test('one ECONNRESET on primary retries same model and succeeds; chain not advanced', async () => {
    const calls: string[] = []
    let primaryFails = 1
    const router = fakeRouter({
      chat: async (req) => {
        calls.push(req.model)
        if (req.model === 'primary' && primaryFails > 0) {
          primaryFails--
          throw new Error('socket hang up: ECONNRESET')
        }
        return okChat(req.model)
      },
    })
    const svc = createLLMService({
      router,
      getSystemChain: () => ['fallback'],
    })
    const provider = svc.bound({ source: 'agent' })
    const res = await provider.chat({ model: 'primary', messages: [] })
    // Two attempts on primary (retry), no advance to chain[0].
    expect(calls).toEqual(['primary', 'primary'])
    expect(res.content).toContain('primary')
  })
})

describe('LLMService — auth errors are not fallbackable', () => {
  test('cloud auth error stops chain walk immediately', async () => {
    const calls: string[] = []
    const router = fakeRouter({
      chat: async (req) => {
        calls.push(req.model)
        throw createCloudProviderError({
          code: 'auth', provider: 'openai', status: 401,
          message: 'invalid key',
        })
      },
    })
    const svc = createLLMService({
      router,
      getSystemChain: () => ['fallback-1', 'fallback-2'],
    })
    const provider = svc.bound({ source: 'agent' })
    await expect(provider.chat({ model: 'primary', messages: [] })).rejects.toThrow(/invalid key/)
    // Auth is not fallbackable — only the primary is tried (with one network
    // retry attempt that doesn't fire because auth isn't a network error).
    expect(calls).toEqual(['primary'])
  })
})
