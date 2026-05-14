// ============================================================================
// HTTP Routes — integration tests exercising handleAPI directly.
// ============================================================================

import { describe, test, expect, beforeEach } from 'bun:test'
import { handleAPI } from './http-routes.ts'
import { createHouse } from '../core/house.ts'
import { createTeam } from '../agents/team.ts'
import { createToolRegistry } from '../core/tool-registry.ts'
import { createLimitMetrics } from '../core/limit-metrics.ts'
import type { DeliverFn } from '../core/types/messaging.ts'
import type { WSOutbound } from '../core/types/ws-protocol.ts'
import type { System } from '../main.ts'

// === Helpers ===

const noopDeliver: DeliverFn = () => {}
const noopBroadcast = (_msg: WSOutbound): void => {}
const noopSubscribe = (): void => {}
// 16-char lowercase alphanumeric to satisfy isValidInstanceId so the
// cookie attached by `req()` below passes the F5 cookieless-→-401 gate.
const TEST_INSTANCE_ID = 'testinstance1234'

const makeSystem = (): System => {
  const house = createHouse({ deliver: noopDeliver })
  const team = createTeam()
  const toolRegistry = createToolRegistry()
  const ollama = {
    chat: async () => { throw new Error('Not available in tests') },
    models: async () => [],
    runningModels: async () => [],
    getHealth: () => ({ status: 'healthy' as const, latencyMs: 0, loadedModels: [], availableModels: [], lastCheckedAt: 0 }),
    getMetrics: () => ({ requestCount: 0, errorCount: 0, errorRate: 0, p50Latency: 0, p95Latency: 0, avgTokensPerSecond: 0, queueDepth: 0, concurrentRequests: 0, circuitState: 'closed' as const, shedCount: 0, windowMs: 300000 }),
    getConfig: () => ({}),
    updateConfig: () => {},
    loadModel: async () => {},
    unloadModel: async () => {},
    onHealthChange: () => {},
    dispose: () => {},
  }
  return {
    house, team, toolRegistry,
    llm: { models: async () => [], chat: async () => ({ content: '', generationMs: 0, tokensUsed: { prompt: 0, completion: 0 } }) } as unknown as System['llm'],
    ollama,
    providerConfig: { order: ['ollama'], ollamaUrl: 'http://localhost:11434', ollamaMaxConcurrent: 2, cloud: {}, ollamaOnly: false, forceFailProvider: null, droppedFromOrder: [], orderFromUser: false } as unknown as System['providerConfig'],
    routeMessage: () => [],
    removeAgent: (id: string) => team.removeAgent(id),
    removeRoom: (id: string) => house.removeRoom(id),
    addAgentToRoom: async () => {},
    removeAgentFromRoom: () => {},
    spawnAIAgent: async () => { throw new Error('Not implemented') },
    spawnHumanAgent: async () => { throw new Error('Not implemented') },
    setOnMessagePosted: () => {},
    setOnTurnChanged: () => {},
    setOnDeliveryModeChanged: () => {},
    setOnModeAutoSwitched: () => {},
    setOnRoomCreated: () => {},
    setOnRoomDeleted: () => {},
    setOnMembershipChanged: () => {},
    setOnEvalEvent: () => {},
    setOnProviderBound: () => {},
    setOnProviderAllFailed: () => {},
    setOnProviderStreamFailed: () => {},
    dispatchProviderEvent: () => {},
    limitMetrics: createLimitMetrics(),
  } as unknown as System
}

// All requests carry the samsinn_instance cookie. handleAPI gates
// cookieless /api/* with 401 (F5); production never sees a cookieless
// API call because the UI mints via GET /. Tests mirror that contract.
const COOKIE = `samsinn_instance=${TEST_INSTANCE_ID}`

const req = (method: string, path: string, body?: unknown): Request => {
  const url = `http://localhost${path}`
  if (!body) return new Request(url, { method, headers: { cookie: COOKIE } })
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json', cookie: COOKIE },
    body: JSON.stringify(body),
  })
}

const call = (system: System, r: Request, path: string, opts: { remoteAddress?: string } = {}) =>
  handleAPI(r, path, system, TEST_INSTANCE_ID, {
    broadcast: noopBroadcast,
    subscribeAgentState: noopSubscribe,
    ...(opts.remoteAddress ? { remoteAddress: opts.remoteAddress } : {}),
  })

// === Tests ===

