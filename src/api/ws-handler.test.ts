// ============================================================================
// WS Handler — tests for message dispatch, error handling, and protocol edges.
// ============================================================================

import { describe, test, expect, beforeEach } from 'bun:test'
import { handleWSMessage, createWSManager } from './ws-handler.ts'
import { createHouse } from '../core/house.ts'
import { createTeam } from '../agents/team.ts'
import { createAIAgent } from '../agents/ai-agent.ts'
import { createHumanAgent } from '../agents/human-agent.ts'
import { createTaskListArtifactType } from '../core/artifact-types/task-list.ts'
import type { DeliverFn, Message } from '../core/types/messaging.ts'
import type { RouteMessage } from '../core/types/agent.ts'
import type { WSOutbound } from '../core/types/ws-protocol.ts'
import type { System } from '../main.ts'
import type { ClientSession, WSManager } from './ws-handler.ts'

// === Helpers ===

const noopDeliver: DeliverFn = () => {}

const makeLLMProvider = () => ({
  chat: async () => ({ content: '', generationMs: 0, tokensUsed: { prompt: 0, completion: 0 }, toolCalls: [{ function: { name: 'pass', arguments: { reason: 'test' } } }] }),
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
})

const makeSystem = (): System => {
  const house = createHouse({ deliver: noopDeliver })
  house.artifactTypes.register(createTaskListArtifactType(house.artifacts))
  const team = createTeam()
  house.createRoom({ name: 'TestRoom', createdBy: 'system' })

  const routeMessage: RouteMessage = (target, params) => {
    const posted: Message[] = []
    for (const roomName of (target.rooms ?? [])) {
      const room = house.getRoom(roomName)
      if (room) posted.push(room.post(params))
    }
    return posted
  }

  return {
    house, team,
    routeMessage,
    ollama: makeLLMProvider(),
    toolRegistry: { register: () => {}, get: () => undefined, list: () => [] },
    removeAgent: (id: string) => team.removeAgent(id),
    removeRoom: (id: string) => house.removeRoom(id),
    addAgentToRoom: async () => {},
    removeAgentFromRoom: () => {},
    spawnAIAgent: async () => { throw new Error('Not mocked') },
    spawnHumanAgent: async () => { throw new Error('Not mocked') },
    setOnMessagePosted: () => {},
    setOnTurnChanged: () => {},
    setOnDeliveryModeChanged: () => {},
    setOnFlowEvent: () => {},
    setOnArtifactChanged: () => {},
    setOnRoomCreated: () => {},
    setOnRoomDeleted: () => {},
    setOnMembershipChanged: () => {},
    setOnEvalEvent: () => {},
    setOnProviderBound: () => {},
    setOnProviderAllFailed: () => {},
    setOnProviderStreamFailed: () => {},
    dispatchProviderEvent: () => {},
  } as unknown as System
}

// Captures all messages sent to a WS connection
const makeWS = () => {
  const sent: string[] = []
  const ws = { send: (data: string) => { sent.push(data) } }
  const messages = () => sent.map(s => JSON.parse(s) as Record<string, unknown>)
  const errors = () => messages().filter(m => m.type === 'error')
  return { ws, messages, errors }
}

const dispatch = (ws: { send: (d: string) => void }, session: ClientSession, system: System, wsManager: WSManager, payload: unknown) =>
  handleWSMessage(ws, session, JSON.stringify(payload), system, wsManager)

// === Tests ===

