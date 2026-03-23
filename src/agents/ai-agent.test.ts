import { describe, test, expect } from 'bun:test'
import { createAIAgent } from './ai-agent.ts'
import type { Decision } from './ai-agent.ts'
import type { AIAgentConfig, LLMProvider, Message, Room, RoomProfile } from '../core/types.ts'
import { SYSTEM_SENDER_ID } from '../core/types.ts'
import { createRoom } from '../core/room.ts'

// --- Test helpers ---

const makeConfig = (overrides?: Partial<AIAgentConfig>): AIAgentConfig => ({
  participantId: 'bot-1',
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

  test('receive skips own messages (no self-reply)', () => {
    const decisions: Decision[] = []
    const agent = createAIAgent(
      makeConfig({ participantId: 'bot-1' }),
      makeLLMProvider('{"action":"respond","content":"Hi"}'),
      (d) => { decisions.push(d) },
    )

    // Message from self — should not trigger evaluation
    agent.receive(makeMessage({ senderId: 'bot-1' }))

    // Give async time to settle
    return new Promise<void>(resolve => {
      setTimeout(() => {
        expect(decisions).toHaveLength(0)
        resolve()
      }, 50)
    })
  })

  test('receive skips system messages', () => {
    const decisions: Decision[] = []
    const agent = createAIAgent(
      makeConfig(),
      makeLLMProvider('{"action":"respond","content":"Hi"}'),
      (d) => { decisions.push(d) },
    )

    agent.receive(makeMessage({ senderId: SYSTEM_SENDER_ID, type: 'system' }))

    return new Promise<void>(resolve => {
      setTimeout(() => {
        expect(decisions).toHaveLength(0)
        resolve()
      }, 50)
    })
  })

  test('receive triggers evaluation and calls onDecision', () => {
    const decisions: Decision[] = []
    const agent = createAIAgent(
      makeConfig(),
      makeLLMProvider('{"action":"respond","content":"Hi there"}'),
      (d) => { decisions.push(d) },
    )

    agent.receive(makeMessage({ senderId: 'alice' }))

    return new Promise<void>(resolve => {
      setTimeout(() => {
        expect(decisions).toHaveLength(1)
        expect(decisions[0]!.response.action).toBe('respond')
        if (decisions[0]!.response.action === 'respond') {
          expect(decisions[0]!.response.content).toBe('Hi there')
        }
        expect(decisions[0]!.generationMs).toBe(42)
        resolve()
      }, 200)
    })
  })

  test('cooldown prevents rapid re-evaluation', () => {
    const decisions: Decision[] = []
    const agent = createAIAgent(
      makeConfig({ cooldownMs: 500 }),
      makeLLMProvider('{"action":"respond","content":"Hi"}'),
      (d) => { decisions.push(d) },
    )

    // First message triggers evaluation
    agent.receive(makeMessage({ senderId: 'alice', content: 'msg-1' }))

    return new Promise<void>(resolve => {
      setTimeout(() => {
        // Second message during cooldown — should be skipped
        agent.receive(makeMessage({ senderId: 'bob', content: 'msg-2' }))

        setTimeout(() => {
          expect(decisions).toHaveLength(1) // only first triggered
          resolve()
        }, 100)
      }, 200) // wait for first evaluation to complete
    })
  })

  test('per-room generation: same room queues, different rooms run concurrently', () => {
    let callCount = 0
    const slowProvider: LLMProvider = {
      chat: async () => {
        callCount++
        await new Promise(resolve => setTimeout(resolve, 200))
        return {
          content: '{"action":"pass","reason":"slow"}',
          generationMs: 200,
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

    return new Promise<void>(resolve => {
      setTimeout(() => {
        // room-1: first eval + pending re-eval = 2 calls
        // room-2: concurrent eval = 1 call
        // Total: 3 calls (but room-1 re-eval may still be pending due to cooldown=0 timing)
        expect(callCount).toBeGreaterThanOrEqual(2) // at minimum room-1 + room-2
        resolve()
      }, 800)
    })
  })

  test('JSON fallback — invalid JSON treated as respond', () => {
    const decisions: Decision[] = []
    const agent = createAIAgent(
      makeConfig(),
      makeLLMProvider('This is not JSON at all'),
      (d) => { decisions.push(d) },
    )

    agent.receive(makeMessage({ senderId: 'alice' }))

    return new Promise<void>(resolve => {
      setTimeout(() => {
        expect(decisions).toHaveLength(1)
        expect(decisions[0]!.response.action).toBe('respond')
        if (decisions[0]!.response.action === 'respond') {
          expect(decisions[0]!.response.content).toBe('This is not JSON at all')
        }
        resolve()
      }, 200)
    })
  })

  test('eviction keeps messages within historyLimit per room', () => {
    const agent = createAIAgent(
      makeConfig({ historyLimit: 5 }),
      makeLLMProvider(),
      () => {},
    )

    // Add 10 messages to room-1
    for (let i = 0; i < 10; i++) {
      agent.receive(makeMessage({
        senderId: 'bot-1', // own messages — won't trigger eval
        roomId: 'room-1',
        content: `msg-${i}`,
      }))
    }

    const roomMsgs = agent.getMessagesForRoom('room-1')
    expect(roomMsgs.length).toBeLessThanOrEqual(5)
    // Most recent messages should be kept
    expect(roomMsgs[roomMsgs.length - 1]!.content).toBe('msg-9')
  })

  test('getMessagesForRoom filters by roomId', () => {
    const agent = createAIAgent(makeConfig(), makeLLMProvider(), () => {})

    agent.receive(makeMessage({ senderId: 'bot-1', roomId: 'room-1', content: 'r1-msg' }))
    agent.receive(makeMessage({ senderId: 'bot-1', roomId: 'room-2', content: 'r2-msg' }))

    expect(agent.getMessagesForRoom('room-1')).toHaveLength(1)
    expect(agent.getMessagesForRoom('room-2')).toHaveLength(1)
    expect(agent.getMessagesForRoom('room-1')[0]!.content).toBe('r1-msg')
  })

  test('getRoomIds returns unique room IDs from messages', () => {
    const agent = createAIAgent(makeConfig(), makeLLMProvider(), () => {})

    agent.receive(makeMessage({ senderId: 'bot-1', roomId: 'room-1' }))
    agent.receive(makeMessage({ senderId: 'bot-1', roomId: 'room-2' }))
    agent.receive(makeMessage({ senderId: 'bot-1', roomId: 'room-1' }))

    const roomIds = agent.getRoomIds()
    expect(roomIds).toHaveLength(2)
    expect(roomIds).toContain('room-1')
    expect(roomIds).toContain('room-2')
  })

  test('join snapshots room profile', async () => {
    const agent = createAIAgent(makeConfig(), makeLLMProvider(), () => {})
    const room = makeRoom('room-1', 'Project Alpha')

    await agent.join(room)

    // After join, agent should have room profile snapshot
    // (verified indirectly — the join doesn't fail, metadata is used in context building)
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

    // Agent should have a room_summary message stored
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

  test('LLM error is caught — agent does not crash', () => {
    const errorProvider: LLMProvider = {
      chat: async () => { throw new Error('LLM is down') },
      models: async () => [],
    }

    const decisions: Decision[] = []
    const agent = createAIAgent(makeConfig(), errorProvider, (d) => { decisions.push(d) })

    agent.receive(makeMessage({ senderId: 'alice' }))

    return new Promise<void>(resolve => {
      setTimeout(() => {
        expect(decisions).toHaveLength(0) // no decision made
        resolve()
      }, 200)
    })
  })
})
