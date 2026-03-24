import { describe, test, expect } from 'bun:test'
import { createHouse } from '../core/house.ts'
import { createMessageRouter } from '../core/delivery.ts'
import { createTeam } from './team.ts'
import { createHumanAgent } from './human-agent.ts'
import { createAIAgent } from './ai-agent.ts'
import type { Decision } from './ai-agent.ts'
import { spawnAIAgent, spawnHumanAgent } from './spawn.ts'
import { addAgentToRoom } from './actions.ts'
import { createOllamaProvider } from '../llm/ollama.ts'
import { createToolRegistry } from '../core/tool-registry.ts'
import { createListRoomsTool, createGetTimeTool, createQueryAgentTool } from '../tools/built-in.ts'
import type { AIAgentConfig, LLMProvider, Message } from '../core/types.ts'
import { DEFAULTS, SYSTEM_SENDER_ID } from '../core/types.ts'

const FAST_MODEL = 'llama3.2:latest'

// === Test system factory ===

const createSystem = () => {
  const team = createTeam()
  const deliver = (agentId: string, message: Message, history: ReadonlyArray<Message>) => {
    team.getAgent(agentId)?.receive(message, history)
  }
  const house = createHouse(deliver)
  const routeMessage = createMessageRouter(house, team, deliver)
  const intro = house.createRoom({
    name: 'Introductions',
    description: 'All participants introduce themselves here',
    visibility: 'public',
    createdBy: SYSTEM_SENDER_ID,
  })

  return { house, team, intro, routeMessage }
}

// === Mock LLM provider ===

const makeMockProvider = (
  handler: (messages: ReadonlyArray<{ role: string; content: string }>, callIndex: number) => string,
): LLMProvider => {
  let callCount = 0
  return {
    chat: async (req) => {
      const content = handler(req.messages, callCount++)
      return { content, generationMs: 10, tokensUsed: { prompt: 10, completion: 5 } }
    },
    models: async () => ['mock-model'],
  }
}

const makeRespondProvider = (content: string) =>
  makeMockProvider(() => content)

const makePassProvider = (reason = 'not relevant') =>
  makeMockProvider(() => `::PASS:: ${reason}`)

// === Deterministic integration tests (mock LLM) ===