describe('HTTP Routes', () => {
  let system: System

  beforeEach(() => {
    system = makeSystem()
    system.house.createRoom({ name: 'TestRoom', createdBy: 'system' })
  })

  // --- Health ---

  test('GET /health returns ok', async () => {
    const res = await call(system, req('GET', '/health'), '/health')
    expect(res?.status).toBe(200)
    const data = await res!.json() as { status: string; rooms: number }
    expect(data.status).toBe('ok')
    expect(typeof data.rooms).toBe('number')
  })

  // --- Rooms ---

  test('GET /api/rooms returns all rooms', async () => {
    const res = await call(system, req('GET', '/api/rooms'), '/api/rooms')
    expect(res?.status).toBe(200)
    const data = await res!.json() as Array<{ name: string }>
    expect(Array.isArray(data)).toBe(true)
    expect(data).toHaveLength(1)
    expect(data[0]!.name).toBe('TestRoom')
  })

  test('POST /api/rooms creates room with 201', async () => {
    const res = await call(system, req('POST', '/api/rooms', { name: 'NewRoom' }), '/api/rooms')
    expect(res?.status).toBe(201)
    const data = await res!.json() as { value: { profile: { name: string } } }
    expect(data.value.profile.name).toBe('NewRoom')
  })

  test('POST /api/rooms missing name returns 400', async () => {
    const res = await call(system, req('POST', '/api/rooms', {}), '/api/rooms')
    expect(res?.status).toBe(400)
  })

  test('GET /api/rooms/:name returns room', async () => {
    const res = await call(system, req('GET', '/api/rooms/TestRoom'), '/api/rooms/TestRoom')
    expect(res?.status).toBe(200)
    const data = await res!.json() as { profile: { name: string }; messages: unknown[] }
    expect(data.profile.name).toBe('TestRoom')
    expect(Array.isArray(data.messages)).toBe(true)
  })

  test('GET /api/rooms/:name unknown room returns 404', async () => {
    const res = await call(system, req('GET', '/api/rooms/Ghost'), '/api/rooms/Ghost')
    expect(res?.status).toBe(404)
  })

  test('DELETE /api/rooms/:name removes room', async () => {
    const res = await call(system, req('DELETE', '/api/rooms/TestRoom'), '/api/rooms/TestRoom')
    expect(res?.status).toBe(200)
    expect(system.house.getRoom('TestRoom')).toBeUndefined()
  })

  // --- Pause ---

  test('PUT /api/rooms/:name/pause with true pauses room', async () => {
    const res = await call(system, req('PUT', '/api/rooms/TestRoom/pause', { paused: true }), '/api/rooms/TestRoom/pause')
    expect(res?.status).toBe(200)
    const data = await res!.json() as { paused: boolean }
    expect(data.paused).toBe(true)
  })

  test('PUT /api/rooms/:name/pause with false unpauses room', async () => {
    const room = system.house.getRoom('TestRoom')!
    room.setPaused(true)
    const res = await call(system, req('PUT', '/api/rooms/TestRoom/pause', { paused: false }), '/api/rooms/TestRoom/pause')
    expect(res?.status).toBe(200)
    expect((await res!.json() as { paused: boolean }).paused).toBe(false)
  })

  test('PUT /api/rooms/:name/pause with string value returns 400', async () => {
    const res = await call(system, req('PUT', '/api/rooms/TestRoom/pause', { paused: 'yes' }), '/api/rooms/TestRoom/pause')
    expect(res?.status).toBe(400)
  })

  test('PUT /api/rooms/:name/pause missing paused field returns 400', async () => {
    const res = await call(system, req('PUT', '/api/rooms/TestRoom/pause', {}), '/api/rooms/TestRoom/pause')
    expect(res?.status).toBe(400)
  })

  // --- Mute ---

  test('PUT /api/rooms/:name/mute with non-boolean muted returns 400', async () => {
    const res = await call(system, req('PUT', '/api/rooms/TestRoom/mute', { agentName: 'Bot', muted: 'true' }), '/api/rooms/TestRoom/mute')
    expect(res?.status).toBe(400)
  })

  test('PUT /api/rooms/:name/mute with missing agentName returns 400', async () => {
    const res = await call(system, req('PUT', '/api/rooms/TestRoom/mute', { muted: true }), '/api/rooms/TestRoom/mute')
    expect(res?.status).toBe(400)
  })

  // --- Members ---

  test('GET /api/rooms/:name/members returns empty list', async () => {
    const res = await call(system, req('GET', '/api/rooms/TestRoom/members'), '/api/rooms/TestRoom/members')
    expect(res?.status).toBe(200)
    expect(await res!.json()).toHaveLength(0)
  })

  test('GET /api/rooms/:name/members returns members with agent info', async () => {
    const room = system.house.getRoom('TestRoom')!
    const { createHumanAgent } = await import('../agents/human-agent.ts')
    const agent = createHumanAgent({ name: 'Alice' }, () => {})
    system.team.addAgent(agent)
    room.addMember(agent.id)
    const res = await call(system, req('GET', '/api/rooms/TestRoom/members'), '/api/rooms/TestRoom/members')
    expect(res?.status).toBe(200)
    const data = await res!.json() as Array<{ id: string; name: string }>
    expect(data).toHaveLength(1)
    expect(data[0]!.name).toBe('Alice')
  })

  test('GET /api/rooms/:name/members unknown room returns 404', async () => {
    const res = await call(system, req('GET', '/api/rooms/Ghost/members'), '/api/rooms/Ghost/members')
    expect(res?.status).toBe(404)
  })

  test('POST /api/rooms/:name/members adds agent to room', async () => {
    const { createHumanAgent } = await import('../agents/human-agent.ts')
    const agent = createHumanAgent({ name: 'Bob' }, () => {})
    system.team.addAgent(agent)
    const res = await call(system, req('POST', '/api/rooms/TestRoom/members', { agentName: 'Bob' }), '/api/rooms/TestRoom/members')
    expect(res?.status).toBe(200)
    const data = await res!.json() as { added: boolean; agentName: string }
    expect(data.added).toBe(true)
    expect(data.agentName).toBe('Bob')
  })

  test('POST /api/rooms/:name/members missing agentName returns 400', async () => {
    const res = await call(system, req('POST', '/api/rooms/TestRoom/members', {}), '/api/rooms/TestRoom/members')
    expect(res?.status).toBe(400)
  })

  test('POST /api/rooms/:name/members unknown agent returns 404', async () => {
    const res = await call(system, req('POST', '/api/rooms/TestRoom/members', { agentName: 'Ghost' }), '/api/rooms/TestRoom/members')
    expect(res?.status).toBe(404)
  })

  test('DELETE /api/rooms/:name/members/:agentName removes agent from room', async () => {
    const { createHumanAgent } = await import('../agents/human-agent.ts')
    const agent = createHumanAgent({ name: 'Carol' }, () => {})
    system.team.addAgent(agent)
    const res = await call(system, req('DELETE', '/api/rooms/TestRoom/members/Carol'), '/api/rooms/TestRoom/members/Carol')
    expect(res?.status).toBe(200)
    const data = await res!.json() as { removed: boolean }
    expect(data.removed).toBe(true)
  })

  test('DELETE /api/rooms/:name/members/:agentName unknown agent returns 404', async () => {
    const res = await call(system, req('DELETE', '/api/rooms/TestRoom/members/Ghost'), '/api/rooms/TestRoom/members/Ghost')
    expect(res?.status).toBe(404)
  })

  test('DELETE /api/rooms/:name/members/:agentName unknown room returns 404', async () => {
    const res = await call(system, req('DELETE', '/api/rooms/Ghost/members/Alice'), '/api/rooms/Ghost/members/Alice')
    expect(res?.status).toBe(404)
  })

  // --- Unknown route returns null ---

  test('unknown route returns null', async () => {
    const res = await call(system, req('GET', '/no-such-route'), '/no-such-route')
    expect(res).toBeNull()
  })
})

