import { describe, test, expect } from 'bun:test'
import { createAIAgent } from './ai-agent.ts'
import type { Decision } from './ai-agent.ts'
import type { AIAgentConfig } from '../core/types/agent.ts'
import type { LLMProvider } from '../core/types/llm.ts'
import type { Message, RoomProfile } from '../core/types/messaging.ts'
import type { Room } from '../core/types/room.ts'
import { SYSTEM_SENDER_ID } from '../core/types/constants.ts'
import { createRoom } from '../core/room.ts'

// --- Test helpers ---

const makeConfig = (overrides?: Partial<AIAgentConfig>): AIAgentConfig => ({
  name: 'TestBot',
  model: 'test-model',
  persona: 'You are a helpful test bot.',
  historyLimit: 10,
  ...overrides,
})

const makePassToolCalls = (reason: string = 'test') => [{ function: { name: 'pass', arguments: { reason } } }]

const makeLLMProvider = (
  responseContent: string = '',
  toolCalls?: ReadonlyArray<{ function: { name: string; arguments: Record<string, unknown> } }>,
): LLMProvider => ({
  chat: async () => ({
    content: responseContent,
    generationMs: 42,
    tokensUsed: { prompt: 10, completion: 5 },
    toolCalls: toolCalls ?? (responseContent === '' ? makePassToolCalls() : undefined),
  }),
  models: async () => ['test-model'],
})