describe('Integration — Full message lifecycle', () => {
  test('room message → AI agent → response delivered to room members', async () => {
    const { house, team, intro, routeMessage } = createSystem()

    // Set up human observer
    const humanInbox: Message[] = []
    const human = createHumanAgent(
      { name: 'Alice', description: 'A researcher' },
      (msg) => { humanInbox.push(msg) },
    )
    team.addAgent(human)
    intro.addMember(human.id)
    await human.join(intro)

    // Create AI agent that always responds
    const provider = makeRespondProvider('Hello from AI!')
    const decisions: Decision[] = []
    const agent = createAIAgent(
      { name: 'Bot', description: 'Test bot', model: 'mock', systemPrompt: 'Be helpful.' },
      provider,
      (d) => {
        decisions.push(d)
        if (d.response.action === 'respond') {
          routeMessage(
            { rooms: [d.triggerRoomId!] },
            { senderId: agent.id, content: d.response.content, type: 'chat', generationMs: d.generationMs },
          )
        }
      },
    )
    team.addAgent(agent)
    intro.addMember(agent.id)
    await agent.join(intro)

    // Human posts a message
    routeMessage(
      { rooms: [intro.profile.id] },
      { senderId: human.id, content: 'What can you do?', type: 'chat' },
    )

    await agent.whenIdle()

    // AI should have decided to respond
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.response.action).toBe('respond')
    expect(decisions[0]!.triggerRoomId).toBe(intro.profile.id)

    // Human should have received the AI's response
    const aiResponse = humanInbox.find(m => m.senderId === agent.id && m.type === 'chat')
    expect(aiResponse).toBeDefined()
    expect(aiResponse!.content).toBe('Hello from AI!')
    expect(aiResponse!.generationMs).toBe(10)
  })

  test('AI agent passes — no message delivered', async () => {
    const { team, intro, routeMessage } = createSystem()

    const humanInbox: Message[] = []
    const human = createHumanAgent({ name: 'Alice', description: 'Test' }, (msg) => { humanInbox.push(msg) })
    team.addAgent(human)
    intro.addMember(human.id)

    const provider = makePassProvider('nothing to add')
    const agent = createAIAgent(
      { name: 'Quiet', description: 'Silent bot', model: 'mock', systemPrompt: 'Stay quiet.' },
      provider,
      () => {}, // no-op onDecision for pass
    )
    team.addAgent(agent)
    intro.addMember(agent.id)

    routeMessage(
      { rooms: [intro.profile.id] },
      { senderId: human.id, content: 'Anyone there?', type: 'chat' },
    )

    await agent.whenIdle()

    // Human should not receive any chat from AI
    const chatFromAI = humanInbox.filter(m => m.senderId === agent.id && m.type === 'chat')
    expect(chatFromAI).toHaveLength(0)
  })

  test('multiple messages during generation — re-evaluation sees all', async () => {
    const { team, intro, routeMessage } = createSystem()

    const capturedContexts: Array<ReadonlyArray<{ role: string; content: string }>> = []
    let callCount = 0
    const provider: LLMProvider = {
      chat: async (req) => {
        callCount++
        capturedContexts.push(req.messages)
        if (callCount === 1) {
          await new Promise(r => setTimeout(r, 50))
        }
        return { content: '::PASS:: done', generationMs: 10, tokensUsed: { prompt: 10, completion: 5 } }
      },
      models: async () => ['mock'],
    }

    const agent = createAIAgent(
      { name: 'Bot', description: 'Test', model: 'mock', systemPrompt: 'Test.' },
      provider,
      () => {},
    )
    team.addAgent(agent)
    intro.addMember(agent.id)

    // First message triggers eval
    routeMessage(
      { rooms: [intro.profile.id] },
      { senderId: 'alice', content: 'msg-1', type: 'chat' },
    )

    // Wait for eval to start, then send more
    await new Promise(r => setTimeout(r, 10))
    routeMessage(
      { rooms: [intro.profile.id] },
      { senderId: 'bob', content: 'msg-2', type: 'chat' },
    )
    routeMessage(
      { rooms: [intro.profile.id] },
      { senderId: 'charlie', content: 'msg-3', type: 'chat' },
    )

    await agent.whenIdle()

    // Two LLM calls: initial + re-eval
    expect(callCount).toBe(2)

    // After a pass, incoming is NOT flushed — all messages stay [NEW] on re-eval
    const lastContext = capturedContexts[1]!
    const userMsgs = lastContext.filter(m => m.role === 'user')
    const newMsgs = userMsgs.filter(m => m.content.includes('[NEW]'))
    expect(newMsgs.length).toBeGreaterThanOrEqual(3)
    expect(newMsgs.some(m => m.content.includes('msg-1'))).toBe(true)
    expect(newMsgs.some(m => m.content.includes('msg-2'))).toBe(true)
    expect(newMsgs.some(m => m.content.includes('msg-3'))).toBe(true)
  })

  test('agent sees own response in re-evaluation context', async () => {
    const { team, intro, routeMessage } = createSystem()

    let callCount = 0
    const capturedContexts: Array<ReadonlyArray<{ role: string; content: string }>> = []
    const provider: LLMProvider = {
      chat: async (req) => {
        callCount++
        capturedContexts.push(req.messages)
        if (callCount === 1) {
          await new Promise(r => setTimeout(r, 50))
          return { content: 'I see msg-1.', generationMs: 10, tokensUsed: { prompt: 10, completion: 5 } }
        }
        return { content: '::PASS:: done', generationMs: 10, tokensUsed: { prompt: 10, completion: 5 } }
      },
      models: async () => ['mock'],
    }

    const agent = createAIAgent(
      { name: 'Bot', description: 'Test', model: 'mock', systemPrompt: 'Test.' },
      provider,
      (d) => {
        if (d.response.action === 'respond') {
          routeMessage(
            { rooms: [d.triggerRoomId!] },
            { senderId: agent.id, content: d.response.content, type: 'chat', generationMs: d.generationMs },
          )
        }
      },
    )
    team.addAgent(agent)
    intro.addMember(agent.id)

    // First message triggers eval
    routeMessage(
      { rooms: [intro.profile.id] },
      { senderId: 'alice', content: 'msg-1', type: 'chat' },
    )

    // Second message during eval → triggers re-eval after first completes
    await new Promise(r => setTimeout(r, 10))
    routeMessage(
      { rooms: [intro.profile.id] },
      { senderId: 'bob', content: 'msg-2', type: 'chat' },
    )

    await agent.whenIdle()

    expect(callCount).toBe(2)

    // In re-eval context, the agent's own response should appear as 'assistant' role
    const reEvalContext = capturedContexts[1]!
    const assistantMsgs = reEvalContext.filter(m => m.role === 'assistant')
    expect(assistantMsgs.some(m => m.content.includes('I see msg-1'))).toBe(true)
  })

  test('two AI agents converse in the same room', async () => {
    const { team, intro, routeMessage } = createSystem()

    // Agent A always responds
    const providerA = makeRespondProvider('Agent A says hi!')

    // Agent B always passes (to prevent infinite loop)
    const providerB = makePassProvider('acknowledged')

    const decisionsA: Decision[] = []
    const agentA = createAIAgent(
      { name: 'AgentA', description: 'First agent', model: 'mock', systemPrompt: 'Respond.' },
      providerA,
      (d) => {
        decisionsA.push(d)
        if (d.response.action === 'respond') {
          routeMessage(
            { rooms: [d.triggerRoomId!] },
            { senderId: agentA.id, content: d.response.content, type: 'chat' },
          )
        }
      },
    )
    team.addAgent(agentA)
    intro.addMember(agentA.id)
    await agentA.join(intro)

    const decisionsB: Decision[] = []
    const agentB = createAIAgent(
      { name: 'AgentB', description: 'Second agent', model: 'mock', systemPrompt: 'Acknowledge.' },
      providerB,
      (d) => { decisionsB.push(d) },
    )
    team.addAgent(agentB)
    intro.addMember(agentB.id)
    await agentB.join(intro)

    // Human triggers the conversation
    const human = createHumanAgent({ name: 'Human', description: 'Test' }, () => {})
    team.addAgent(human)
    intro.addMember(human.id)

    routeMessage(
      { rooms: [intro.profile.id] },
      { senderId: human.id, content: 'Start the discussion!', type: 'chat' },
    )

    await agentA.whenIdle()
    await agentB.whenIdle()

    // Both agents should have been triggered
    expect(decisionsA.length).toBeGreaterThanOrEqual(1)
    expect(decisionsB.length).toBeGreaterThanOrEqual(1)

    // Agent A's response should be in the room
    const roomMsgs = intro.getRecent(20)
    const aResponse = roomMsgs.find(m => m.senderId === agentA.id && m.type === 'chat')
    expect(aResponse).toBeDefined()
    expect(aResponse!.content).toBe('Agent A says hi!')

    // Agent B should have been triggered by Agent A's response
    const bTriggeredByA = decisionsB.some(d => d.triggerRoomId === intro.profile.id)
    expect(bTriggeredByA).toBe(true)
  })

  test('DM flow — AI agent receives DM and responds', async () => {
    const { team, routeMessage } = createSystem()

    const humanInbox: Message[] = []
    const human = createHumanAgent({ name: 'Alice', description: 'Test' }, (msg) => { humanInbox.push(msg) })
    team.addAgent(human)

    const provider = makeRespondProvider('DM received!')
    const agent = createAIAgent(
      { name: 'Bot', description: 'DM bot', model: 'mock', systemPrompt: 'Respond to DMs.' },
      provider,
      (d) => {
        if (d.response.action === 'respond') {
          routeMessage(
            { agents: [d.triggerPeerId!] },
            { senderId: agent.id, content: d.response.content, type: 'chat', generationMs: d.generationMs },
          )
        }
      },
    )
    team.addAgent(agent)

    // Send DM to agent
    routeMessage(
      { agents: [agent.id] },
      { senderId: human.id, content: 'Private question', type: 'chat' },
    )

    await agent.whenIdle()

    // Human should receive DM response
    const dmResponse = humanInbox.find(m => m.senderId === agent.id && m.type === 'chat')
    expect(dmResponse).toBeDefined()
    expect(dmResponse!.content).toBe('DM received!')
    expect(dmResponse!.recipientId).toBe(human.id)
    expect(dmResponse!.roomId).toBeUndefined()
  })

  test('join generates summary and includes it as [NEW] in first context', async () => {
    const { house, team, routeMessage } = createSystem()

    const room = house.createRoom({ name: 'Active', visibility: 'public', createdBy: SYSTEM_SENDER_ID })

    // Put some history in the room
    room.post({ senderId: 'alice', content: 'We should use React', type: 'chat' })
    room.post({ senderId: 'bob', content: 'I prefer Vue', type: 'chat' })

    let firstContextCapture: ReadonlyArray<{ role: string; content: string }> | null = null
    let callCount = 0
    const provider: LLMProvider = {
      chat: async (req) => {
        callCount++
        if (callCount === 1) {
          // This is the join summary call
          return { content: 'Summary: React vs Vue debate.', generationMs: 5, tokensUsed: { prompt: 10, completion: 5 } }
        }
        // Subsequent calls — capture context
        if (!firstContextCapture) firstContextCapture = req.messages
        return { content: '::PASS:: done', generationMs: 10, tokensUsed: { prompt: 10, completion: 5 } }
      },
      models: async () => ['mock'],
    }

    const agent = createAIAgent(
      { name: 'Joiner', description: 'Late joiner', model: 'mock', systemPrompt: 'Test.' },
      provider,
      () => {},
    )
    team.addAgent(agent)
    room.addMember(agent.id)
    await agent.join(room)

    // Trigger evaluation by sending a message
    routeMessage(
      { rooms: [room.profile.id] },
      { senderId: 'alice', content: 'Welcome!', type: 'chat' },
    )

    await agent.whenIdle()

    expect(callCount).toBeGreaterThanOrEqual(2) // summary + eval

    // The room_summary should appear in context
    expect(firstContextCapture).toBeDefined()
    const userMsgs = firstContextCapture!.filter(m => m.role === 'user')
    // Summary should be tagged [NEW] since it hasn't been processed
    const summaryMsg = userMsgs.find(m => m.content.includes('Summary:') && m.content.includes('[NEW]'))
    expect(summaryMsg).toBeDefined()
  })

  test('room history snapshot delivered with each message', async () => {
    const { house, team, routeMessage } = createSystem()

    const room = house.createRoom({ name: 'History', visibility: 'public', createdBy: SYSTEM_SENDER_ID })

    const capturedContexts: Array<ReadonlyArray<{ role: string; content: string }>> = []
    const provider: LLMProvider = {
      chat: async (req) => {
        capturedContexts.push(req.messages)
        return { content: '::PASS:: done', generationMs: 10, tokensUsed: { prompt: 10, completion: 5 } }
      },
      models: async () => ['mock'],
    }

    const agent = createAIAgent(
      { name: 'Observer', description: 'Watches', model: 'mock', systemPrompt: 'Observe.' },
      provider,
      () => {},
    )
    team.addAgent(agent)
    room.addMember(agent.id)

    // Post two messages in sequence, waiting for processing after each
    routeMessage({ rooms: [room.profile.id] }, { senderId: 'alice', content: 'First message', type: 'chat' })
    await agent.whenIdle()

    routeMessage({ rooms: [room.profile.id] }, { senderId: 'bob', content: 'Second message', type: 'chat' })
    await agent.whenIdle()

    expect(capturedContexts).toHaveLength(2)

    // First eval: only "First message" as [NEW]
    const firstUserMsgs = capturedContexts[0]!.filter(m => m.role === 'user')
    expect(firstUserMsgs).toHaveLength(1)
    expect(firstUserMsgs[0]!.content).toContain('[NEW]')
    expect(firstUserMsgs[0]!.content).toContain('First message')

    // Second eval: both messages are [NEW] since the pass didn't flush "First message"
    const secondUserMsgs = capturedContexts[1]!.filter(m => m.role === 'user')
    expect(secondUserMsgs).toHaveLength(2)
    const firstMsg = secondUserMsgs.find(m => m.content.includes('First message'))
    const secondMsg = secondUserMsgs.find(m => m.content.includes('Second message'))
    expect(firstMsg).toBeDefined()
    expect(firstMsg!.content).toContain('[NEW]')
    expect(secondMsg).toBeDefined()
    expect(secondMsg!.content).toContain('[NEW]')
  })

  test('concurrent rooms — each room has independent context', async () => {
    const { house, team, routeMessage } = createSystem()

    const room1 = house.createRoom({ name: 'Room-1', visibility: 'public', createdBy: SYSTEM_SENDER_ID })
    const room2 = house.createRoom({ name: 'Room-2', visibility: 'public', createdBy: SYSTEM_SENDER_ID })

    let evalCount = 0
    const capturedContexts: Array<{ systemContent: string; messages: ReadonlyArray<{ role: string; content: string }> }> = []
    const provider: LLMProvider = {
      chat: async (req) => {
        evalCount++
        const systemMsg = req.messages.find(m => m.role === 'system')!
        capturedContexts.push({ systemContent: systemMsg.content, messages: req.messages })
        return { content: '::PASS:: done', generationMs: 10, tokensUsed: { prompt: 10, completion: 5 } }
      },
      models: async () => ['mock'],
    }

    const agent = createAIAgent(
      { name: 'Multi', description: 'In two rooms', model: 'mock', systemPrompt: 'Test.' },
      provider,
      () => {},
    )
    team.addAgent(agent)
    room1.addMember(agent.id)
    await agent.join(room1)
    room2.addMember(agent.id)
    await agent.join(room2)

    // Post to room1. Room delivers to agent (room1 member).
    // 'alice' becomes implicit member of room1 via post().
    routeMessage({ rooms: [room1.profile.id] }, { senderId: 'alice', content: 'Room 1 msg', type: 'chat' })
    await agent.whenIdle()

    // Now post to room2.
    routeMessage({ rooms: [room2.profile.id] }, { senderId: 'bob', content: 'Room 2 msg', type: 'chat' })

    await agent.whenIdle()

    // Both rooms should have been evaluated (could be 2 or more if re-evals)
    expect(evalCount).toBeGreaterThanOrEqual(2)

    // Find contexts by the "You are in room" line (not "Your rooms" which lists all)
    const room1Contexts = capturedContexts.filter(c => c.systemContent.includes('You are in room "Room-1"'))
    const room2Contexts = capturedContexts.filter(c => c.systemContent.includes('You are in room "Room-2"'))
    expect(room1Contexts.length).toBeGreaterThanOrEqual(1)
    expect(room2Contexts.length).toBeGreaterThanOrEqual(1)

    // Room 1 context should NOT contain Room 2 messages
    const r1UserMsgs = room1Contexts[0]!.messages.filter(m => m.role === 'user')
    expect(r1UserMsgs.every(m => !m.content.includes('Room 2 msg'))).toBe(true)

    // Room 2 context should NOT contain Room 1 messages
    const r2UserMsgs = room2Contexts[0]!.messages.filter(m => m.role === 'user')
    expect(r2UserMsgs.every(m => !m.content.includes('Room 1 msg'))).toBe(true)
  })

  test('system and join messages are not shown to LLM as user messages', async () => {
    const { team, intro, routeMessage } = createSystem()

    let capturedMessages: ReadonlyArray<{ role: string; content: string }> = []
    const provider: LLMProvider = {
      chat: async (req) => {
        capturedMessages = req.messages
        return { content: '::PASS:: done', generationMs: 10, tokensUsed: { prompt: 10, completion: 5 } }
      },
      models: async () => ['mock'],
    }

    const agent = createAIAgent(
      { name: 'Bot', description: 'Test', model: 'mock', systemPrompt: 'Test.' },
      provider,
      () => {},
    )
    team.addAgent(agent)
    intro.addMember(agent.id)

    // Post system and join messages, then a chat message
    routeMessage({ rooms: [intro.profile.id] }, { senderId: SYSTEM_SENDER_ID, content: 'System notice', type: 'system' })
    routeMessage({ rooms: [intro.profile.id] }, { senderId: 'alice', content: '[Alice] joined', type: 'join' })
    routeMessage({ rooms: [intro.profile.id] }, { senderId: 'alice', content: 'Hello!', type: 'chat' })

    await agent.whenIdle()

    const userMsgs = capturedMessages.filter(m => m.role === 'user')
    // Only the chat message should appear as a user message
    expect(userMsgs).toHaveLength(1)
    expect(userMsgs[0]!.content).toContain('Hello!')
    expect(userMsgs.some(m => m.content.includes('System notice'))).toBe(false)
    expect(userMsgs.some(m => m.content.includes('joined'))).toBe(false)
  })

  test('agent state transitions — generating and idle — are reported', async () => {
    const { team, intro, routeMessage } = createSystem()

    const states: Array<{ state: string; context?: string }> = []
    let resolveChat: (() => void) | null = null
    const provider: LLMProvider = {
      chat: () => new Promise(resolve => {
        resolveChat = () => resolve({
          content: '::PASS:: done',
          generationMs: 10,
          tokensUsed: { prompt: 10, completion: 5 },
        })
      }),
      models: async () => ['mock'],
    }

    const agent = createAIAgent(
      { name: 'StateBot', description: 'Test', model: 'mock', systemPrompt: 'Test.' },
      provider,
      () => {},
    )
    team.addAgent(agent)
    intro.addMember(agent.id)

    agent.state.subscribe((state, _id, context) => {
      states.push({ state, context })
    })

    expect(agent.state.get()).toBe('idle')

    routeMessage({ rooms: [intro.profile.id] }, { senderId: 'alice', content: 'Hi', type: 'chat' })
    await new Promise(r => setTimeout(r, 10))

    expect(agent.state.get()).toBe('generating')
    expect(states).toHaveLength(1)
    expect(states[0]).toEqual({ state: 'generating', context: `room:${intro.profile.id}` })

    resolveChat!()
    await agent.whenIdle()

    expect(agent.state.get()).toBe('idle')
    expect(states).toHaveLength(2)
    expect(states[1]).toEqual({ state: 'idle', context: `room:${intro.profile.id}` })
  })
})