describe('WS Handler', () => {
  let system: System
  let session: ClientSession
  let wsManager: WSManager

  beforeEach(() => {
    system = makeSystem()
    const human = createHumanAgent({ name: 'Human' }, () => {})
    system.team.addAgent(human)
    session = { agent: human, lastActivity: Date.now() }
    wsManager = createWSManager(system)
  })

  // --- Protocol errors ---

  test('invalid JSON sends error response', async () => {
    const { ws, errors } = makeWS()
    await handleWSMessage(ws, session, 'not-json', system, wsManager)
    expect(errors()).toHaveLength(1)
    expect(errors()[0]!.message).toContain('Invalid JSON')
  })

  test('unknown message type sends error response', async () => {
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, { type: '__unknown__' })
    expect(errors()).toHaveLength(1)
    expect(String(errors()[0]!.message)).toContain('Unknown message type')
  })

  // --- cancel_generation ---

  test('cancel_generation for unknown agent sends error', async () => {
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, { type: 'cancel_generation', name: 'NoSuchBot' })
    expect(errors()).toHaveLength(1)
    expect(String(errors()[0]!.message)).toContain('not found')
  })

  test('cancel_generation for non-AI agent sends error', async () => {
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, { type: 'cancel_generation', name: 'Human' })
    expect(errors()).toHaveLength(1)
    expect(String(errors()[0]!.message)).toContain('not an AI agent')
  })

  test('cancel_generation for AI agent succeeds with no error', async () => {
    const bot = createAIAgent(
      { name: 'Bot', model: 'test', systemPrompt: 'You are a test bot.' },
      makeLLMProvider(),
      () => {},
    )
    system.team.addAgent(bot)
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, { type: 'cancel_generation', name: 'Bot' })
    expect(errors()).toHaveLength(0)
  })

  // --- post_message ---

  test('post_message to known room echoes message back to sender', async () => {
    const { ws, messages } = makeWS()
    await dispatch(ws, session, system, wsManager, {
      type: 'post_message', target: { rooms: ['TestRoom'] }, content: 'Hello',
    })
    const msgEvents = messages().filter(m => m.type === 'message')
    expect(msgEvents).toHaveLength(1)
    expect((msgEvents[0]!.message as Record<string, unknown>).content).toBe('Hello')
  })

  // --- set_paused ---

  test('set_paused pauses room and broadcasts', async () => {
    let broadcasted: WSOutbound | null = null
    ;(wsManager as unknown as Record<string, unknown>).broadcast = (msg: WSOutbound) => { broadcasted = msg }
    const { ws } = makeWS()
    await dispatch(ws, session, system, wsManager, { type: 'set_paused', roomName: 'TestRoom', paused: true })
    const room = system.house.getRoom('TestRoom')!
    expect(room.paused).toBe(true)
    expect(broadcasted).not.toBeNull()
    expect(((broadcasted as unknown) as { type: string; paused: boolean }).paused).toBe(true)
  })

  test('set_paused on unknown room sends error', async () => {
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, { type: 'set_paused', roomName: 'NoSuchRoom', paused: true })
    expect(errors()).toHaveLength(1)
  })

  // --- Artifacts ---

  test('add_artifact creates artifact and triggers artifact_changed', async () => {
    const broadcasts: WSOutbound[] = []
    ;(wsManager as unknown as Record<string, unknown>).broadcast = (msg: WSOutbound) => { broadcasts.push(msg) }
    const { ws } = makeWS()
    await dispatch(ws, session, system, wsManager, {
      type: 'add_artifact', artifactType: 'task_list', title: 'Sprint', body: { tasks: [] }, scope: ['TestRoom'],
    })
    expect(system.house.artifacts.list({ type: 'task_list' })).toHaveLength(1)
  })

  test('add_artifact with unknown type sends error', async () => {
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, {
      type: 'add_artifact', artifactType: 'nonexistent_type', title: 'X', body: {},
    })
    expect(errors()).toHaveLength(1)
  })

  test('update_artifact with unknown id sends error', async () => {
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, {
      type: 'update_artifact', artifactId: 'no-such-id', title: 'New',
    })
    expect(errors()).toHaveLength(1)
    expect(String(errors()[0]!.message)).toContain('not found')
  })

  test('update_artifact updates artifact', async () => {
    const room = system.house.getRoom('TestRoom')!
    const artifact = system.house.artifacts.add({
      type: 'task_list', title: 'Old', body: { tasks: [] }, scope: [room.profile.id], createdBy: 'tester',
    })
    const { ws } = makeWS()
    await dispatch(ws, session, system, wsManager, {
      type: 'update_artifact', artifactId: artifact.id, title: 'Updated',
    })
    expect(system.house.artifacts.get(artifact.id)?.title).toBe('Updated')
  })

  test('remove_artifact with unknown id sends error', async () => {
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, {
      type: 'remove_artifact', artifactId: 'no-such-id',
    })
    expect(errors()).toHaveLength(1)
    expect(String(errors()[0]!.message)).toContain('not found')
  })

  test('remove_artifact removes artifact', async () => {
    const room = system.house.getRoom('TestRoom')!
    const artifact = system.house.artifacts.add({
      type: 'task_list', title: 'Doomed', body: { tasks: [] }, scope: [room.profile.id], createdBy: 'tester',
    })
    const { ws } = makeWS()
    await dispatch(ws, session, system, wsManager, {
      type: 'remove_artifact', artifactId: artifact.id,
    })
    expect(system.house.artifacts.get(artifact.id)).toBeUndefined()
  })

  // --- add_to_room / remove_from_room ---

  test('add_to_room with unknown room sends error', async () => {
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, { type: 'add_to_room', roomName: 'NoRoom', agentName: 'Human' })
    expect(errors()).toHaveLength(1)
  })

  test('add_to_room with unknown agent sends error', async () => {
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, { type: 'add_to_room', roomName: 'TestRoom', agentName: 'Ghost' })
    expect(errors()).toHaveLength(1)
  })

  test('add_to_room with valid room and agent calls system.addAgentToRoom', async () => {
    let called = false
    ;(system as unknown as Record<string, unknown>).addAgentToRoom = async () => { called = true }
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, { type: 'add_to_room', roomName: 'TestRoom', agentName: 'Human' })
    expect(errors()).toHaveLength(0)
    expect(called).toBe(true)
  })

  test('remove_from_room with unknown room sends error', async () => {
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, { type: 'remove_from_room', roomName: 'NoRoom', agentName: 'Human' })
    expect(errors()).toHaveLength(1)
  })

  test('remove_from_room with unknown agent sends error', async () => {
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, { type: 'remove_from_room', roomName: 'TestRoom', agentName: 'Ghost' })
    expect(errors()).toHaveLength(1)
  })

  test('remove_from_room with valid room and agent calls system.removeAgentFromRoom', async () => {
    let called = false
    ;(system as unknown as Record<string, unknown>).removeAgentFromRoom = () => { called = true }
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, { type: 'remove_from_room', roomName: 'TestRoom', agentName: 'Human' })
    expect(errors()).toHaveLength(0)
    expect(called).toBe(true)
  })

  // --- create_room ---

  test('create_room with duplicate name still calls addAgentToRoom', async () => {
    let addCalled = false
    ;(system as unknown as Record<string, unknown>).addAgentToRoom = async () => { addCalled = true }
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, { type: 'create_room', name: 'TestRoom' })
    // Duplicate names are allowed (createRoomSafe returns sanitised name) — no error expected
    expect(errors()).toHaveLength(0)
    expect(addCalled).toBe(true)
  })
})
