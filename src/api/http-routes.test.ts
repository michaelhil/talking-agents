// ============================================================================
// HTTP Routes — integration tests exercising handleAPI directly.
// ============================================================================

import { describe, test, expect, beforeEach } from 'bun:test'
import { handleAPI } from './http-routes.ts'
import { createHouse } from '../core/house.ts'
import { createTeam } from '../agents/team.ts'
import { createToolRegistry } from '../core/tool-registry.ts'
import { createTaskListArtifactType } from '../core/artifact-types/task-list.ts'
import type { DeliverFn, WSOutbound } from '../core/types.ts'
import type { System } from '../main.ts'

// === Helpers ===

const noopDeliver: DeliverFn = () => {}
const noopBroadcast = (_msg: WSOutbound): void => {}
const noopSubscribe = (_id: string, _name: string): void => {}

const makeSystem = (): System => {
  const house = createHouse({ deliver: noopDeliver })
  house.artifactTypes.register(createTaskListArtifactType(house.artifacts))
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
    house, team, toolRegistry, ollama,
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
    setOnFlowEvent: () => {},
    setOnArtifactChanged: () => {},
    setOnRoomCreated: () => {},
    setOnRoomDeleted: () => {},
    setOnMembershipChanged: () => {},
    setOnEvalEvent: () => {},
  } as unknown as System
}

const req = (method: string, path: string, body?: unknown): Request => {
  const url = `http://localhost${path}`
  if (!body) return new Request(url, { method })
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const call = (system: System, r: Request, path: string) =>
  handleAPI(r, path, system, noopBroadcast, noopSubscribe)

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

  // --- Artifacts ---

  test('GET /api/rooms/:name/artifacts returns empty array initially', async () => {
    const res = await call(system, req('GET', '/api/rooms/TestRoom/artifacts'), '/api/rooms/TestRoom/artifacts')
    expect(res?.status).toBe(200)
    expect(await res!.json()).toHaveLength(0)
  })

  test('GET /api/artifacts returns all artifacts', async () => {
    const room = system.house.getRoom('TestRoom')!
    system.house.artifacts.add({ type: 'task_list', title: 'Tasks', body: { tasks: [] }, scope: [room.profile.id], createdBy: 'tester' })
    const res = await call(system, req('GET', '/api/artifacts'), '/api/artifacts')
    expect(res?.status).toBe(200)
    const data = await res!.json() as unknown[]
    expect(data.length).toBeGreaterThanOrEqual(1)
  })

  test('POST /api/artifacts creates artifact', async () => {
    const res = await call(system, req('POST', '/api/artifacts', {
      artifactType: 'task_list',
      title: 'Sprint',
      body: { tasks: [] },
      scope: ['TestRoom'],
    }), '/api/artifacts')
    expect(res?.status).toBe(201)
    const data = await res!.json() as { title: string; type: string; id: string }
    expect(data.title).toBe('Sprint')
    expect(data.type).toBe('task_list')
    expect(typeof data.id).toBe('string')
  })

  test('POST /api/artifacts missing artifactType returns 400', async () => {
    const res = await call(system, req('POST', '/api/artifacts', { title: 'No Type', body: {} }), '/api/artifacts')
    expect(res?.status).toBe(400)
  })

  test('PUT /api/artifacts/:id updates artifact', async () => {
    const room = system.house.getRoom('TestRoom')!
    const artifact = system.house.artifacts.add({ type: 'task_list', title: 'Old', body: { tasks: [] }, scope: [room.profile.id], createdBy: 'tester' })
    const path = `/api/artifacts/${artifact.id}`
    const res = await call(system, req('PUT', path, { title: 'New Title' }), path)
    expect(res?.status).toBe(200)
    const data = await res!.json() as { title: string }
    expect(data.title).toBe('New Title')
  })

  test('PUT /api/artifacts/:id unknown id returns 404', async () => {
    const path = '/api/artifacts/no-such-id'
    const res = await call(system, req('PUT', path, { title: 'X' }), path)
    expect(res?.status).toBe(404)
  })

  test('DELETE /api/artifacts/:id removes artifact', async () => {
    const room = system.house.getRoom('TestRoom')!
    const artifact = system.house.artifacts.add({ type: 'task_list', title: 'Doomed', body: { tasks: [] }, scope: [room.profile.id], createdBy: 'tester' })
    const path = `/api/artifacts/${artifact.id}`
    const res = await call(system, req('DELETE', path), path)
    expect(res?.status).toBe(200)
    expect(system.house.artifacts.get(artifact.id)).toBeUndefined()
  })

  test('DELETE /api/artifacts/:id unknown id returns 404', async () => {
    const path = '/api/artifacts/no-such-id'
    const res = await call(system, req('DELETE', path), path)
    expect(res?.status).toBe(404)
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