describe('Integration — spawnAIAgent full wiring', () => {
  test('spawnAIAgent wires onDecision to routeMessage automatically', async () => {
    const { house, team, intro, routeMessage } = createSystem()

    const humanInbox: Message[] = []
    const human = createHumanAgent({ name: 'Alice', description: 'Test' }, (msg) => { humanInbox.push(msg) })
    await spawnHumanAgent(human, house, team, routeMessage, [intro])

    const provider = makeRespondProvider('Spawned response!')
    const agent = await spawnAIAgent(
      { name: 'Spawned', description: 'Auto-wired', model: 'mock', systemPrompt: 'Respond.' },
      provider, house, team, routeMessage,
    )

    await agent.whenIdle()

    // Trigger the agent
    routeMessage(
      { rooms: [intro.profile.id] },
      { senderId: human.id, content: 'Talk to me!', type: 'chat' },
    )

    await agent.whenIdle()

    // Agent should have responded and human should have received it
    const response = humanInbox.find(m => m.senderId === agent.id && m.type === 'chat')
    expect(response).toBeDefined()
    expect(response!.content).toBe('Spawned response!')
  })

  test('spawnAIAgent auto-joins public rooms and posts join messages', async () => {
    const { house, team, intro, routeMessage } = createSystem()

    const provider = makePassProvider()
    const agent = await spawnAIAgent(
      { name: 'Joiner', description: 'Joins rooms', model: 'mock', systemPrompt: 'Test.' },
      provider, house, team, routeMessage,
    )

    await agent.whenIdle()

    // Agent should be a member of the intro room
    expect(intro.hasMember(agent.id)).toBe(true)

    // Join message should be in the room
    const roomMsgs = intro.getRecent(10)
    const joinMsg = roomMsgs.find(m => m.senderId === agent.id && m.type === 'join')
    expect(joinMsg).toBeDefined()
    expect(joinMsg!.content).toContain('[Joiner]')
    expect(joinMsg!.metadata?.agentName).toBe('Joiner')
    expect(joinMsg!.metadata?.agentKind).toBe('ai')
  })

  test('spawnAIAgent with tools — tool calls are executed', async () => {
    const { house, team, intro, routeMessage } = createSystem()
    const toolRegistry = createToolRegistry()
    toolRegistry.register(createGetTimeTool())

    let callCount = 0
    const provider: LLMProvider = {
      chat: async () => {
        callCount++
        if (callCount === 1) {
          // Join summary — empty room, won't be called
        }
        if (callCount === 1) {
          return {
            content: '::TOOL:: get_time',
            generationMs: 10, tokensUsed: { prompt: 10, completion: 5 },
          }
        }
        return {
          content: 'The time was retrieved!',
          generationMs: 10, tokensUsed: { prompt: 10, completion: 5 },
        }
      },
      models: async () => ['mock'],
    }

    const humanInbox: Message[] = []
    const human = createHumanAgent({ name: 'Alice', description: 'Test' }, (msg) => { humanInbox.push(msg) })
    await spawnHumanAgent(human, house, team, routeMessage, [intro])

    const agent = await spawnAIAgent(
      { name: 'ToolBot', description: 'Uses tools', model: 'mock', systemPrompt: 'Use tools.', tools: ['get_time'] },
      provider, house, team, routeMessage, toolRegistry,
    )

    await agent.whenIdle()

    routeMessage(
      { rooms: [intro.profile.id] },
      { senderId: human.id, content: 'What time is it?', type: 'chat' },
    )

    await agent.whenIdle()

    // Tool was called then agent responded
    expect(callCount).toBeGreaterThanOrEqual(2)
    const response = humanInbox.find(m => m.senderId === agent.id && m.type === 'chat')
    expect(response).toBeDefined()
    expect(response!.content).toBe('The time was retrieved!')
  })

  test('addAgentToRoom posts join message with metadata', async () => {
    const { house, team, routeMessage } = createSystem()

    const room = house.createRoom({ name: 'NewRoom', visibility: 'private', createdBy: SYSTEM_SENDER_ID })

    const humanInbox: Message[] = []
    const human = createHumanAgent({ name: 'Alice', description: 'A person' }, (msg) => { humanInbox.push(msg) })
    team.addAgent(human)
    room.addMember(human.id)
    await human.join(room)

    const bot = createAIAgent(
      { name: 'Bot', description: 'Helper', model: 'mock', systemPrompt: 'Help.' },
      makePassProvider(),
      () => {},
    )
    team.addAgent(bot)

    await addAgentToRoom(bot.id, bot.name, room.profile.id, 'Alice', team, routeMessage, house)

    // Join message should be delivered to Alice
    const joinMsg = humanInbox.find(m => m.senderId === bot.id && m.type === 'join')
    expect(joinMsg).toBeDefined()
    expect(joinMsg!.content).toContain('[Bot]')
    expect(joinMsg!.content).toContain('added by [Alice]')
    expect(joinMsg!.metadata?.agentName).toBe('Bot')
    expect(joinMsg!.metadata?.agentKind).toBe('ai')
  })
})

