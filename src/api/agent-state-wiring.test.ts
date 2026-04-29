// ============================================================================
// Integration test: per-agent state subscription is wired for ALL agent
// creation paths — including the seeded path.
//
// REGRESSION CONTEXT
// The bug surfaced after the wiki feature shipped. With wikis bound to a
// room, gemini-2.5-pro tool-loops 5–15 s per turn, exposing dead-air the
// UI used to hide. During that dead-air the user expected the thinking
// indicator. There was none. Why:
//
//   - subscribeAgentState turns agent.state.notifyState() into an
//     `agent_state` WS broadcast. Without it, the UI's $agents store never
//     transitions to 'generating', no thinking indicator is created, and
//     `agent_activity` chunk events arrive at a connected client with
//     nowhere to render.
//
//   - subscribeAgentState was called in 3 places: REST agent-create,
//     WS agent-create, and a one-shot init-loop in wireSystemEvents that
//     iterated `system.team.listAgents()` at wire time. The init-loop
//     covered SNAPSHOT-RESTORED agents (which exist before wireSystemEvents
//     runs). It did NOT cover agents spawned AFTER wire — including
//     seedFreshInstance's Helper, script-engine cast members, and any
//     programmatic spawn. They silently bypassed subscription.
//
// FIX (bootstrap.ts wireAgentTracking + wire-system-events.ts init-loop)
//   - Per-agent subscription is centralized in the wireAgentTracking spawn
//     wrapper. Every system.spawnAIAgent / spawnHumanAgent / removeAgent
//     call goes through it. Subscribe is idempotent so the wrapper coexists
//     with the snapshot-init-loop in wireSystemEvents.
//   - REST + WS handlers no longer call subscribeAgentState themselves.
//
// WHAT THIS TEST PROVES
//   1. The seed path (no snapshot, no REST/WS create) ends with
//      subscribeAgentState having been called for the seeded agent.
//   2. Triggering the agent's eval (via agent.receive with a stub LLM)
//      causes an `agent_state` broadcast scoped to the cookie's
//      instanceId — the exact chain the UI relies on.
// ============================================================================

import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSharedRuntime } from '../core/shared-runtime.ts'
import { createSystemRegistry } from '../core/system-registry.ts'
import { createWSManager, type WSManager } from './ws-handler.ts'
import { wireSystemEvents } from './wire-system-events.ts'
import { wireAgentTracking } from './agent-tracking.ts'
import { createProviderRouter } from '../llm/router.ts'
import type { ProviderGateway } from '../llm/provider-gateway.ts'
import type { ProviderHealth, GatewayMetrics, ChatRequest, ChatResponse } from '../core/types/llm.ts'
import type { ProviderSetupResult } from '../llm/providers-setup.ts'
import type { WSOutbound } from '../core/types/ws-protocol.ts'
import type { AutoSaver } from '../core/snapshot.ts'

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

// Stub gateway — returns 'ok' immediately. The seed model name (claude-haiku-4-5)
// doesn't have to be in availableModels because spawnAIAgent doesn't validate.
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
      ({ content: 'pong', generationMs: 1, tokensUsed: { prompt: 1, completion: 1 } }),
    stream: async function* () { /* no streaming — chat() path is exercised */ },
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
  return { router, gateways: { stub: gateway }, dispose: () => router.dispose() }
}

