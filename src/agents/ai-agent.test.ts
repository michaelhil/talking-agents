import { describe, test, expect } from 'bun:test'
import { createAIAgent } from './ai-agent.ts'
import type { Decision } from './ai-agent.ts'
import type { AIAgentConfig, LLMProvider, Message, Room, RoomProfile } from '../core/types.ts'
import { SYSTEM_SENDER_ID } from '../core/types.ts'
import { createRoom } from '../core/room.ts'

// --- Test helpers ---

const makeConfig = (overrides?: Partial<AIAgentConfig>): AIAgentConfig => ({
  name: 'TestBot',
  description: 'A test bot',
  model: 'test-model',
  systemPrompt: 'You are a helpful test bot.',
  cooldownMs: 100,
  historyLimit: 10,
  ...overrides,
})

const makeLLMProvider = (responseContent: string = '{"action":"pass","reason":"test"}'): LLMProvider => ({
  chat: async () => ({
    content: responseContent,
    generationMs: 42,
    tokensUsed: { prompt: 10, completion: 5 },
  }),
  models: async () => ['test-model'],
})

const makeRoom = (id: string = 'room-1', name: string = 'Test Room'): Room => {
  const profile: RoomProfile = {
    id, name, visibility: 'public', createdBy: 'system', createdAt: Date.now(),
  }
  return createRoom(profile)
}

const makeMessage = (overrides?: Partial<Message>): Message => ({
  id: crypto.randomUUID(),
  roomId: 'room-1',
  senderId: 'alice',
  content: 'Hello',
  timestamp: Date.now(),
  type: 'chat',
  ...overrides,
})