describe('Integration — Room + Team + routeMessage', () => {
  test('human agent receives messages from room', () => {
    const { team, intro, routeMessage } = createSystem()

    const aliceInbox: Message[] = []
    const alice = createHumanAgent(
      { name: 'Alice', description: 'A researcher' },
      (msg) => { aliceInbox.push(msg) },
    )

    const bobInbox: Message[] = []
    const bob = createHumanAgent(
      { name: 'Bob', description: 'An engineer' },
      (msg) => { bobInbox.push(msg) },
    )

    team.addAgent(alice)
    team.addAgent(bob)

    routeMessage({ rooms: [intro.profile.id] }, { senderId: alice.id, content: '[Alice] has joined', type: 'join' })
    routeMessage({ rooms: [intro.profile.id] }, { senderId: bob.id, content: '[Bob] has joined', type: 'join' })
    routeMessage({ rooms: [intro.profile.id] }, { senderId: alice.id, content: 'Hello everyone!', type: 'chat' })

    expect(bobInbox.some(m => m.content === 'Hello everyone!')).toBe(true)
    expect(aliceInbox.some(m => m.content === 'Hello everyone!')).toBe(false)
  })

  test('routeMessage stamps roomId on room messages', () => {
    const { house, routeMessage } = createSystem()
    const specific = house.createRoom({ name: 'Specific', visibility: 'public', createdBy: 'test' })

    const msgs = routeMessage({ rooms: [specific.profile.id] }, { senderId: 'test', content: 'Hello', type: 'chat' })
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.roomId).toBe(specific.profile.id)
  })

  test('DM delivery: recipient and sender both receive', () => {
    const { team, routeMessage } = createSystem()

    const aliceInbox: Message[] = []
    const bobInbox: Message[] = []

    const alice = createHumanAgent({ name: 'Alice', description: 'Test' }, (msg) => { aliceInbox.push(msg) })
    const bob = createHumanAgent({ name: 'Bob', description: 'Test' }, (msg) => { bobInbox.push(msg) })

    team.addAgent(alice)
    team.addAgent(bob)

    const msgs = routeMessage({ agents: [bob.id] }, { senderId: alice.id, content: 'Private hello', type: 'chat' })

    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.recipientId).toBe(bob.id)
    expect(msgs[0]!.roomId).toBeUndefined()

    expect(bobInbox.some(m => m.content === 'Private hello')).toBe(true)
    expect(aliceInbox.some(m => m.content === 'Private hello')).toBe(false)
  })

  test('correlationId shared across multi-target delivery', () => {
    const { team, intro, routeMessage } = createSystem()

    const aliceInbox: Message[] = []
    const bobInbox: Message[] = []

    const alice = createHumanAgent({ name: 'Alice', description: 'Test' }, (msg) => { aliceInbox.push(msg) })
    const bob = createHumanAgent({ name: 'Bob', description: 'Test' }, (msg) => { bobInbox.push(msg) })
    team.addAgent(alice)
    team.addAgent(bob)

    routeMessage({ rooms: [intro.profile.id] }, { senderId: alice.id, content: '[Alice] joined', type: 'join' })

    const charlie = createHumanAgent({ name: 'Charlie', description: 'Test' }, () => {})
    team.addAgent(charlie)
    routeMessage({ rooms: [intro.profile.id] }, { senderId: charlie.id, content: '[Charlie] joined', type: 'join' })

    const msgs = routeMessage(
      { rooms: [intro.profile.id], agents: [bob.id] },
      { senderId: charlie.id, content: 'Check this out', type: 'chat' },
    )

    expect(msgs).toHaveLength(2)
    expect(msgs[0]!.correlationId).toBeTruthy()
    expect(msgs[0]!.correlationId).toBe(msgs[1]!.correlationId)
    expect(msgs[0]!.roomId).toBe(intro.profile.id)
    expect(msgs[1]!.recipientId).toBe(bob.id)
  })

  test('DM does not go through room — room has no record', () => {
    const { team, intro, routeMessage } = createSystem()

    const bob = createHumanAgent({ name: 'Bob', description: 'Test' }, () => {})
    team.addAgent(bob)

    routeMessage({ agents: [bob.id] }, { senderId: 'alice-temp', content: 'Secret', type: 'chat' })

    expect(intro.getMessageCount()).toBe(0)
  })

  test('agent self-DM is prevented', () => {
    const { team, routeMessage } = createSystem()

    const aliceInbox: Message[] = []
    const alice = createHumanAgent({ name: 'Alice', description: 'Test' }, (msg) => { aliceInbox.push(msg) })
    team.addAgent(alice)

    const msgs = routeMessage({ agents: [alice.id] }, { senderId: alice.id, content: 'Hello me', type: 'chat' })
    expect(msgs).toHaveLength(0)
  })

  test('multiple rooms operate independently with team delivery', () => {
    const { house, team, routeMessage } = createSystem()

    const room1 = house.createRoom({ name: 'Room 1', visibility: 'public', createdBy: 'test' })
    const room2 = house.createRoom({ name: 'Room 2', visibility: 'public', createdBy: 'test' })

    const aliceInbox: Message[] = []
    const alice = createHumanAgent({ name: 'Alice', description: 'Test' }, (msg) => { aliceInbox.push(msg) })
    team.addAgent(alice)

    const bob = createHumanAgent({ name: 'Bob', description: 'Test' }, () => {})
    const charlie = createHumanAgent({ name: 'Charlie', description: 'Test' }, () => {})
    team.addAgent(bob)
    team.addAgent(charlie)

    routeMessage({ rooms: [room1.profile.id] }, { senderId: alice.id, content: '[Alice] joined', type: 'join' })
    routeMessage({ rooms: [room1.profile.id] }, { senderId: bob.id, content: '[Bob] joined', type: 'join' })
    routeMessage({ rooms: [room2.profile.id] }, { senderId: charlie.id, content: '[Charlie] joined', type: 'join' })

    routeMessage({ rooms: [room1.profile.id] }, { senderId: bob.id, content: 'Room 1 message', type: 'chat' })
    expect(aliceInbox.some(m => m.content === 'Room 1 message')).toBe(true)

    const beforeCount = aliceInbox.length
    routeMessage({ rooms: [room2.profile.id] }, { senderId: charlie.id, content: 'Room 2 message', type: 'chat' })
    expect(aliceInbox.length).toBe(beforeCount)
  })

  test('findByName resolves rooms and agents', () => {
    const { house, team } = createSystem()

    const room = house.createRoom({ name: 'Planning', visibility: 'public', createdBy: 'test' })
    expect(house.getRoom('Planning')).toBe(room)
    expect(house.getRoom('planning')).toBe(room)

    const alice = createHumanAgent({ name: 'Alice', description: 'Test' }, () => {})
    team.addAgent(alice)
    expect(team.getAgent('Alice')).toBe(alice)
    expect(team.getAgent('alice')).toBe(alice)
  })

  test('team name uniqueness enforced', () => {
    const { team } = createSystem()

    const alice = createHumanAgent({ name: 'Alice', description: 'Test' }, () => {})
    team.addAgent(alice)

    const alice2 = createHumanAgent({ name: 'Alice', description: 'Test 2' }, () => {})
    expect(() => team.addAgent(alice2)).toThrow('Agent name "Alice" is already taken')
  })
})