describe('per-agent state subscription is wired for every spawn path', () => {
  let homeDir: string

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'samsinn-agent-state-'))
    process.env.SAMSINN_HOME = homeDir
  })

  afterEach(async () => {
    if (homeDir) await rm(homeDir, { recursive: true, force: true })
    delete process.env.SAMSINN_HOME
  })

  test('seed-spawned agent: subscribeAgentState IS called and agent_state broadcasts arrive', async () => {
    const shared = createSharedRuntime({
      providerConfig: baseConfig,
      providerSetup: makeSetup(makeStubGateway()),
    })

    let wsManager!: WSManager
    // Synthetic broadcast log — the test's subscribe-callback emits the
    // SAME shape that wsManager.subscribeAgentState would emit, so we can
    // verify the spawn-wrapper drives the chain end-to-end without relying
    // on wsManager's internal closure (which captures baseWs.broadcastTo
    // Instance and is invisible to outer instrumentation).
    const broadcasts: Array<{ instanceId: string; msg: WSOutbound }> = []
    const subscribed: Array<{ agentId: string; agentName: string; instanceId: string }> = []

    const registry = createSystemRegistry({
      shared,
      onSystemCreated: async (system, id, autoSaver: AutoSaver) => {
        // Simulate bootstrap.ts's first async step (logging.configure).
        // Critical: this releases a microtask, so if buildSystem doesn't
        // await this hook, seedFreshInstance races ahead and spawns Helper
        // BEFORE wireAgentTracking installs its spawn-wrapper. The race-fix
        // in system-registry.ts must await opts.onSystemCreated.
        await new Promise(r => setImmediate(r))

        wireAgentTracking(system, id, {
          attach: registry.attachAgent,
          detach: registry.detachAgent,
          subscribeAgentState: (agent, instId) => {
            // Record + install a state.subscribe that mirrors what
            // wsManager.subscribeAgentState does internally. Asserting on
            // `broadcasts` then proves: (a) the wrapper invoked us for
            // the seeded agent, and (b) state transitions actually flow.
            if (agent.kind !== 'ai') return
            subscribed.push({ agentId: agent.id, agentName: agent.name, instanceId: instId })
            const agentName = agent.name
            agent.state.subscribe((state, _agentId, context) => {
              broadcasts.push({
                instanceId: instId,
                msg: { type: 'agent_state', agentName, state, ...(context !== undefined ? { context } : {}) },
              })
            })
          },
          unsubscribeAgentState: () => { /* exercised by the second test */ },
        })
        wireSystemEvents(system, wsManager, autoSaver, id)
      },
    })

    const baseWs = createWSManager({ getSystem: (id) => registry.tryGetLive(id) })
    wsManager = baseWs

    const cookieId = 'cookieinst123abc'
    const sys = await registry.getOrLoad(cookieId)

    // 1. Seed must have produced exactly one AI agent (Helper).
    const aiAgents = sys.team.listAgents().filter(a => a.kind === 'ai')
    expect(aiAgents.length).toBe(1)
    const helper = aiAgents[0]!
    expect(helper.name).toBe('Helper')

    // 2. Per-agent subscription must have been routed through the wrapper.
    // Pre-fix: zero entries — the only places that called subscribeAgentState
    // were REST/WS handlers (none ran here) and the wireSystemEvents init-
    // loop (which iterated team BEFORE seed spawned Helper).
    const subForHelper = subscribed.filter(s => s.agentId === helper.id && s.instanceId === cookieId)
    expect(subForHelper).toHaveLength(1)

    // 3. End-to-end: trigger Helper's eval via the same path the UI uses
    // (post a message, addressed to Helper). The stub LLM returns instantly,
    // so the agent transitions generating → idle. Both transitions should
    // produce `agent_state` broadcasts scoped to OUR cookie's instance.
    const room = sys.house.listAllRooms()[0]
    expect(room).toBeDefined()
    sys.routeMessage(
      { rooms: [room!.id] },
      { senderId: 'system', senderName: 'system', content: '[[Helper]] ping', type: 'chat' },
    )

    // The eval is async (it goes through the stub LLM). Poll for state events
    // up to 2s. The stub returns instantly so 'generating' should fire within
    // a tick or two.
    let stateEvents: typeof broadcasts = []
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      stateEvents = broadcasts.filter(b =>
        b.instanceId === cookieId && b.msg.type === 'agent_state' &&
        (b.msg as { agentName?: string }).agentName === 'Helper',
      )
      if (stateEvents.length > 0) break
      await new Promise(r => setTimeout(r, 25))
    }
    if (stateEvents.length === 0) {
      // Diagnostic: dump what DID broadcast for Helper or this instance.
      const types = broadcasts.filter(b => b.instanceId === cookieId).map(b => b.msg.type)
      throw new Error(`No agent_state broadcasts for Helper. Got ${broadcasts.length} broadcasts total; types for cookieId: [${types.join(', ')}]`)
    }
    const generating = stateEvents.find(b => (b.msg as { state?: string }).state === 'generating')
    expect(generating).toBeDefined()
  })

  test('removeAgent path: unsubscribeAgentState is called by the wrapper', async () => {
    const shared = createSharedRuntime({
      providerConfig: baseConfig,
      providerSetup: makeSetup(makeStubGateway()),
    })

    let wsManager!: WSManager
    const unsubscribed: string[] = []

    const registry = createSystemRegistry({
      shared,
      onSystemCreated: async (system, id, autoSaver: AutoSaver) => {
        wireAgentTracking(system, id, {
          attach: registry.attachAgent,
          detach: registry.detachAgent,
          subscribeAgentState: wsManager.subscribeAgentState,
          unsubscribeAgentState: (agentId) => {
            unsubscribed.push(agentId)
            wsManager.unsubscribeAgentState(agentId)
          },
        })
        wireSystemEvents(system, wsManager, autoSaver, id)
      },
    })

    const baseWs = createWSManager({ getSystem: (id) => registry.tryGetLive(id) })
    wsManager = baseWs

    const sys = await registry.getOrLoad('cookieinst123abc')
    const helper = sys.team.listAgents().find(a => a.kind === 'ai')!
    expect(helper.name).toBe('Helper')

    sys.removeAgent(helper.id)
    expect(unsubscribed).toContain(helper.id)
  })
})
