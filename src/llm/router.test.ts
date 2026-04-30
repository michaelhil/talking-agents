import { describe, test, expect } from 'bun:test'
import type { ChatRequest, ChatResponse, StreamChunk, ProviderHealth, GatewayMetrics } from '../core/types/llm.ts'
import type { ProviderGateway } from './provider-gateway.ts'
import { createProviderRouter, parseProviderPrefix, type ProviderRoutingEvent } from './router.ts'
import { createCloudProviderError } from './errors.ts'
import { createProviderMonitor, type ProviderMonitor } from './provider-monitor.ts'

// Helper: build a fake-monitor map for the given provider names so the
// router enforces cooldown / unhealthy state. Tests that don't care about
// monitor state can omit this and the router behaves as "always allow".
const monitorsFor = (
  names: ReadonlyArray<string>,
  now: () => number = Date.now,
): Record<string, ProviderMonitor> => {
  const out: Record<string, ProviderMonitor> = {}
  for (const n of names) {
    out[n] = createProviderMonitor(
      { name: n, kind: 'cloud', hasKey: () => true, isUserEnabled: () => true },
      { now },
    )
  }
  return out
}

// === Fake gateway — implements ProviderGateway with scriptable behaviour ===

interface FakeScript {
  // Map: call-index (0, 1, 2...) → response or error
  readonly responses?: ReadonlyArray<ChatResponse | Error>
  readonly streamResponses?: ReadonlyArray<ReadonlyArray<StreamChunk> | Error>
  readonly availableModels?: ReadonlyArray<string>
}

const createFakeGateway = (script: FakeScript): ProviderGateway & { callCount: () => number; externalFailCount: () => number } => {
  let chatCallIdx = 0
  let streamCallIdx = 0
  let externalFails = 0
  const health: ProviderHealth = {
    status: 'healthy',
    latencyMs: 100,
    availableModels: script.availableModels ?? [],
    lastCheckedAt: Date.now(),
  }

  const chat = async (_request: ChatRequest): Promise<ChatResponse> => {
    const idx = chatCallIdx++
    const r = script.responses?.[idx]
    if (!r) {
      return {
        content: 'default', generationMs: 10,
        tokensUsed: { prompt: 1, completion: 1 },
      }
    }
    if (r instanceof Error) throw r
    return r
  }

  const stream = async function* (_request: ChatRequest): AsyncIterable<StreamChunk> {
    const idx = streamCallIdx++
    const r = script.streamResponses?.[idx]
    if (!r) {
      yield { delta: 'x', done: false }
      yield { delta: '', done: true }
      return
    }
    if (r instanceof Error) throw r
    for (const chunk of r) yield chunk
  }

  const metrics: GatewayMetrics = {
    requestCount: 0, errorCount: 0, errorRate: 0,
    p50Latency: 0, p95Latency: 0, avgTokensPerSecond: 0,
    queueDepth: 0, concurrentRequests: 0,
    circuitState: 'closed', shedCount: 0, windowMs: 300_000,
  }

  return {
    chat,
    stream,
    models: async () => [...(script.availableModels ?? [])],
    runningModels: async () => [],
    getMetrics: () => metrics,
    getHealth: () => health,
    getConfig: () => ({
      maxConcurrent: 2, maxQueueDepth: 6, queueTimeoutMs: 30_000,
      circuitBreakerThreshold: 5, circuitBreakerCooldownMs: 15_000,
    }),
    updateConfig: () => {},
    onHealthChange: () => {},
    resetCircuitBreaker: () => {},
    refreshModels: async () => {},
    recordExternalFailure: () => { externalFails++ },
    dispose: () => {},
    callCount: () => chatCallIdx,
    externalFailCount: () => externalFails,
  }
}

const chatReq = (model: string, content = 'hi'): ChatRequest => ({
  model, messages: [{ role: 'user', content }],
})