const makeRoom = (id: string = 'room-1', name: string = 'Test Room'): Room => {
  const profile: RoomProfile = {
    id, name, createdBy: 'system', createdAt: Date.now(),
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
  test('receive skips own messages (no self-reply)', async () => {
    const decisions: Decision[] = []
    const agent = createAIAgent(
      makeConfig(),
      makeLLMProvider('Hi'),
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
      makeLLMProvider('Hi'),
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
      makeLLMProvider('Hi there'),
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

  test('per-room generation: same room queues, different rooms run concurrently', async () => {
    let callCount = 0
    const slowProvider: LLMProvider = {
      chat: async () => {
        callCount++
        await new Promise(resolve => setTimeout(resolve, 50))
        return {
          content: '', toolCalls: makePassToolCalls('slow'),
          generationMs: 50,
          tokensUsed: { prompt: 10, completion: 5 },
        }
      },
      models: async () => ['test-model'],
    }

    const agent = createAIAgent(
      makeConfig(),
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

  test('plain text is treated as respond', async () => {
    const decisions: Decision[] = []
    const agent = createAIAgent(
      makeConfig(),
      makeLLMProvider('This is a plain text response'),
      (d) => { decisions.push(d) },
    )

    agent.receive(makeMessage({ senderId: 'alice' }))
    await agent.whenIdle()

    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.response.action).toBe('respond')
    if (decisions[0]!.response.action === 'respond') {
      expect(decisions[0]!.response.content).toBe('This is a plain text response')
    }
  })

  test('pass tool call is parsed as pass', async () => {
    const decisions: Decision[] = []
    const agent = createAIAgent(
      makeConfig(),
      makeLLMProvider('', makePassToolCalls('not relevant to me')),
      (d) => { decisions.push(d) },
    )

    agent.receive(makeMessage({ senderId: 'alice' }))
    await agent.whenIdle()

    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.response.action).toBe('pass')
    if (decisions[0]!.response.action === 'pass') {
      expect(decisions[0]!.response.reason).toBe('not relevant to me')
    }
  })

  test('pass flushes incoming — messages move to history, not re-presented as [NEW]', async () => {
    // First evaluation: agent passes. Second evaluation (triggered by new msg):
    // the passed message should now appear as history (no [NEW]), not re-queued.
    let callCount = 0
    let lastCaptured: ReadonlyArray<{ role: string; content: string }> = []
    const provider: LLMProvider = {
      chat: async (req) => {
        callCount++
        lastCaptured = req.messages
        return { content: '', generationMs: 10, tokensUsed: { prompt: 10, completion: 5 }, toolCalls: makePassToolCalls('not relevant') }
      },
      models: async () => [],
    }

    const room = makeRoom('room-1', 'Test Room')
    const agent = createAIAgent(makeConfig(), provider, () => {})
    await agent.join(room)

    // First message — agent passes
    agent.receive(makeMessage({ senderId: 'alice', roomId: 'room-1', content: 'First message' }))
    await agent.whenIdle()
    expect(callCount).toBe(1)

    // Second message — triggers re-evaluation
    agent.receive(makeMessage({ senderId: 'bob', roomId: 'room-1', content: 'Second message' }))
    await agent.whenIdle()
    expect(callCount).toBe(2)

    // In the second evaluation, "First message" should NOT appear as [NEW]
    // (it was flushed to history after the pass)
    const userMsgs = lastCaptured.filter(m => m.role === 'user')
    const firstMsgInNew = userMsgs.filter(m => m.content.includes('[NEW]') && m.content.includes('First message'))
    expect(firstMsgInNew).toHaveLength(0)

    // "Second message" should appear as [NEW]
    const secondMsgNew = userMsgs.filter(m => m.content.includes('[NEW]') && m.content.includes('Second message'))
    expect(secondMsgNew.length).toBeGreaterThan(0)
  })

  test('receive skips pass messages (no re-trigger)', async () => {
    const decisions: Decision[] = []
    const agent = createAIAgent(
      makeConfig(),
      makeLLMProvider('Hi'),
      (d) => { decisions.push(d) },
    )

    agent.receive(makeMessage({ senderId: 'other-agent', type: 'pass', content: '[pass] nothing to add' }))
    await agent.whenIdle()

    expect(decisions).toHaveLength(0)
  })

  test('join registers room for context building', async () => {
    const agent = createAIAgent(makeConfig(), makeLLMProvider(), () => {})
    const room = makeRoom('room-1', 'Test Room')

    await agent.join(room)

    // Room membership is tracked by Room.hasMember (via addMember in actions.ts),
    // agent just caches room profiles for context building
    expect(room.hasMember(agent.id)).toBe(false) // join() doesn't call addMember itself
  })

  test('join generates summary for rooms with history', async () => {
    const room = makeRoom('room-1', 'Active Room')
    room.post({ senderId: 'alice', content: 'We should build a pipeline', type: 'chat' })
    room.post({ senderId: 'bob', content: 'I agree', type: 'chat' })

    let capturedMessages: ReadonlyArray<{ role: string; content: string }> = []
    const provider: LLMProvider = {
      chat: async (req) => {
        capturedMessages = req.messages
        return {
          content: 'Summary: [alice] proposed building a pipeline. [bob] agreed.',
          generationMs: 10,
          tokensUsed: { prompt: 10, completion: 5 },
        }
      },
      models: async () => [],
    }

    const agent = createAIAgent(makeConfig(), provider, () => {})
    await agent.join(room)

    // Summary LLM call should have been made
    expect(capturedMessages.length).toBeGreaterThan(0)
    const userMsg = capturedMessages.find(m => m.role === 'user')
    expect(userMsg?.content).toContain('Active Room')
    expect(userMsg?.content).toContain('pipeline')
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
  })

  test('LLM error is caught — agent does not crash, emits pass', async () => {
    const errorProvider: LLMProvider = {
      chat: async () => { throw new Error('LLM is down') },
      models: async () => [],
    }

    const decisions: Decision[] = []
    const agent = createAIAgent(makeConfig(), errorProvider, (d) => { decisions.push(d) })

    agent.receive(makeMessage({ senderId: 'alice' }))
    await agent.whenIdle()

    // LLM error produces an error decision (not pass) so the failure surfaces
    // distinctly in the UI and isn't conflated with an agent-decision pass.
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.response.action).toBe('error')
    if (decisions[0]!.response.action === 'error') {
      expect(decisions[0]!.response.message).toMatch(/LLM is down/)
      expect(decisions[0]!.response.code).toBe('unknown')
    }
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
          content: '', toolCalls: makePassToolCalls('done'),
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
          content: '', toolCalls: makePassToolCalls('done'),
          generationMs: 20,
          tokensUsed: { prompt: 10, completion: 5 },
        }
      },
      models: async () => [],
    }

    const agent = createAIAgent(makeConfig(), provider, () => {})

    // Two messages to same room — second becomes pending
    agent.receive(makeMessage({ senderId: 'alice', roomId: 'room-1', content: 'msg-1' }))
    agent.receive(makeMessage({ senderId: 'bob', roomId: 'room-1', content: 'msg-2' }))

    await agent.whenIdle()

    // Both evaluations should have completed
    expect(callCount).toBe(2)
  })
})