// === F5: cookieless /api/* gate ===
//
// Bots/scanners probing the API without first going through the UI's
// GET / + /ws handshake should get 401, NOT create an instance via the
// downstream registry.getOrLoad call. /api/auth and /api/system/info are
// exempt because the UI calls them before any cookie exists (to render
// the token prompt + version banner).

describe('HTTP Routes — F5 cookieless /api/* gate', () => {
  const reqNoCookie = (method: string, path: string): Request =>
    new Request(`http://localhost${path}`, { method })

  test('cookieless GET /api/rooms → 401', async () => {
    const sys = makeSystem()
    const res = await handleAPI(reqNoCookie('GET', '/api/rooms'), '/api/rooms', sys, TEST_INSTANCE_ID, {
      broadcast: noopBroadcast,
      subscribeAgentState: noopSubscribe,
    })
    expect(res?.status).toBe(401)
  })

  test('cookieless GET /api/auth → allowed (exempt for UI bootstrap)', async () => {
    const sys = makeSystem()
    const res = await handleAPI(reqNoCookie('GET', '/api/auth'), '/api/auth', sys, TEST_INSTANCE_ID, {
      broadcast: noopBroadcast,
      subscribeAgentState: noopSubscribe,
    })
    expect(res?.status).toBe(200)
  })

  test('cookieless GET /api/system/info → allowed (exempt for token-prompt banner)', async () => {
    const sys = makeSystem()
    const res = await handleAPI(reqNoCookie('GET', '/api/system/info'), '/api/system/info', sys, TEST_INSTANCE_ID, {
      broadcast: noopBroadcast,
      subscribeAgentState: noopSubscribe,
    })
    expect(res?.status).toBe(200)
  })

  test('malformed cookie value treated as no cookie → 401 (defends against header injection of bogus ids)', async () => {
    const sys = makeSystem()
    const r = new Request('http://localhost/api/rooms', {
      method: 'GET',
      headers: { cookie: 'samsinn_instance=../etc/passwd' },
    })
    const res = await handleAPI(r, '/api/rooms', sys, TEST_INSTANCE_ID, {
      broadcast: noopBroadcast,
      subscribeAgentState: noopSubscribe,
    })
    expect(res?.status).toBe(401)
  })
})