describe('parseProviderPrefix', () => {
  test('bare model name → no prefix', () => {
    expect(parseProviderPrefix('llama-3.3-70b')).toEqual({ provider: null, modelId: 'llama-3.3-70b' })
  })
  test('simple prefix', () => {
    expect(parseProviderPrefix('groq:llama-3.3-70b')).toEqual({ provider: 'groq', modelId: 'llama-3.3-70b' })
  })
  test('openrouter slug with multiple colons → split on FIRST colon only', () => {
    expect(parseProviderPrefix('openrouter:meta-llama/llama-3.3-70b-instruct:free')).toEqual({
      provider: 'openrouter',
      modelId: 'meta-llama/llama-3.3-70b-instruct:free',
    })
  })
  test('bare slug with slash is NOT treated as prefixed', () => {
    expect(parseProviderPrefix('meta-llama/llama-3.3')).toEqual({
      provider: null,
      modelId: 'meta-llama/llama-3.3',
    })
  })
})

describe('createProviderRouter — failover', () => {
  test('first provider succeeds → no fallback, emits provider_bound transition', async () => {
    const a = createFakeGateway({ availableModels: ['m'] })
    const b = createFakeGateway({ availableModels: ['m'] })
    const router = createProviderRouter({ a, b }, { order: ['a', 'b'] })
    const events: ProviderRoutingEvent[] = []
    router.onRoutingEvent(e => events.push(e))
    const r = await router.chat(chatReq('m'), { agentId: 'ag1' })
    expect(r.content).toBe('default')
    expect(a.callCount()).toBe(1)
    expect(b.callCount()).toBe(0)
    expect(events.filter(e => e.type === 'provider_bound')).toHaveLength(1)
    expect((events[0] as { type: 'provider_bound'; oldProvider: null; newProvider: string }).oldProvider).toBeNull()
    expect((events[0] as { newProvider: string }).newProvider).toBe('a')
  })

  test('rate_limit on first → falls through to second, marks first cold', async () => {
    const a = createFakeGateway({
      responses: [createCloudProviderError({ code: 'rate_limit', provider: 'a', message: '429', retryAfterMs: 60_000 })],
      availableModels: ['m'],
    })
    const b = createFakeGateway({ availableModels: ['m'] })
    const monitors = monitorsFor(['a', 'b'])
    const router = createProviderRouter({ a, b }, { order: ['a', 'b'], monitors })
    const r = await router.chat(chatReq('m'))
    expect(r.content).toBe('default')
    expect(a.callCount()).toBe(1)
    expect(b.callCount()).toBe(1)
    const snap = router.getMonitorSnapshot()
    expect(snap.a?.sub).toBe('backoff')
    expect(snap.a?.retryAt).not.toBeNull()
  })

  test('auth error propagates without fallback', async () => {
    const a = createFakeGateway({
      responses: [createCloudProviderError({ code: 'auth', provider: 'a', message: '401' })],
      availableModels: ['m'],
    })
    const b = createFakeGateway({ availableModels: ['m'] })
    const router = createProviderRouter({ a, b }, { order: ['a', 'b'] })
    let caught: unknown
    try { await router.chat(chatReq('m')) }
    catch (err) { caught = err }
    expect(caught).toBeDefined()
    expect(b.callCount()).toBe(0)
  })

  test('cooldown respected on second call, then expires', async () => {
    let fakeTime = 1_000_000
    const a = createFakeGateway({
      responses: [
        createCloudProviderError({ code: 'rate_limit', provider: 'a', message: '429', retryAfterMs: 5_000 }),
        { content: 'recovered', generationMs: 10, tokensUsed: { prompt: 1, completion: 1 } },
      ],
      availableModels: ['m'],
    })
    const b = createFakeGateway({ availableModels: ['m'] })
    const monitors = monitorsFor(['a', 'b'], () => fakeTime)
    const router = createProviderRouter(
      { a, b }, { order: ['a', 'b'], monitors },
      { now: () => fakeTime },
    )
    await router.chat(chatReq('m'))                  // 'a' fails → 'b' serves
    expect(a.callCount()).toBe(1)
    expect(b.callCount()).toBe(1)

    fakeTime += 1_000                                // still cold
    await router.chat(chatReq('m'))                  // should go to 'b' again
    expect(a.callCount()).toBe(1)
    expect(b.callCount()).toBe(2)

    fakeTime += 10_000                               // past cooldown
    await router.chat(chatReq('m'))                  // 'a' healthy, but soft pref keeps 'b'
    expect(a.callCount()).toBe(1)
    expect(b.callCount()).toBe(3)
  })

  test('soft preference: after success on b, prefers b over a even when both healthy', async () => {
    const a = createFakeGateway({ availableModels: ['m'] })
    const b = createFakeGateway({ availableModels: ['m'] })
    const router = createProviderRouter({ a, b }, { order: ['a', 'b'] })
    // Force first call to go to b via prefix-pinning, which sets lastSuccessByModel[m]=b.
    await router.chat(chatReq('b:m'))
    expect(b.callCount()).toBe(1)
    expect(a.callCount()).toBe(0)
    // Next call with bare model name should also go to b due to soft preference.
    await router.chat(chatReq('m'))
    expect(b.callCount()).toBe(2)
    expect(a.callCount()).toBe(0)
  })

  test('provider_bound fires only on transition, not on repeat', async () => {
    const a = createFakeGateway({ availableModels: ['m'] })
    const router = createProviderRouter({ a }, { order: ['a'] })
    const events: ProviderRoutingEvent[] = []
    router.onRoutingEvent(e => events.push(e))
    await router.chat(chatReq('m'), { agentId: 'ag1' })
    await router.chat(chatReq('m'), { agentId: 'ag1' })
    await router.chat(chatReq('m'), { agentId: 'ag1' })
    // Only first call is a transition (null → a).
    expect(events.filter(e => e.type === 'provider_bound')).toHaveLength(1)
  })

  test('provider skipped when model not in its available list', async () => {
    const a = createFakeGateway({ availableModels: ['other-model'] })  // doesn't list 'm'
    const b = createFakeGateway({ availableModels: ['m'] })
    const router = createProviderRouter({ a, b }, { order: ['a', 'b'] })
    await router.chat(chatReq('m'))
    expect(a.callCount()).toBe(0)
    expect(b.callCount()).toBe(1)
  })

  test('all providers fail → provider_all_failed event + throws', async () => {
    const a = createFakeGateway({
      responses: [createCloudProviderError({ code: 'rate_limit', provider: 'a', message: '429' })],
      availableModels: ['m'],
    })
    const b = createFakeGateway({
      responses: [createCloudProviderError({ code: 'provider_down', provider: 'b', message: '503' })],
      availableModels: ['m'],
    })
    const router = createProviderRouter({ a, b }, { order: ['a', 'b'] })
    const events: ProviderRoutingEvent[] = []
    router.onRoutingEvent(e => events.push(e))
    let caught: unknown
    try { await router.chat(chatReq('m')) }
    catch (err) { caught = err }
    expect(caught).toBeDefined()
    expect(events.filter(e => e.type === 'provider_all_failed')).toHaveLength(1)
    const evt = events.find(e => e.type === 'provider_all_failed') as {
      type: 'provider_all_failed'
      attempts: ReadonlyArray<{ provider: string; reason: string }>
    }
    expect(evt.attempts).toHaveLength(2)
  })

  test('FORCE_PROVIDER_FAIL skips named provider', async () => {
    const a = createFakeGateway({ availableModels: ['m'] })
    const b = createFakeGateway({ availableModels: ['m'] })
    const router = createProviderRouter(
      { a, b },
      { order: ['a', 'b'], forceFailProvider: 'a' },
    )
    await router.chat(chatReq('m'))
    expect(a.callCount()).toBe(0)
    expect(b.callCount()).toBe(1)
  })

  test('prefix-pinned model with unavailable provider → fails cleanly', async () => {
    const a = createFakeGateway({ availableModels: ['m'] })
    const router = createProviderRouter({ a }, { order: ['a'] })
    let caught: unknown
    try { await router.chat(chatReq('nonexistent:m')) }
    catch (err) { caught = err }
    expect(caught).toBeDefined()
  })

  test('aggregated metrics expose per-provider breakdown', async () => {
    const a = createFakeGateway({ availableModels: ['m'] })
    const b = createFakeGateway({ availableModels: ['m'] })
    const router = createProviderRouter({ a, b }, { order: ['a', 'b'] })
    await router.chat(chatReq('m'))
    const metrics = router.getAggregatedMetrics()
    expect(Object.keys(metrics.byProvider)).toEqual(['a', 'b'])
    expect(metrics.lastSuccessByModel).toEqual({ m: 'a' })
  })
})

