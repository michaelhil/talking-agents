// ============================================================================
// WS Handler — tests for message dispatch, error handling, and protocol edges.
// ============================================================================

import { describe, test, expect, beforeEach } from 'bun:test'
import { handleWSMessage, createWSManager } from './ws-handler.ts'
import { createHouse } from '../core/house.ts'
import { createTeam } from '../agents/team.ts'
import { createAIAgent } from '../agents/ai-agent.ts'
import { createHumanAgent } from '../agents/human-agent.ts'
import type { DeliverFn, LLMProvider, Message, RouteMessage, WSOutbound } from '../core/types.ts'
import type { System } from '../main.ts'
import type { ClientSession, WSManager } from './ws-handler.ts'

// === Helpers ===

const noopDeliver: DeliverFn = () => {}

const makeLLMProvider = (): LLMProvider => ({
  chat: async () => ({ content: '::PASS::', generationMs: 0, tokensUsed: { prompt: 0, completion: 0 } }),
  models: async () => [],
  runningModels: async () => [],
})

const makeSystem = (): System => {
  const house = createHouse({ deliver: noopDeliver })
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
    setOnTodoChanged: () => {},
    setOnRoomCreated: () => {},
    setOnRoomDeleted: () => {},
    setOnMembershipChanged: () => {},
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
    expect(errors()[0].message).toContain('Invalid JSON')
  })

  test('unknown message type sends error response', async () => {
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, { type: '__unknown__' })
    expect(errors()).toHaveLength(1)
    expect(String(errors()[0].message)).toContain('Unknown message type')
  })

  // --- cancel_generation ---

  test('cancel_generation for unknown agent sends error', async () => {
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, { type: 'cancel_generation', name: 'NoSuchBot' })
    expect(errors()).toHaveLength(1)
    expect(String(errors()[0].message)).toContain('not found')
  })

  test('cancel_generation for non-AI agent sends error', async () => {
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, { type: 'cancel_generation', name: 'Human' })
    expect(errors()).toHaveLength(1)
    expect(String(errors()[0].message)).toContain('not an AI agent')
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
    expect((msgEvents[0].message as Record<string, unknown>).content).toBe('Hello')
  })

  // --- set_paused ---

  test('set_paused pauses room and broadcasts', async () => {
    let broadcasted: WSOutbound | null = null
    wsManager.broadcast = (msg: WSOutbound) => { broadcasted = msg }
    const { ws } = makeWS()
    await dispatch(ws, session, system, wsManager, { type: 'set_paused', roomName: 'TestRoom', paused: true })
    const room = system.house.getRoom('TestRoom')!
    expect(room.paused).toBe(true)
    expect(broadcasted).not.toBeNull()
    expect((broadcasted as WSOutbound & { type: 'delivery_mode_changed' }).paused).toBe(true)
  })

  test('set_paused on unknown room sends error', async () => {
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, { type: 'set_paused', roomName: 'NoSuchRoom', paused: true })
    expect(errors()).toHaveLength(1)
  })

  // --- Todos ---

  test('add_todo adds todo and broadcasts todo_changed', async () => {
    const broadcasts: WSOutbound[] = []
    wsManager.broadcast = (msg: WSOutbound) => { broadcasts.push(msg) }
    const { ws } = makeWS()
    await dispatch(ws, session, system, wsManager, {
      type: 'add_todo', roomName: 'TestRoom', content: 'Write docs',
    })
    const room = system.house.getRoom('TestRoom')!
    expect(room.getTodos()).toHaveLength(1)
    const event = broadcasts.find(b => b.type === 'todo_changed') as (WSOutbound & { type: 'todo_changed' }) | undefined
    expect(event).toBeDefined()
    expect(event!.action).toBe('added')
    expect(event!.todo.content).toBe('Write docs')
  })

  test('add_todo on unknown room sends error', async () => {
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, { type: 'add_todo', roomName: 'NoSuchRoom', content: 'test' })
    expect(errors()).toHaveLength(1)
  })

  test('update_todo with unknown id sends error', async () => {
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, {
      type: 'update_todo', roomName: 'TestRoom', todoId: 'no-such-id', status: 'completed',
    })
    expect(errors()).toHaveLength(1)
    expect(String(errors()[0].message)).toContain('not found')
  })

  test('update_todo updates and broadcasts', async () => {
    const room = system.house.getRoom('TestRoom')!
    const todo = room.addTodo({ content: 'Task', createdBy: 'tester' })
    const broadcasts: WSOutbound[] = []
    wsManager.broadcast = (msg: WSOutbound) => { broadcasts.push(msg) }
    const { ws } = makeWS()
    await dispatch(ws, session, system, wsManager, {
      type: 'update_todo', roomName: 'TestRoom', todoId: todo.id, status: 'completed',
    })
    const event = broadcasts.find(b => b.type === 'todo_changed') as (WSOutbound & { type: 'todo_changed' }) | undefined
    expect(event?.action).toBe('updated')
    expect(event?.todo.status).toBe('completed')
  })

  test('remove_todo with unknown id sends error', async () => {
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, {
      type: 'remove_todo', roomName: 'TestRoom', todoId: 'no-such-id',
    })
    expect(errors()).toHaveLength(1)
    expect(String(errors()[0].message)).toContain('not found')
  })

  test('remove_todo removes and broadcasts', async () => {
    const room = system.house.getRoom('TestRoom')!
    const todo = room.addTodo({ content: 'Doomed', createdBy: 'tester' })
    const broadcasts: WSOutbound[] = []
    wsManager.broadcast = (msg: WSOutbound) => { broadcasts.push(msg) }
    const { ws } = makeWS()
    await dispatch(ws, session, system, wsManager, {
      type: 'remove_todo', roomName: 'TestRoom', todoId: todo.id,
    })
    expect(room.getTodos()).toHaveLength(0)
    const event = broadcasts.find(b => b.type === 'todo_changed') as (WSOutbound & { type: 'todo_changed' }) | undefined
    expect(event?.action).toBe('removed')
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
    system.addAgentToRoom = async () => { called = true }
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
    system.removeAgentFromRoom = () => { called = true }
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, { type: 'remove_from_room', roomName: 'TestRoom', agentName: 'Human' })
    expect(errors()).toHaveLength(0)
    expect(called).toBe(true)
  })

  // --- create_room ---

  test('create_room with duplicate name still calls addAgentToRoom', async () => {
    let addCalled = false
    system.addAgentToRoom = async () => { addCalled = true }
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, { type: 'create_room', name: 'TestRoom' })
    // Duplicate names are allowed (createRoomSafe returns sanitised name) — no error expected
    expect(errors()).toHaveLength(0)
    expect(addCalled).toBe(true)
  })
})