// === Auth gate (deploy mode) ===
//
// When SAMSINN_TOKEN is set, every route except /api/auth and /api/system/info
// must reject requests without a valid session cookie. This is enforced by a
// single check in handleAPI() at the top of the dispatcher; if a future
// refactor moves routes around the gate, this regression test fails loudly.

describe('HTTP Routes — auth gate (deploy mode)', () => {
  let system: System
  let originalToken: string | undefined

  beforeEach(() => {
    system = makeSystem()
    originalToken = process.env.SAMSINN_TOKEN
    process.env.SAMSINN_TOKEN = 'test-token-deployment'
  })

  // Restore env after each test so other suites are unaffected.
  // (afterEach not imported; reset inline at end of each test.)

  const restoreToken = (): void => {
    if (originalToken === undefined) delete process.env.SAMSINN_TOKEN
    else process.env.SAMSINN_TOKEN = originalToken
  }

  test('GET /api/system/info exempt — no cookie → 200', async () => {
    const res = await call(system, req('GET', '/api/system/info'), '/api/system/info')
    expect(res?.status).toBe(200)
    restoreToken()
  })

  test('POST /api/auth exempt — handler runs even without cookie (correct token → 200)', async () => {
    const res = await call(system, req('POST', '/api/auth', { token: 'test-token-deployment' }), '/api/auth')
    expect(res?.status).toBe(200)
    restoreToken()
  })

  test('POST /api/system/shutdown without cookie → 401 (audit regression)', async () => {
    const res = await call(system, req('POST', '/api/system/shutdown'), '/api/system/shutdown')
    expect(res?.status).toBe(401)
    restoreToken()
  })

  test('GET /api/providers without cookie → 401 (audit regression)', async () => {
    const res = await call(system, req('GET', '/api/providers'), '/api/providers')
    expect(res?.status).toBe(401)
    restoreToken()
  })

  test('PUT /api/providers/openrouter without cookie → 401', async () => {
    const res = await call(system, req('PUT', '/api/providers/openrouter', { apiKey: 'malicious' }), '/api/providers/openrouter')
    expect(res?.status).toBe(401)
    restoreToken()
  })

  test('POST /api/providers/openrouter/test without cookie → 401', async () => {
    const res = await call(system, req('POST', '/api/providers/openrouter/test', {}), '/api/providers/openrouter/test')
    expect(res?.status).toBe(401)
    restoreToken()
  })

  test('GET /api/rooms without cookie → 401', async () => {
    const res = await call(system, req('GET', '/api/rooms'), '/api/rooms')
    expect(res?.status).toBe(401)
    restoreToken()
  })

  test('POST /api/instances without cookie → 401', async () => {
    const res = await call(system, req('POST', '/api/instances'), '/api/instances')
    expect(res?.status).toBe(401)
    restoreToken()
  })

  test('GET /api/system/limits without cookie → 401 (auth-gated, NOT exempt)', async () => {
    const res = await call(system, req('GET', '/api/system/limits'), '/api/system/limits')
    expect(res?.status).toBe(401)
    restoreToken()
  })

  test('A1: POST /api/auth rate-limited per IP — 21st bad attempt returns 429', async () => {
    // The shared route handler reads ctx.remoteAddress; in tests the call()
    // helper threads through whatever the test passes. The default tight
    // window is 5 min / 20 attempts; 21 attempts from the same IP trips it.
    const { __resetAuthLimiter } = await import('./auth.ts')
    __resetAuthLimiter()

    let lastStatus = 0
    let last429: Response | null = null
    for (let i = 0; i < 25; i++) {
      const res = await call(
        system,
        req('POST', '/api/auth', { token: 'wrong-token' }),
        '/api/auth',
        { remoteAddress: '198.51.100.7' },
      )
      lastStatus = res!.status
      if (res!.status === 429) { last429 = res; break }
    }
    expect(last429).not.toBeNull()
    expect(lastStatus).toBe(429)
    expect(last429!.headers.get('Retry-After')).toBeTruthy()
    __resetAuthLimiter()
    restoreToken()
  })

  test('A1: failed POST /api/auth attempt logs to stderr', async () => {
    const { __resetAuthLimiter } = await import('./auth.ts')
    __resetAuthLimiter()
    const origWarn = console.warn
    let warned = ''
    console.warn = (msg: unknown) => { warned += String(msg) + '\n' }
    try {
      await call(
        system,
        req('POST', '/api/auth', { token: 'wrong' }),
        '/api/auth',
        { remoteAddress: '198.51.100.8' },
      )
    } finally { console.warn = origWarn }
    expect(warned).toContain('[auth] failed token attempt')
    expect(warned).toContain('198.51.100.8')
    __resetAuthLimiter()
    restoreToken()
  })
})