describe('createProviderRouter — streaming', () => {
  test('initial-connect failure falls through to next provider', async () => {
    const a = createFakeGateway({
      streamResponses: [createCloudProviderError({ code: 'provider_down', provider: 'a', message: '503' })],
      availableModels: ['m'],
    })
    const b = createFakeGateway({
      streamResponses: [[{ delta: 'ok', done: false }, { delta: '', done: true }]],
      availableModels: ['m'],
    })
    const router = createProviderRouter({ a, b }, { order: ['a', 'b'] })
    const chunks: StreamChunk[] = []
    for await (const chunk of router.stream(chatReq('m'))) chunks.push(chunk)
    expect(chunks.map(c => c.delta).join('')).toBe('ok')
  })

  test('mid-stream failure → provider_stream_failed event, no retry', async () => {
    // First chunk succeeds, then error mid-stream. Built inline since the fake's
    // script-based stream cannot mix yielded chunks with a throw.
    const a: ProviderGateway & { callCount: () => number; externalFailCount: () => number } = {
      chat: async () => { throw new Error('not used') },
      stream: async function* () {
        yield { delta: 'partial', done: false }
        throw createCloudProviderError({ code: 'provider_down', provider: 'a', message: 'died' })
      },
      models: async () => ['m'],
      runningModels: async () => [],
      getMetrics: () => ({
        requestCount: 0, errorCount: 0, errorRate: 0,
        p50Latency: 0, p95Latency: 0, avgTokensPerSecond: 0,
        queueDepth: 0, concurrentRequests: 0,
        circuitState: 'closed', shedCount: 0, windowMs: 300_000,
      }),
      getHealth: () => ({ status: 'healthy', latencyMs: 0, availableModels: ['m'], lastCheckedAt: 0 }),
      getConfig: () => ({ maxConcurrent: 2, maxQueueDepth: 6, queueTimeoutMs: 30_000, circuitBreakerThreshold: 5, circuitBreakerCooldownMs: 15_000 }),
      updateConfig: () => {},
      onHealthChange: () => {},
      resetCircuitBreaker: () => {},
      refreshModels: async () => {},
      recordExternalFailure: () => {},
      dispose: () => {},
      callCount: () => 0,
      externalFailCount: () => 0,
    }
    const b = createFakeGateway({
      streamResponses: [[{ delta: 'ok', done: false }, { delta: '', done: true }]],
      availableModels: ['m'],
    })
    const router = createProviderRouter({ a, b }, { order: ['a', 'b'] })
    const events: ProviderRoutingEvent[] = []
    router.onRoutingEvent(e => events.push(e))
    const chunks: StreamChunk[] = []
    let caught: unknown
    try {
      for await (const chunk of router.stream(chatReq('m'))) chunks.push(chunk)
    } catch (err) { caught = err }
    expect(caught).toBeDefined()
    // We got the partial chunk before the mid-stream failure.
    expect(chunks.map(c => c.delta).join('')).toContain('partial')
    // No attempt to continue on b.
    expect(b.callCount()).toBe(0)
    expect(events.filter(e => e.type === 'provider_stream_failed')).toHaveLength(1)
  })
})