describe('AI Agent — unit tests', () => {
  test('receive adds message to internal store', () => {
    const agent = createAIAgent(makeConfig(), makeLLMProvider(), () => {})
    const msg = makeMessage()

    agent.receive(msg)

    expect(agent.getMessages()).toHaveLength(1)
    expect(agent.getMessages()[0]!.content).toBe('Hello')
  })

  test('receive skips own messages (no self-reply)', async () => {
    const decisions: Decision[] = []
    const agent = createAIAgent(
      makeConfig(),
      makeLLMProvider('{"action":"respond","content":"Hi"}'),
      (d) => { decisions.push(d) },
    )

    agent.receive(makeMessage({ senderId: agent.id }))
    await agent.whenIdle()

    expect(decisions).toHaveLength(0)
  })

  test('receive skips system messages', async () => {
    const decisions: Decision[] = []
    const agent = createAIAgent(
      makeConfig(),
      makeLLMProvider('{"action":"respond","content":"Hi"}'),
      (d) => { decisions.push(d) },
    )

    agent.receive(makeMessage({ senderId: SYSTEM_SENDER_ID, type: 'system' }))
    await agent.whenIdle()

    expect(decisions).toHaveLength(0)
  })

  test('receive triggers evaluation and calls onDecision', async () => {
    const decisions: Decision[] = []
    const agent = createAIAgent(
      makeConfig(),
      makeLLMProvider('{"action":"respond","content":"Hi there"}'),
      (d) => { decisions.push(d) },
    )

    agent.receive(makeMessage({ senderId: 'alice' }))
    await agent.whenIdle()

    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.response.action).toBe('respond')
    if (decisions[0]!.response.action === 'respond') {
      expect(decisions[0]!.response.content).toBe('Hi there')
    }
    expect(decisions[0]!.generationMs).toBe(42)
  })

  test('cooldown prevents rapid re-evaluation', async () => {
    const decisions: Decision[] = []
    const agent = createAIAgent(
      makeConfig({ cooldownMs: 500 }),
      makeLLMProvider('{"action":"respond","content":"Hi"}'),
      (d) => { decisions.push(d) },
    )

    // First message triggers evaluation
    agent.receive(makeMessage({ senderId: 'alice', content: 'msg-1' }))
    await agent.whenIdle()

    // Second message during cooldown — should be skipped
    agent.receive(makeMessage({ senderId: 'bob', content: 'msg-2' }))
    await agent.whenIdle()

    expect(decisions).toHaveLength(1) // only first triggered
  })

  test('per-room generation: same room queues, different rooms run concurrently', async () => {
    let callCount = 0
    const slowProvider: LLMProvider = {
      chat: async () => {
        callCount++
        await new Promise(resolve => setTimeout(resolve, 50))
        return {
          content: '{"action":"pass","reason":"slow"}',
          generationMs: 50,
          tokensUsed: { prompt: 10, completion: 5 },
        }
      },
      models: async () => ['test-model'],
    }

    const agent = createAIAgent(
      makeConfig({ cooldownMs: 0 }),
      slowProvider,
      () => {},
    )

    // Two messages in same room — first evaluates, second queued as pending
    agent.receive(makeMessage({ senderId: 'alice', roomId: 'room-1', content: 'msg-1' }))
    agent.receive(makeMessage({ senderId: 'bob', roomId: 'room-1', content: 'msg-2' }))

    // Message in different room — should start concurrently
    agent.receive(makeMessage({ senderId: 'charlie', roomId: 'room-2', content: 'msg-3' }))

    await agent.whenIdle()

    // room-1: first eval + pending re-eval = 2 calls
    // room-2: concurrent eval = 1 call
    // Total: 3
    expect(callCount).toBeGreaterThanOrEqual(2) // at minimum room-1 + room-2
  })

  test('JSON fallback — invalid JSON treated as respond', async () => {
    const decisions: Decision[] = []
    const agent = createAIAgent(
      makeConfig(),
      makeLLMProvider('This is not JSON at all'),
      (d) => { decisions.push(d) },
    )

    agent.receive(makeMessage({ senderId: 'alice' }))
    await agent.whenIdle()

    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.response.action).toBe('respond')
    if (decisions[0]!.response.action === 'respond') {
      expect(decisions[0]!.response.content).toBe('This is not JSON at all')
    }
  })

  test('eviction keeps messages within historyLimit per room', () => {
    const agent = createAIAgent(
      makeConfig({ historyLimit: 5 }),
      makeLLMProvider(),
      () => {},
    )

    // Add 10 messages to room-1 (own messages — won't trigger eval)
    for (let i = 0; i < 10; i++) {
      agent.receive(makeMessage({
        senderId: agent.id,
        roomId: 'room-1',
        content: `msg-${i}`,
      }))
    }

    const roomMsgs = agent.getMessagesForRoom('room-1')
    expect(roomMsgs.length).toBeLessThanOrEqual(5)
    expect(roomMsgs[roomMsgs.length - 1]!.content).toBe('msg-9')
  })

  test('getMessagesForRoom filters by roomId', () => {
    const agent = createAIAgent(makeConfig(), makeLLMProvider(), () => {})

    agent.receive(makeMessage({ senderId: agent.id, roomId: 'room-1', content: 'r1-msg' }))
    agent.receive(makeMessage({ senderId: agent.id, roomId: 'room-2', content: 'r2-msg' }))

    expect(agent.getMessagesForRoom('room-1')).toHaveLength(1)
    expect(agent.getMessagesForRoom('room-2')).toHaveLength(1)
    expect(agent.getMessagesForRoom('room-1')[0]!.content).toBe('r1-msg')
  })

  test('getRoomIds returns unique room IDs from messages', () => {
    const agent = createAIAgent(makeConfig(), makeLLMProvider(), () => {})

    agent.receive(makeMessage({ senderId: agent.id, roomId: 'room-1' }))
    agent.receive(makeMessage({ senderId: agent.id, roomId: 'room-2' }))
    agent.receive(makeMessage({ senderId: agent.id, roomId: 'room-1' }))

    const roomIds = agent.getRoomIds()
    expect(roomIds).toHaveLength(2)
    expect(roomIds).toContain('room-1')
    expect(roomIds).toContain('room-2')
  })

  test('join snapshots room profile', async () => {
    const agent = createAIAgent(makeConfig(), makeLLMProvider(), () => {})
    const room = makeRoom('room-1', 'Project Alpha')

    await agent.join(room)

    expect(agent.getRoomIds()).toHaveLength(0) // no messages yet from this room
  })

  test('join generates summary for rooms with history', async () => {
    const room = makeRoom('room-1', 'Active Room')
    room.post({ senderId: 'alice', content: 'We should build a pipeline', type: 'chat' })
    room.post({ senderId: 'bob', content: 'I agree', type: 'chat' })

    const agent = createAIAgent(
      makeConfig(),
      makeLLMProvider('Summary: [alice] proposed building a pipeline. [bob] agreed.'),
      () => {},
    )

    await agent.join(room)

    const msgs = agent.getMessages()
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.type).toBe('room_summary')
    expect(msgs[0]!.content).toContain('[alice]')
  })

  test('join does not generate summary for empty rooms', async () => {
    let chatCalled = false
    const trackingProvider: LLMProvider = {
      chat: async () => {
        chatCalled = true
        return { content: 'summary', generationMs: 10, tokensUsed: { prompt: 0, completion: 0 } }
      },
      models: async () => [],
    }

    const agent = createAIAgent(makeConfig(), trackingProvider, () => {})
    const room = makeRoom('empty-room', 'Empty')

    await agent.join(room)

    expect(chatCalled).toBe(false)
    expect(agent.getMessages()).toHaveLength(0)
  })

  test('LLM error is caught — agent does not crash', async () => {
    const errorProvider: LLMProvider = {
      chat: async () => { throw new Error('LLM is down') },
      models: async () => [],
    }

    const decisions: Decision[] = []
    const agent = createAIAgent(makeConfig(), errorProvider, (d) => { decisions.push(d) })

    agent.receive(makeMessage({ senderId: 'alice' }))
    await agent.whenIdle()

    expect(decisions).toHaveLength(0) // no decision made
  })

  test('whenIdle resolves immediately when no work pending', async () => {
    const agent = createAIAgent(makeConfig(), makeLLMProvider(), () => {})
    await agent.whenIdle() // should not hang
  })

  test('whenIdle waits for evaluation to complete', async () => {
    let resolveChat: (() => void) | null = null
    const blockingProvider: LLMProvider = {
      chat: () => new Promise(resolve => {
        resolveChat = () => resolve({
          content: '{"action":"pass","reason":"done"}',
          generationMs: 100,
          tokensUsed: { prompt: 10, completion: 5 },
        })
      }),
      models: async () => [],
    }

    const agent = createAIAgent(makeConfig(), blockingProvider, () => {})
    agent.receive(makeMessage({ senderId: 'alice' }))

    // Start waiting for idle — should not resolve yet
    let idleResolved = false
    const idlePromise = agent.whenIdle().then(() => { idleResolved = true })

    // Give microtasks a chance to run
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(idleResolved).toBe(false)

    // Now unblock the LLM
    resolveChat!()
    await idlePromise

    expect(idleResolved).toBe(true)
  })

  test('whenIdle with pending re-evaluation waits for all rounds', async () => {
    let callCount = 0
    const provider: LLMProvider = {
      chat: async () => {
        callCount++
        await new Promise(resolve => setTimeout(resolve, 20))
        return {
          content: '{"action":"pass","reason":"done"}',
          generationMs: 20,
          tokensUsed: { prompt: 10, completion: 5 },
        }
      },
      models: async () => [],
    }

    const agent = createAIAgent(makeConfig({ cooldownMs: 0 }), provider, () => {})

    // Two messages to same room — second becomes pending
    agent.receive(makeMessage({ senderId: 'alice', roomId: 'room-1', content: 'msg-1' }))
    agent.receive(makeMessage({ senderId: 'bob', roomId: 'room-1', content: 'msg-2' }))

    await agent.whenIdle()

    // Both evaluations should have completed
    expect(callCount).toBe(2)
  })
})