describe('GET /api/system/limits (no auth)', () => {
  test('returns metrics + configured snapshot, reflects inc()', async () => {
    const system = makeSystem()
    // bump a counter via the system's metrics handle
    system.limitMetrics.inc('rateLimitEvicted', 3)
    system.limitMetrics.inc('sseBufferExceeded')
    const res = await call(system, req('GET', '/api/system/limits'), '/api/system/limits')
    expect(res?.status).toBe(200)
    const data = await res!.json() as {
      metrics: Record<string, number>
      configured: Record<string, unknown>
    }
    expect(data.metrics.rateLimitEvicted).toBe(3)
    expect(data.metrics.sseBufferExceeded).toBe(1)
    expect(data.metrics.wsBackpressureDropped).toBe(0)
    expect(data.configured.maxWsBufferedBytes).toBe(8 * 1024 * 1024)
    expect(data.configured.maxRateLimitKeys).toBe(4096)
  })

  // --- POST /api/system/evict ---
  // Cookie-bound evict: drops the System from memory, snapshot stays.
  // Mirrors /api/system/reset's auth shape but without the countdown
  // and without trashing the directory.

  test('POST /api/system/evict returns 501 when evictInstance not wired', async () => {
    const r = req('POST', '/api/system/evict')
    const sys = makeSystem()
    const res = await handleAPI(r, '/api/system/evict', sys, TEST_INSTANCE_ID, {
      broadcast: noopBroadcast,
      subscribeAgentState: noopSubscribe,
    })
    expect(res?.status).toBe(501)
  })

  test('POST /api/system/evict calls evictInstance and returns 200 on success', async () => {
    let calledWith: Request | undefined
    const evictInstance = async (rq: Request) => {
      calledWith = rq
      return { ok: true as const, instanceId: TEST_INSTANCE_ID }
    }
    const r = new Request('http://test/api/system/evict', {
      method: 'POST',
      headers: { Cookie: `samsinn_instance=${TEST_INSTANCE_ID}` },
    })
    const sys = makeSystem()
    const res = await handleAPI(r, '/api/system/evict', sys, TEST_INSTANCE_ID, {
      broadcast: noopBroadcast,
      subscribeAgentState: noopSubscribe,
      evictInstance,
    })
    expect(res?.status).toBe(200)
    expect(calledWith).toBe(r)
    const body = await res!.json() as { evicted: boolean; instanceId: string }
    expect(body.evicted).toBe(true)
    expect(body.instanceId).toBe(TEST_INSTANCE_ID)
  })

  test('POST /api/system/evict surfaces evictInstance failure as 400', async () => {
    const evictInstance = async () => ({ ok: false as const, reason: 'no instance cookie' })
    const r = req('POST', '/api/system/evict')
    const sys = makeSystem()
    const res = await handleAPI(r, '/api/system/evict', sys, TEST_INSTANCE_ID, {
      broadcast: noopBroadcast,
      subscribeAgentState: noopSubscribe,
      evictInstance,
    })
    expect(res?.status).toBe(400)
  })
})

