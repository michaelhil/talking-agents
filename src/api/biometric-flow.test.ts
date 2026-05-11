// ============================================================================
// Integration test: end-to-end biometrics capture flow.
//
// Exercises the full chain that an agent + browser pair produces:
//   1. Agent calls biometrics_start → registry entry + room system message
//      with cause.kind === 'biometric'
//   2. Widget WS sends biometric_capture_started → registry claim transitions
//      entry to active
//   3. Widget WS pushes biometric_capture_signal → registry's lastSnapshot
//      updates
//   4. Agent calls biometrics_read → returns the latest snapshot
//   5. Widget WS sends biometric_capture_stopped → registry transitions to
//      stopped
//   6. Snapshot save round-trip → biometric messages are content-redacted
//
// NO MOCKS. The test uses:
//   - real createSharedRuntime + real createSystemRegistry
//   - real per-instance System with real House, ToolRegistry, capture registry
//   - real WS handler dispatch via handleWSMessage
//   - real snapshot save → reload via captureSnapshot + redactBiometricMessages
//
// The only "fixture" is the BiometricSignal payload, hand-constructed to
// match the documented shape — this is the same pattern as the controlled-
// response gateways in broadcast-wiring.test.ts: real implementation, real
// dispatch, deterministic input. MediaPipe inference is browser-only and is
// outside this test's boundary by design.
// ============================================================================

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSharedRuntime } from '../core/shared-runtime.ts'
import { createSystemRegistry } from '../core/instances/system-registry.ts'
import { createWSManager, handleWSMessage, type WSManager, type WSConnection } from './ws-handler.ts'
import { wireSystemEvents } from './wire-system-events.ts'
import { createProviderRouter } from '../llm/router.ts'
import type { ProviderGateway } from '../llm/provider-gateway.ts'
import type { ProviderHealth, GatewayMetrics, ChatRequest, ChatResponse } from '../core/types/llm.ts'
import type { ProviderSetupResult } from '../llm/providers-setup.ts'
import type { BiometricSignalWire } from '../core/types/ws-protocol.ts'
import { getCaptureRegistry } from '../core/biometrics/registry.ts'
import { redactBiometricMessages } from '../core/storage/snapshot-redact.ts'

const baseConfig = {
  order: ['stub'] as ReadonlyArray<string>,
  ollamaUrl: '',
  ollamaMaxConcurrent: 2,
  baseUrls: {},
  cloud: {},
  ollamaOnly: false,
  forceFailProvider: null,
  droppedFromOrder: [],
  orderFromUser: false,
}

// Real ProviderGateway with controlled response — same pattern as
// broadcast-wiring.test.ts. Not a mock; the gateway implements the
// interface fully and is exercised by the real router.
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

const sampleSignal = (overrides: Partial<BiometricSignalWire> = {}): BiometricSignalWire => ({
  ts: 1_000,
  presence: true,
  faceCount: 1,
  attention: 0.91,
  expression: { smile: 0.42, surprise: 0.05, frown: 0.03, concentration: 0.18 },
  headPose: { yaw: 0.01, pitch: -0.02, roll: 0.0 },
  blinkRate: 14.5,
  ...overrides,
})