describe('Agent state', () => {
  test('initial state is idle', () => {
    const agent = createAIAgent(makeConfig(), makeLLMProvider(), () => {})
    expect(agent.state.get()).toBe('idle')
  })

  test('state transitions to generating during LLM call', async () => {
    const states: Array<{ state: string; context?: string }> = []
    let resolveChat: (() => void) | null = null
    const blockingProvider: LLMProvider = {
      chat: () => new Promise(resolve => {
        resolveChat = () => resolve({
          content: '{"action":"pass","reason":"done"}',
          generationMs: 100,
          tokensUsed: { prompt: 10, completion: 5 },
        })
      }),
      models: async () => [],
    }

    const agent = createAIAgent(makeConfig(), blockingProvider, () => {})
    agent.state.subscribe((state, _agentId, context) => {
      states.push({ state, context })
    })

    agent.receive(makeMessage({ senderId: 'alice', roomId: 'room-1' }))
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(agent.state.get()).toBe('generating')
    expect(states).toHaveLength(1)
    expect(states[0]).toEqual({ state: 'generating', context: 'room:room-1' })

    resolveChat!()
    await agent.whenIdle()

    expect(agent.state.get()).toBe('idle')
    expect(states).toHaveLength(2)
    expect(states[1]).toEqual({ state: 'idle', context: 'room:room-1' })
  })

  test('unsubscribe stops notifications', async () => {
    const states: string[] = []
    const agent = createAIAgent(makeConfig(), makeLLMProvider(), () => {})
    const unsub = agent.state.subscribe((state) => { states.push(state) })

    agent.receive(makeMessage({ senderId: 'alice', roomId: 'room-1' }))
    await agent.whenIdle()

    const countBefore = states.length
    unsub()

    agent.receive(makeMessage({ senderId: 'bob', roomId: 'room-1' }))
    await agent.whenIdle()

    expect(states.length).toBe(countBefore)
  })

  test('human agent state is always idle', () => {
    const { createHumanAgent } = require('./human-agent.ts')
    const human = createHumanAgent({ name: 'Human', description: 'Test' }, () => {})
    expect(human.state.get()).toBe('idle')

    const states: string[] = []
    const unsub = human.state.subscribe((s: string) => states.push(s))
    expect(states).toHaveLength(0)
    unsub()
  })
})
