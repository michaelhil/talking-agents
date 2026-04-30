// ============================================================================
// Integration test: cookie-bound instances get full broadcast wiring.
//
// The bug fixed in 5d73a8e was that wireSystemEvents was silently skipped
// for non-boot instances because onSystemCreated ran before the registry's
// internal map.set() — autoSaverFor(id) returned null, the `if (autoSaver)`
// guard short-circuited, and every cookie-bound instance booted with
// setOnEvalEvent / setOnMessagePosted / state.subscribe all unwired.
//
// This test proves end-to-end that an instance loaded via the registry
// path (the cookie-bound code path) has live broadcast wiring: posting a
// message into one of its rooms fans out via wsManager.broadcastToInstance
// scoped to that instance.
//
// First assertion is the harness sanity check: the system's snapshot has
// at least one room. If that fails the test setup is broken and we'd be
// chasing a phantom in the next assertions.
// ============================================================================

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSharedRuntime } from '../core/shared-runtime.ts'
import { createSystemRegistry } from '../core/system-registry.ts'
import { createWSManager, type WSManager } from './ws-handler.ts'
import { wireSystemEvents } from './wire-system-events.ts'
import { createProviderRouter } from '../llm/router.ts'
import type { ProviderGateway } from '../llm/provider-gateway.ts'
import type { ProviderHealth, GatewayMetrics, ChatRequest, ChatResponse } from '../core/types/llm.ts'
import type { ProviderSetupResult } from '../llm/providers-setup.ts'
import type { WSOutbound } from '../core/types/ws-protocol.ts'

const baseConfig = {
  order: ['stub'] as ReadonlyArray<string>,
  ollamaUrl: '',
  ollamaMaxConcurrent: 2,
  cloud: {},
  ollamaOnly: false,
  forceFailProvider: null,
  droppedFromOrder: [],
  orderFromUser: false,
}

// Minimal echo gateway — no streaming needed for this test (we trigger
// onMessagePosted via routeMessage, not an LLM call).
const makeStubGateway = (): ProviderGateway => {
  const health: ProviderHealth = {
    status: 'healthy', latencyMs: 0,
    availableModels: ['mock-model'],
    lastCheckedAt: Date.now(),
  }
  const metrics: GatewayMetrics = {
    requestCount: 0, errorCount: 0, errorRate: 0,
    p50Latency: 0, p95Latency: 0, avgTokensPerSecond: 0,
    queueDepth: 0, concurrentRequests: 0,
    circuitState: 'closed', shedCount: 0, windowMs: 300_000,
  }
  return {
    chat: async (_req: ChatRequest): Promise<ChatResponse> =>
      ({ content: 'ok', generationMs: 0, tokensUsed: { prompt: 1, completion: 1 } }),
    stream: async function* () { throw new Error('not used in this test') },
    models: async () => [...health.availableModels],
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
    recordExternalFailure: () => {},
    dispose: () => {},
  }
}

const makeSetup = (gateway: ProviderGateway): ProviderSetupResult => {
  const router = createProviderRouter({ stub: gateway }, { order: ['stub'] })
  return { router, gateways: { stub: gateway }, monitors: {}, dispose: () => router.dispose() }
}

describe('cookie-bound instance broadcast wiring (regression for 5d73a8e)', () => {
  let homeDir: string

  afterEach(async () => {
    if (homeDir) await rm(homeDir, { recursive: true, force: true })
    delete process.env.SAMSINN_HOME
  })

  test('routeMessage in a cookie-bound instance reaches broadcastToInstance', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'samsinn-streaming-'))
    process.env.SAMSINN_HOME = homeDir

    const shared = createSharedRuntime({
      providerConfig: baseConfig,
      providerSetup: makeSetup(makeStubGateway()),
    })

    // Forward-declared wsManager — the registry's onSystemCreated closes over
    // this. The bootstrap pattern relies on wsManager being assigned before
    // any registry.getOrLoad() runs.
    let wsManager!: WSManager
    const broadcasts: Array<{ instanceId: string; msg: WSOutbound }> = []

    const registry = createSystemRegistry({
      shared,
      onSystemCreated: async (system, id, autoSaver) => {
        // The exact same call that bootstrap.ts makes — this is the wiring
        // the bug skipped.
        wireSystemEvents(system, wsManager, autoSaver, id)
      },
    })

    // Construct wsManager AFTER registry but BEFORE the first getOrLoad.
    // Wrap broadcastToInstance to record what would have hit the WS.
    const baseWs = createWSManager({ getSystem: (id) => registry.tryGetLive(id) })
    wsManager = {
      ...baseWs,
      broadcastToInstance: (instanceId, msg) => {
        broadcasts.push({ instanceId, msg })
        baseWs.broadcastToInstance(instanceId, msg)
      },
    }

    // The bug only manifested for non-boot instances loaded by cookie. Use
    // an explicit cookie-shaped id (16 chars, lowercase alphanumeric) so we
    // exercise that exact path.
    const cookieId = 'cookieinst123abc'
    const sys = await registry.getOrLoad(cookieId)

    // Harness sanity: the seed should have produced at least one room.
    // If this is empty, we'd misdiagnose missing wiring as missing room.
    const rooms = sys.house.listAllRooms()
    expect(rooms.length).toBeGreaterThan(0)

    // Trigger a message that fires onMessagePosted. This is the chain the
    // bug broke: room.post -> onMessagePosted (via lateBinding proxy) ->
    // wireSystemEvents-installed callback -> broadcastToInstance.
    sys.routeMessage(
      { rooms: [rooms[0]!.id] },
      { senderId: 'system', senderName: 'system', content: 'test note', type: 'system' },
    )

    // The broadcast must have reached our instrumented broadcastToInstance,
    // scoped to OUR cookie-bound instanceId. Pre-fix behavior: zero entries.
    const our = broadcasts.filter(b => b.instanceId === cookieId)
    expect(our.length).toBeGreaterThan(0)
    expect(our.some(b => b.msg.type === 'message')).toBe(true)
  })
})