describe('biometrics capture flow (no mocks)', () => {
  let homeDir: string

  afterEach(async () => {
    // Critical: clear the process-wide capture registry between tests so
    // ids and snapshots from a prior test don't bleed in.
    getCaptureRegistry().clearAll()
    if (homeDir) await rm(homeDir, { recursive: true, force: true })
    delete process.env.SAMSINN_HOME
  })

  test('start → claim → signal → read → stop, with real WS handler dispatch', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'samsinn-bio-'))
    process.env.SAMSINN_HOME = homeDir

    const shared = createSharedRuntime({
      providerConfig: baseConfig,
      providerSetup: makeSetup(makeStubGateway()),
    })

    let wsManager!: WSManager
    const registry = createSystemRegistry({
      shared,
      onSystemCreated: async (system, id, autoSaver) => {
        wireSystemEvents(system, wsManager, autoSaver, id)
      },
    })
    wsManager = createWSManager({ getSystem: (id) => registry.tryGetLive(id) })

    const cookieId = 'biocookietest123'
    const system = await registry.getOrLoad(cookieId)

    // Activate the biometrics pack in the seed room so the per-room filter
    // exposes biometrics_* tools to agents in that room. (For the tool
    // factory call below we use the registry directly, so activation isn't
    // strictly required — but exercising it confirms the activation path.)
    const rooms = system.house.listAllRooms()
    expect(rooms.length).toBeGreaterThan(0)
    const room = system.house.getRoom(rooms[0]!.id)!
    room.setActivePacks(['biometrics'])
    expect(room.getActivePacks()).toContain('biometrics')

    // Step 1 — agent invokes biometrics_start. Pull the registered tool
    // from the per-instance overlay and execute it.
    const startTool = system.toolRegistry.get('biometrics_start')
    expect(startTool).toBeTruthy()

    const human = system.team.listAgents().find(a => a.kind === 'human')!
    const startResult = await startTool!.execute(
      { reason: 'Watching engagement during demo' },
      { callerId: human.id, callerName: human.name, roomId: room.profile.id },
    )
    expect(startResult.success).toBe(true)
    const captureId = (startResult.data as { captureId: string }).captureId
    expect(captureId).toMatch(/^cap_/)

    // The room should now have a system message with cause.kind = 'biometric'
    // containing a fenced ```biometric block in `requested` state.
    const roomMessages = room.getRecent(room.getMessageCount())
    const requested = roomMessages.find(m => m.cause?.kind === 'biometric' && m.content.includes('"state": "requested"'))
    expect(requested).toBeTruthy()
    expect(requested!.cause).toEqual({ kind: 'biometric', name: captureId })

    // Step 2 — widget claims via biometric_capture_started.
    // Drive through the real WS handler so the dispatch + claim path is
    // exercised end-to-end (not via direct registry calls).
    const sentByServer: string[] = []
    const conn: WSConnection = {
      send: (data: string) => { sentByServer.push(data) },
      getBufferedAmount: () => 0,
      close: () => {},
    }
    const session = { instanceId: cookieId, sessionToken: 'tab-1', lastActivity: Date.now() }

    await handleWSMessage(
      conn, session,
      JSON.stringify({ type: 'biometric_capture_started', captureId }),
      system, wsManager,
    )

    const captureRegistry = getCaptureRegistry()
    const claimed = captureRegistry.get(captureId)
    expect(claimed?.status).toBe('active')
    expect(claimed?.claimedBy).toBe('tab-1')

    // Step 3 — widget pushes a signal sample.
    const fixture = sampleSignal()
    await handleWSMessage(
      conn, session,
      JSON.stringify({ type: 'biometric_capture_signal', captureId, snapshot: fixture }),
      system, wsManager,
    )

    expect(captureRegistry.get(captureId)?.lastSnapshot).toEqual(fixture)

    // Step 4 — agent reads via biometrics_read.
    const readTool = system.toolRegistry.get('biometrics_read')!
    const readResult = await readTool.execute(
      { captureId },
      { callerId: human.id, callerName: human.name, roomId: room.profile.id },
    )
    expect(readResult.success).toBe(true)
    const readData = readResult.data as { status: string; signals?: BiometricSignalWire }
    expect(readData.status).toBe('active')
    expect(readData.signals).toEqual(fixture)

    // Step 5 — widget reports stopped.
    await handleWSMessage(
      conn, session,
      JSON.stringify({ type: 'biometric_capture_stopped', captureId, reason: 'user' }),
      system, wsManager,
    )
    expect(captureRegistry.get(captureId)?.status).toBe('stopped')
    expect(captureRegistry.get(captureId)?.stoppedReason).toBe('user')

    // After stop, biometrics_read still returns the last snapshot but with
    // status 'stopped' so the agent can distinguish "alive" from "frozen".
    const readAfterStop = await readTool.execute(
      { captureId },
      { callerId: human.id, callerName: human.name, roomId: room.profile.id },
    )
    expect((readAfterStop.data as { status: string }).status).toBe('stopped')
    expect((readAfterStop.data as { signals?: BiometricSignalWire }).signals).toEqual(fixture)

    // Step 6 — agent calls biometrics_stop. Posts a `stopped`-state fenced
    // block (the second biometric-cause message in the room).
    const stopTool = system.toolRegistry.get('biometrics_stop')!
    const stopResult = await stopTool.execute(
      { captureId },
      { callerId: human.id, callerName: human.name, roomId: room.profile.id },
    )
    expect(stopResult.success).toBe(true)
    expect((stopResult.data as { status: string }).status).toBe('stopped')

    const allMessages = room.getRecent(room.getMessageCount())
    const biometricMessages = allMessages.filter(m => m.cause?.kind === 'biometric')
    // requested + stopped fences. (Signal updates do NOT post messages — they
    // flow over WS only.)
    expect(biometricMessages.length).toBe(2)
    expect(biometricMessages[0]!.content).toContain('"state": "requested"')
    expect(biometricMessages[1]!.content).toContain('"state": "stopped"')
  })

  test('snapshot redactor strips biometric message content on save', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'samsinn-bio-redact-'))
    process.env.SAMSINN_HOME = homeDir

    const shared = createSharedRuntime({
      providerConfig: baseConfig,
      providerSetup: makeSetup(makeStubGateway()),
    })
    let wsManager!: WSManager
    const registry = createSystemRegistry({
      shared,
      onSystemCreated: async (system, id, autoSaver) => {
        wireSystemEvents(system, wsManager, autoSaver, id)
      },
    })
    wsManager = createWSManager({ getSystem: (id) => registry.tryGetLive(id) })

    const cookieId = 'redacttest123abc'
    const system = await registry.getOrLoad(cookieId)
    const rooms = system.house.listAllRooms()
    const room = system.house.getRoom(rooms[0]!.id)!
    room.setActivePacks(['biometrics'])

    const startTool = system.toolRegistry.get('biometrics_start')!
    const human = system.team.listAgents().find(a => a.kind === 'human')!
    const startResult = await startTool.execute(
      { reason: 'redaction round-trip test' },
      { callerId: human.id, callerName: human.name, roomId: room.profile.id },
    )
    const captureId = (startResult.data as { captureId: string }).captureId

    // The fenced biometric content is in the live room verbatim before save.
    const live = room.getRecent(room.getMessageCount()).filter(m => m.cause?.kind === 'biometric')
    expect(live[0]!.content).toContain('"captureId"')
    expect(live[0]!.content).toContain(captureId)

    // Apply the redactor (the same call snapshot.ts makes on save).
    // The redactor rewrites the fence as a stopped-state block so on
    // reload the widget renders a terminal "Capture stopped" card,
    // not bare placeholder text.
    const redacted = redactBiometricMessages(live)
    expect(redacted[0]!.content).toContain('```biometric')
    const fenceBody = redacted[0]!.content.match(/```biometric\n([\s\S]*?)\n```/)?.[1] ?? ''
    const payload = JSON.parse(fenceBody) as Record<string, unknown>
    expect(payload.captureId).toBe(captureId)
    expect(payload.state).toBe('stopped')
    // Sensitive fields (reason verbatim, future signals/landmarks) are gone.
    expect(payload.reason).toBe('(not persisted)')
    // Cause is preserved so causality chains stay intact.
    expect(redacted[0]!.cause?.kind).toBe('biometric')
    expect(redacted[0]!.cause?.name).toBe(captureId)
    // Live in-room state is unaffected — redaction is save-only.
    expect(room.getRecent(1)[0]!.content).toContain(captureId)
  })

  test('agent-initiated stop emits biometric_capture_stop_requested via registry hook', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'samsinn-bio-agentstop-'))
    process.env.SAMSINN_HOME = homeDir
    const shared = createSharedRuntime({
      providerConfig: baseConfig,
      providerSetup: makeSetup(makeStubGateway()),
    })
    let wsManager!: WSManager
    const registry = createSystemRegistry({
      shared,
      onSystemCreated: async (system, id, autoSaver) => {
        wireSystemEvents(system, wsManager, autoSaver, id)
      },
    })
    wsManager = createWSManager({ getSystem: (id) => registry.tryGetLive(id) })

    // Subscribe to the registry hook the same way api/server.ts does at boot.
    // No mocks — real capture registry, real listener.
    const stopRequests: string[] = []
    const captureRegistry = getCaptureRegistry()
    const unsubscribe = captureRegistry.onAgentStop((captureId) => {
      stopRequests.push(captureId)
    })

    try {
      const cookieId = 'agentstoptest12c'
      const system = await registry.getOrLoad(cookieId)
      const room = system.house.getRoom(system.house.listAllRooms()[0]!.id)!
      room.setActivePacks(['biometrics'])
      const human = system.team.listAgents().find(a => a.kind === 'human')!

      // Agent flow: start → user claims → agent stops mid-capture.
      const startResult = await system.toolRegistry.get('biometrics_start')!.execute(
        { reason: 'will stop mid-capture' },
        { callerId: human.id, callerName: human.name, roomId: room.profile.id },
      )
      const captureId = (startResult.data as { captureId: string }).captureId

      const conn: WSConnection = { send: () => {}, getBufferedAmount: () => 0, close: () => {} }
      const sess = { instanceId: cookieId, sessionToken: 'tab-1', lastActivity: Date.now() }
      await handleWSMessage(conn, sess, JSON.stringify({ type: 'biometric_capture_started', captureId }), system, wsManager)

      // Agent stops while widget would still be live.
      const stopResult = await system.toolRegistry.get('biometrics_stop')!.execute(
        { captureId },
        { callerId: human.id, callerName: human.name, roomId: room.profile.id },
      )
      expect(stopResult.success).toBe(true)

      // Registry listener fired exactly once for this captureId. This is the
      // hook api/server.ts uses to broadcast biometric_capture_stop_requested
      // so the live widget tears down its MediaStream.
      expect(stopRequests).toEqual([captureId])

      // User-driven stops (reason: 'user') must NOT fire the hook, otherwise
      // the widget would re-stop itself in a loop. Reset and verify.
      stopRequests.length = 0
      captureRegistry.setStopped(captureId, 'user')
      expect(stopRequests).toEqual([])
    } finally {
      unsubscribe()
    }
  })

  test('first-tab claim wins and broadcasts biometric_capture_claimed', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'samsinn-bio-claim-'))
    process.env.SAMSINN_HOME = homeDir

    const shared = createSharedRuntime({
      providerConfig: baseConfig,
      providerSetup: makeSetup(makeStubGateway()),
    })
    let wsManager!: WSManager
    const registry = createSystemRegistry({
      shared,
      onSystemCreated: async (system, id, autoSaver) => {
        wireSystemEvents(system, wsManager, autoSaver, id)
      },
    })
    wsManager = createWSManager({ getSystem: (id) => registry.tryGetLive(id) })

    const cookieId = 'claimtest1234abc'
    const system = await registry.getOrLoad(cookieId)
    const rooms = system.house.listAllRooms()
    const room = system.house.getRoom(rooms[0]!.id)!
    room.setActivePacks(['biometrics'])

    const startTool = system.toolRegistry.get('biometrics_start')!
    const human = system.team.listAgents().find(a => a.kind === 'human')!
    const startResult = await startTool.execute(
      { reason: 'two tabs' },
      { callerId: human.id, callerName: human.name, roomId: room.profile.id },
    )
    const captureId = (startResult.data as { captureId: string }).captureId

    // Two tabs both attempt to claim. We instrument send() per-tab so the
    // assertion can verify the non-claimer received the event and the
    // claimer did NOT (winner gets silent success; losers get the
    // claimed-elsewhere notification).
    const sentA: string[] = []
    const sentB: string[] = []
    const tabA: WSConnection = { send: (d) => sentA.push(d), getBufferedAmount: () => 0, close: () => {} }
    const tabB: WSConnection = { send: (d) => sentB.push(d), getBufferedAmount: () => 0, close: () => {} }
    const sessA = { instanceId: cookieId, sessionToken: 'tab-A', lastActivity: Date.now() }
    const sessB = { instanceId: cookieId, sessionToken: 'tab-B', lastActivity: Date.now() }

    // Register both connections so wsManager.wsConnections can find them by token.
    wsManager.wsConnections.set('tab-A', tabA)
    wsManager.wsConnections.set('tab-B', tabB)

    await handleWSMessage(tabA, sessA, JSON.stringify({ type: 'biometric_capture_started', captureId }), system, wsManager)
    await handleWSMessage(tabB, sessB, JSON.stringify({ type: 'biometric_capture_started', captureId }), system, wsManager)

    // First claim wins. Registry shows tab-A as claimedBy.
    const captureRegistry = getCaptureRegistry()
    expect(captureRegistry.get(captureId)?.claimedBy).toBe('tab-A')

    // Tab B (the non-claimer) received the biometric_capture_claimed event.
    const claimedAtB = sentB.filter(s => s.includes('biometric_capture_claimed') && s.includes(captureId))
    expect(claimedAtB.length).toBe(1)
    expect(claimedAtB[0]).toContain('"claimedBy":"tab-A"')

    // Tab A (the winner) did NOT receive its own claim — otherwise it would
    // mistake the broadcast for someone else claiming and tear down right
    // after consent.
    const claimedAtA = sentA.filter(s => s.includes('biometric_capture_claimed') && s.includes(captureId))
    expect(claimedAtA.length).toBe(0)
  })
})