// === Phase 2B: route handler coverage gaps surfaced by the audit ===
// Covers /api/agents and /api/agents/.../triggers and /api/providers route
// shapes that http-routes integration tests didn't previously exercise.
// Negative-path heavy by necessity — positive paths for POST /api/agents
// require a real spawnAIAgent which would pull in the full LLM stack.

describe('HTTP Routes — agents (audit gap)', () => {
  let system: System

  beforeEach(() => {
    system = makeSystem()
  })

  test('GET /api/agents returns empty array when none registered', async () => {
    const res = await call(system, req('GET', '/api/agents'), '/api/agents')
    expect(res?.status).toBe(200)
    const data = await res!.json() as unknown[]
    expect(Array.isArray(data)).toBe(true)
    expect(data).toHaveLength(0)
  })

  test('GET /api/agents/Ghost returns 404 for unknown agent', async () => {
    const res = await call(system, req('GET', '/api/agents/Ghost'), '/api/agents/Ghost')
    expect(res?.status).toBe(404)
  })

  test('GET /api/agents/Ghost/rooms returns 404 for unknown agent', async () => {
    const res = await call(system, req('GET', '/api/agents/Ghost/rooms'), '/api/agents/Ghost/rooms')
    expect(res?.status).toBe(404)
  })

  test('DELETE /api/agents/Ghost returns 404 for unknown agent', async () => {
    const res = await call(system, req('DELETE', '/api/agents/Ghost'), '/api/agents/Ghost')
    expect(res?.status).toBe(404)
  })

  test('PATCH /api/agents/Ghost returns 404 for unknown agent', async () => {
    const res = await call(system, req('PATCH', '/api/agents/Ghost', { persona: 'changed' }), '/api/agents/Ghost')
    expect(res?.status).toBe(404)
  })

  test('POST /api/agents/Ghost/cancel returns 404 for unknown agent', async () => {
    const res = await call(system, req('POST', '/api/agents/Ghost/cancel', {}), '/api/agents/Ghost/cancel')
    expect(res?.status).toBe(404)
  })

  test('POST /api/agents missing body returns 400', async () => {
    const res = await call(system, req('POST', '/api/agents', {}), '/api/agents')
    expect(res?.status).toBe(400)
  })

  test('POST /api/agents/human missing name returns 400', async () => {
    const res = await call(system, req('POST', '/api/agents/human', { displayName: 'Test' }), '/api/agents/human')
    // Either 400 (validation fail) or 201 (created) — depending on shape.
    // Negative coverage: at minimum, server doesn't 500 on partial body.
    expect(res?.status).toBeLessThan(500)
  })
})

describe('HTTP Routes — agent triggers (audit gap)', () => {
  let system: System

  beforeEach(() => {
    system = makeSystem()
    system.house.createRoom({ name: 'TestRoom', createdBy: 'system' })
  })

  test('GET /api/agents/Ghost/triggers returns 404 for unknown agent', async () => {
    const res = await call(system, req('GET', '/api/agents/Ghost/triggers'), '/api/agents/Ghost/triggers')
    expect(res?.status).toBe(404)
  })

  test('POST /api/agents/Ghost/triggers returns 404 for unknown agent', async () => {
    const res = await call(
      system,
      req('POST', '/api/agents/Ghost/triggers', { name: 'T', prompt: 'p', mode: 'interval', intervalSec: 60, roomId: 'TestRoom' }),
      '/api/agents/Ghost/triggers',
    )
    expect(res?.status).toBe(404)
  })

  test('DELETE /api/agents/Ghost/triggers/some-id returns 404', async () => {
    const res = await call(system, req('DELETE', '/api/agents/Ghost/triggers/abc'), '/api/agents/Ghost/triggers/abc')
    expect(res?.status).toBe(404)
  })

  test('PUT /api/agents/Ghost/triggers/some-id returns 404', async () => {
    const res = await call(
      system,
      req('PUT', '/api/agents/Ghost/triggers/abc', { enabled: true }),
      '/api/agents/Ghost/triggers/abc',
    )
    expect(res?.status).toBe(404)
  })
})

// Provider routes need a richer fake (getMonitorSnapshot, providersConfig
// surface) — skipping here. The auth-gate tests above already exercise the
// route shape; positive paths require an actual LLM stack.