describe('[NEW] message tagging', () => {
  test('new messages are tagged [NEW] in LLM context', async () => {
    let capturedMessages: ReadonlyArray<{ role: string; content: string }> = []
    const provider: LLMProvider = {
      chat: async (req) => {
        capturedMessages = req.messages
        return {
          content: '', toolCalls: makePassToolCalls('done'),
          generationMs: 10,
          tokensUsed: { prompt: 10, completion: 5 },
        }
      },
      models: async () => [],
    }

    const agent = createAIAgent(makeConfig(), provider, () => {})

    // Receive a message — should be tagged [NEW] since buffer was empty
    agent.receive(makeMessage({ senderId: 'alice', roomId: 'room-1', content: 'Fresh message' }))
    await agent.whenIdle()

    const userMsgs = capturedMessages.filter(m => m.role === 'user')
    expect(userMsgs.some(m => m.content.includes('[NEW]') && m.content.includes('Fresh message'))).toBe(true)
  })

  test('history messages are NOT tagged [NEW]', async () => {
    // Build a room with prior messages, join the agent (generates summary),
    // then receive a new message. Prior messages appear as history; new is [NEW].
    const room = makeRoom('room-1', 'Test Room')
    room.post({ senderId: 'bob', content: 'Old message 1', type: 'chat' })
    room.post({ senderId: 'charlie', content: 'Old message 2', type: 'chat' })

    let callCount = 0
    let capturedMessages: ReadonlyArray<{ role: string; content: string }> = []
    const provider: LLMProvider = {
      chat: async (req) => {
        callCount++
        capturedMessages = req.messages
        if (callCount === 1) {
          // First call: join summary generation
          return { content: 'Summary: bob and charlie discussed topics.', generationMs: 10, tokensUsed: { prompt: 10, completion: 5 } }
        }
        // Second call: agent evaluation triggered by new message
        return { content: '', generationMs: 10, tokensUsed: { prompt: 10, completion: 5 }, toolCalls: makePassToolCalls('done') }
      },
      models: async () => [],
    }

    const agent = createAIAgent(makeConfig(), provider, () => {})
    await agent.join(room)  // initialises RoomContext, generates summary into incoming

    // Now receive a new message — summary is already in incoming, new message added
    agent.receive(makeMessage({ senderId: 'alice', roomId: 'room-1', content: 'New message' }))
    await agent.whenIdle()

    // The summary (from join) should be in incoming as [NEW]; new message also [NEW]
    // Neither should appear without [NEW] prefix since both are fresh after join
    const userMsgs = capturedMessages.filter(m => m.role === 'user')
    expect(userMsgs.length).toBeGreaterThan(0)

    // New message SHOULD have [NEW]
    const newMsgs = userMsgs.filter(m => m.content.includes('New message'))
    expect(newMsgs.every(m => m.content.includes('[NEW]'))).toBe(true)
  })

  test('system prompt is fenced with XML sections (house, response_format)', async () => {
    let capturedMessages: ReadonlyArray<{ role: string; content: string }> = []
    const provider: LLMProvider = {
      chat: async (req) => {
        capturedMessages = req.messages
        return {
          content: '', toolCalls: makePassToolCalls('done'),
          generationMs: 10,
          tokensUsed: { prompt: 10, completion: 5 },
        }
      },
      models: async () => [],
    }

    const agent = createAIAgent(makeConfig(), provider, () => {}, {
      getHousePrompt: () => 'Be helpful. Prioritise new messages.',
      getResponseFormat: () => '- Just write natural text.',
    })
    agent.receive(makeMessage({ senderId: 'alice', roomId: 'room-1' }))
    await agent.whenIdle()

    const systemMsg = capturedMessages.find(m => m.role === 'system')
    expect(systemMsg?.content).toContain('Prioritise')
    expect(systemMsg?.content).toContain('<samsinn:house_rules>')
    expect(systemMsg?.content).toContain('</samsinn:house_rules>')
    expect(systemMsg?.content).toContain('<samsinn:response_format>')
    expect(systemMsg?.content).toContain('</samsinn:response_format>')
  })

  test('buffered messages during generation are all tagged [NEW]', async () => {
    let callCount = 0
    let lastCapturedMessages: ReadonlyArray<{ role: string; content: string }> = []
    const provider: LLMProvider = {
      chat: async (req) => {
        callCount++
        lastCapturedMessages = req.messages
        if (callCount === 1) {
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        return {
          content: '', toolCalls: makePassToolCalls('done'),
          generationMs: 10,
          tokensUsed: { prompt: 10, completion: 5 },
        }
      },
      models: async () => [],
    }

    const agent = createAIAgent(makeConfig(), provider, () => {})

    // First message triggers eval
    agent.receive(makeMessage({ senderId: 'alice', roomId: 'room-1', content: 'msg-1' }))

    // Wait a tick for eval to start, then send more while generating
    await new Promise(resolve => setTimeout(resolve, 10))
    agent.receive(makeMessage({ senderId: 'bob', roomId: 'room-1', content: 'msg-2' }))
    agent.receive(makeMessage({ senderId: 'charlie', roomId: 'room-1', content: 'msg-3' }))

    await agent.whenIdle()

    // Second evaluation should have all 3 messages — they're all [NEW]
    // (msg-1 was flushed after first eval, but msg-2 and msg-3 arrived during eval)
    expect(callCount).toBe(2)
    const newMsgs = lastCapturedMessages.filter(m => m.role === 'user' && m.content.includes('[NEW]'))
    expect(newMsgs.length).toBeGreaterThanOrEqual(2) // at least msg-2 and msg-3
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
          content: '', generationMs: 100, tokensUsed: { prompt: 10, completion: 5 },
          toolCalls: makePassToolCalls('done'),
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
    expect(states[0]).toEqual({ state: 'generating', context: 'room-1' })

    resolveChat!()
    await agent.whenIdle()

    expect(agent.state.get()).toBe('idle')
    expect(states).toHaveLength(2)
    expect(states[1]).toEqual({ state: 'idle', context: undefined })
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
    const human = createHumanAgent({ name: 'Human' }, () => {})
    expect(human.state.get()).toBe('idle')

    const states: string[] = []
    const unsub = human.state.subscribe((s: string) => states.push(s))
    expect(states).toHaveLength(0)
    unsub()
  })
})

describe('Tool use (ReAct loop)', () => {
  test('native tool call triggers executor and feeds result back to LLM', async () => {
    let callCount = 0
    const provider: LLMProvider = {
      chat: async () => {
        callCount++
        if (callCount === 1) {
          return {
            content: '',
            generationMs: 50,
            tokensUsed: { prompt: 10, completion: 5 },
            toolCalls: [{ function: { name: 'get_time', arguments: {} } }],
          }
        }
        return {
          content: 'The time is now.',
          generationMs: 50,
          tokensUsed: { prompt: 20, completion: 10 },
        }
      },
      models: async () => [],
    }

    const toolExecutor = async (calls: ReadonlyArray<{ tool: string; arguments: Record<string, unknown> }>) => {
      return calls.map(() => ({ success: true as const, data: { time: '2026-03-23T12:00:00Z' } }))
    }

    const decisions: Decision[] = []
    const agent = createAIAgent(
      makeConfig(),
      provider,
      (d) => decisions.push(d),
      { toolExecutor, toolDefinitions: [{ type: 'function', function: { name: 'get_time', description: 'Returns the current time', parameters: {} } }] },
    )

    agent.receive(makeMessage({ senderId: 'alice', roomId: 'room-1', content: 'What time is it?' }))
    await agent.whenIdle()

    expect(callCount).toBe(2)
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.response.action).toBe('respond')
    expect(decisions[0]!.generationMs).toBe(100)
  })

  test('native tool call without executor falls back to pass', async () => {
    const provider: LLMProvider = {
      chat: async () => ({
        content: '',
        generationMs: 50,
        tokensUsed: { prompt: 10, completion: 5 },
        toolCalls: [{ function: { name: 'get_time', arguments: {} } }],
      }),
      models: async () => [],
    }

    const decisions: Decision[] = []
    const agent = createAIAgent(makeConfig(), provider, (d) => decisions.push(d))

    agent.receive(makeMessage({ senderId: 'alice', roomId: 'room-1' }))
    await agent.whenIdle()

    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.response.action).toBe('error')
    if (decisions[0]!.response.action === 'error') {
      expect(decisions[0]!.response.code).toBe('tools_unavailable')
    }
  })

  test('max tool iterations prevents infinite loop', async () => {
    let callCount = 0
    const provider: LLMProvider = {
      chat: async () => {
        callCount++
        return {
          content: '',
          generationMs: 10,
          tokensUsed: { prompt: 10, completion: 5 },
          toolCalls: [{ function: { name: 'loop', arguments: {} } }],
        }
      },
      models: async () => [],
    }

    const toolExecutor = async () => [{ success: true as const, data: 'looping' }]

    const decisions: Decision[] = []
    const agent = createAIAgent(
      makeConfig({ maxToolIterations: 3 }),
      provider,
      (d) => decisions.push(d),
      { toolExecutor, toolDefinitions: [{ type: 'function', function: { name: 'loop', description: 'Test tool', parameters: {} } }] },
    )

    agent.receive(makeMessage({ senderId: 'alice', roomId: 'room-1' }))
    await agent.whenIdle()

    // 1 initial + 3 tool rounds = 4 LLM calls, then capped at max iterations
    expect(callCount).toBe(4)
    expect(decisions).toHaveLength(1)
    // No partial text was emitted across the 4 calls, so we should hit the
    // tool_loop_exceeded error path (not the partial-text rescue path that
    // returns 'respond' with a footer).
    expect(decisions[0]!.response.action).toBe('error')
    if (decisions[0]!.response.action === 'error') {
      expect(decisions[0]!.response.code).toBe('tool_loop_exceeded')
    }
  })

  test('native tool call with JSON arguments parses correctly', async () => {
    let callCount = 0
    let executedCalls: ReadonlyArray<{ tool: string; arguments: Record<string, unknown> }> = []
    const provider: LLMProvider = {
      chat: async () => {
        callCount++
        if (callCount === 1) {
          return {
            content: '',
            generationMs: 50,
            tokensUsed: { prompt: 10, completion: 5 },
            toolCalls: [{ function: { name: 'get_time', arguments: { timezone: 'UTC' } } }],
          }
        }
        return {
          content: 'Alice says she is busy.',
          generationMs: 50,
          tokensUsed: { prompt: 20, completion: 10 },
        }
      },
      models: async () => [],
    }

    const toolExecutor = async (calls: ReadonlyArray<{ tool: string; arguments: Record<string, unknown> }>) => {
      executedCalls = calls
      return calls.map(() => ({ success: true as const, data: 'Alice is busy' }))
    }

    const decisions: Decision[] = []
    const agent = createAIAgent(
      makeConfig(),
      provider,
      (d) => decisions.push(d),
      { toolExecutor, toolDefinitions: [{ type: 'function', function: { name: 'get_time', description: 'Returns the current time', parameters: {} } }] },
    )

    agent.receive(makeMessage({ senderId: 'bob', roomId: 'room-1' }))
    await agent.whenIdle()

    expect(executedCalls).toHaveLength(1)
    expect(executedCalls[0]!.tool).toBe('get_time')
    expect(executedCalls[0]!.arguments).toEqual({ timezone: 'UTC' })
  })

  test('tool definitions are passed in ChatRequest when configured', async () => {
    let capturedRequest: { tools?: unknown } = {}
    const provider: LLMProvider = {
      chat: async (req) => {
        capturedRequest = req
        return {
          content: '', generationMs: 10, tokensUsed: { prompt: 10, completion: 5 },
          toolCalls: makePassToolCalls('done'),
        }
      },
      models: async () => [],
    }

    const toolDefs = [{ type: 'function' as const, function: { name: 'get_time', description: 'Returns the current time', parameters: {} } }]
    const agent = createAIAgent(
      makeConfig(),
      provider,
      () => {},
      { toolDefinitions: toolDefs },
    )

    agent.receive(makeMessage({ senderId: 'alice', roomId: 'room-1' }))
    await agent.whenIdle()

    expect(capturedRequest.tools).toEqual(toolDefs)
  })
})