describe('Integration — AI Agent with real Ollama', () => {
  const ollamaProvider = createOllamaProvider(DEFAULTS.ollamaBaseUrl)

  test('spawnAIAgent creates agent, joins rooms, posts join message', async () => {
    const { house, team, intro, routeMessage } = createSystem()

    const agent = await spawnAIAgent(
      {
        name: 'Analyst',
        description: 'Analyzes data',
        model: FAST_MODEL,
        systemPrompt: 'You are a data analyst. Be concise.',
      },
      ollamaProvider, house, team, routeMessage,
    )

    expect(team.getAgent(agent.id)).toBe(agent)
    expect(agent.kind).toBe('ai')
    expect(agent.id).toHaveLength(36)

    const introMsgs = intro.getRecent(10)
    const joinMsg = introMsgs.find(m => m.senderId === agent.id && m.type === 'join')
    expect(joinMsg).toBeDefined()
    expect(joinMsg!.content).toContain('[Analyst]')
    expect(joinMsg!.metadata?.agentName).toBe('Analyst')
  }, 60_000)

  test('human and AI agent converse via room', async () => {
    const { house, team, intro, routeMessage } = createSystem()

    const humanInbox: Message[] = []
    const human = createHumanAgent(
      { name: 'Alice', description: 'A curious researcher' },
      (msg) => { humanInbox.push(msg) },
    )
    await spawnHumanAgent(human, house, team, routeMessage, [intro])

    const aiAgent = await spawnAIAgent(
      {
        name: 'Responder',
        description: 'Responds to questions',
        model: FAST_MODEL,
        systemPrompt: 'You are a friendly assistant. Always respond to questions concisely. Never pass. Always target the room you are in.',
      },
      ollamaProvider, house, team, routeMessage,
    )

    await aiAgent.whenIdle()

    routeMessage(
      { rooms: [intro.profile.id] },
      { senderId: human.id, content: 'Can you tell me a fun fact about dolphins?', type: 'chat' },
    )

    await aiAgent.whenIdle(30_000)

    const aiResponse = humanInbox.find(m => m.senderId === aiAgent.id && m.type === 'chat')

    expect(aiResponse).toBeDefined()
    expect(aiResponse!.content.length).toBeGreaterThan(0)
    expect(aiResponse!.generationMs).toBeGreaterThan(0)
    console.log(`[Test] Human received: "${aiResponse!.content}" (${aiResponse!.generationMs}ms)`)
  }, 60_000)
})
