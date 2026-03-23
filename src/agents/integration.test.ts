import { describe, test, expect } from 'bun:test'
import { createHouse, initIntroductionsRoom } from '../core/house.ts'
import { createTeam } from './team.ts'
import { createHumanAgent } from './human-agent.ts'
import { spawnAIAgent, spawnHumanAgent } from './spawn.ts'
import { createOllamaProvider } from '../llm/ollama.ts'
import type { Message, MessageTarget, PostAndDeliver } from '../core/types.ts'
import { DEFAULTS } from '../core/types.ts'

const FAST_MODEL = 'llama3.2:latest'

// Create the full system wiring
const createSystem = () => {
  const house = createHouse()
  const team = createTeam()
  const intro = initIntroductionsRoom(house)

  const deliver = (id: string, message: Message): void => {
    try {
      team.get(id)?.receive(message)
    } catch (err) {
      console.error(`[deliver] Failed for ${id}:`, err)
    }
  }

  const postAndDeliver: PostAndDeliver = (target: MessageTarget, params) => {
    const correlationId = crypto.randomUUID()
    const delivered: Message[] = []

    // Deliver to rooms
    if (target.rooms) {
      for (const roomId of target.rooms) {
        const room = house.getRoom(roomId)
        if (!room) continue
        const { message, recipientIds } = room.post({ ...params, correlationId })
        delivered.push(message)
        for (const id of recipientIds) deliver(id, message)
      }
    }

    // Deliver DMs
    if (target.agents) {
      for (const agentId of target.agents) {
        if (agentId === params.senderId) continue // don't DM yourself
        const dmMessage: Message = {
          id: crypto.randomUUID(),
          recipientId: agentId,
          senderId: params.senderId,
          content: params.content,
          timestamp: Date.now(),
          type: params.type,
          correlationId,
          generationMs: params.generationMs,
          metadata: params.metadata,
        }
        delivered.push(dmMessage)
        deliver(agentId, dmMessage)
        deliver(params.senderId, dmMessage) // sender stores own DM
      }
    }

    return delivered
  }

  return { house, team, intro, postAndDeliver }
}

describe('Integration — Room + Team + postAndDeliver', () => {
  test('human agent receives messages from room', () => {
    const { team, intro, postAndDeliver } = createSystem()

    const aliceInbox: Message[] = []
    const alice = createHumanAgent(
      { id: 'alice', name: 'Alice', description: 'A researcher' },
      (msg) => { aliceInbox.push(msg) },
    )

    const bobInbox: Message[] = []
    const bob = createHumanAgent(
      { id: 'bob', name: 'Bob', description: 'An engineer' },
      (msg) => { bobInbox.push(msg) },
    )

    team.add(alice)
    team.add(bob)

    postAndDeliver({ rooms: [intro.profile.id] }, { senderId: 'alice', content: '[Alice] has joined', type: 'join' })
    postAndDeliver({ rooms: [intro.profile.id] }, { senderId: 'bob', content: '[Bob] has joined', type: 'join' })
    postAndDeliver({ rooms: [intro.profile.id] }, { senderId: 'alice', content: 'Hello everyone!', type: 'chat' })

    expect(bobInbox.some(m => m.content === 'Hello everyone!')).toBe(true)
    expect(aliceInbox.some(m => m.content === 'Hello everyone!')).toBe(false)
  })

  test('postAndDeliver stamps roomId on room messages', () => {
    const { house, postAndDeliver } = createSystem()
    house.createRoom({ id: 'specific', name: 'Specific', visibility: 'public', createdBy: 'test' })

    const msgs = postAndDeliver({ rooms: ['specific'] }, { senderId: 'test', content: 'Hello', type: 'chat' })
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.roomId).toBe('specific')
  })

  test('DM delivery: recipient and sender both receive', () => {
    const { team, postAndDeliver } = createSystem()

    const aliceInbox: Message[] = []
    const bobInbox: Message[] = []

    const alice = createHumanAgent({ id: 'alice', name: 'Alice', description: 'Test' }, (msg) => { aliceInbox.push(msg) })
    const bob = createHumanAgent({ id: 'bob', name: 'Bob', description: 'Test' }, (msg) => { bobInbox.push(msg) })

    team.add(alice)
    team.add(bob)

    // Alice DMs Bob
    const msgs = postAndDeliver({ agents: ['bob'] }, { senderId: 'alice', content: 'Private hello', type: 'chat' })

    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.recipientId).toBe('bob')
    expect(msgs[0]!.roomId).toBeUndefined() // DM has no roomId

    // Bob receives
    expect(bobInbox.some(m => m.content === 'Private hello')).toBe(true)
    // Alice also receives (sender stores own DM)
    expect(aliceInbox.some(m => m.content === 'Private hello')).toBe(true)
  })

  test('correlationId shared across multi-target delivery', () => {
    const { team, intro, postAndDeliver } = createSystem()

    const aliceInbox: Message[] = []
    const bobInbox: Message[] = []

    const alice = createHumanAgent({ id: 'alice', name: 'Alice', description: 'Test' }, (msg) => { aliceInbox.push(msg) })
    const bob = createHumanAgent({ id: 'bob', name: 'Bob', description: 'Test' }, (msg) => { bobInbox.push(msg) })
    team.add(alice)
    team.add(bob)

    // Alice joins the room first
    postAndDeliver({ rooms: [intro.profile.id] }, { senderId: 'alice', content: '[Alice] joined', type: 'join' })

    // Charlie posts to both the room and DMs Bob
    postAndDeliver({ rooms: [intro.profile.id] }, { senderId: 'charlie', content: '[Charlie] joined', type: 'join' })
    const msgs = postAndDeliver(
      { rooms: [intro.profile.id], agents: ['bob'] },
      { senderId: 'charlie', content: 'Check this out', type: 'chat' },
    )

    // Two messages delivered (one room, one DM)
    expect(msgs).toHaveLength(2)
    // Both share the same correlationId
    expect(msgs[0]!.correlationId).toBeTruthy()
    expect(msgs[0]!.correlationId).toBe(msgs[1]!.correlationId)
    // Room message has roomId, DM has recipientId
    expect(msgs[0]!.roomId).toBe(intro.profile.id)
    expect(msgs[1]!.recipientId).toBe('bob')
  })

  test('DM does not go through room — room has no record', () => {
    const { team, intro, postAndDeliver } = createSystem()

    const bob = createHumanAgent({ id: 'bob', name: 'Bob', description: 'Test' }, () => {})
    team.add(bob)

    postAndDeliver({ agents: ['bob'] }, { senderId: 'alice', content: 'Secret', type: 'chat' })

    // Room should have no messages (DM bypasses room)
    expect(intro.getMessageCount()).toBe(0)
  })

  test('agent self-DM is prevented', () => {
    const { team, postAndDeliver } = createSystem()

    const aliceInbox: Message[] = []
    const alice = createHumanAgent({ id: 'alice', name: 'Alice', description: 'Test' }, (msg) => { aliceInbox.push(msg) })
    team.add(alice)

    // Alice tries to DM herself
    const msgs = postAndDeliver({ agents: ['alice'] }, { senderId: 'alice', content: 'Hello me', type: 'chat' })
    expect(msgs).toHaveLength(0) // skipped
  })

  test('multiple rooms operate independently with team delivery', () => {
    const { house, team, postAndDeliver } = createSystem()

    const room1 = house.createRoom({ name: 'Room 1', visibility: 'public', createdBy: 'test' })
    const room2 = house.createRoom({ name: 'Room 2', visibility: 'public', createdBy: 'test' })

    const aliceInbox: Message[] = []
    const alice = createHumanAgent({ id: 'alice', name: 'Alice', description: 'Test' }, (msg) => { aliceInbox.push(msg) })
    team.add(alice)

    postAndDeliver({ rooms: [room1.profile.id] }, { senderId: 'alice', content: '[Alice] joined', type: 'join' })
    postAndDeliver({ rooms: [room1.profile.id] }, { senderId: 'bob', content: '[Bob] joined', type: 'join' })
    postAndDeliver({ rooms: [room2.profile.id] }, { senderId: 'charlie', content: '[Charlie] joined', type: 'join' })

    postAndDeliver({ rooms: [room1.profile.id] }, { senderId: 'bob', content: 'Room 1 message', type: 'chat' })
    expect(aliceInbox.some(m => m.content === 'Room 1 message')).toBe(true)

    const beforeCount = aliceInbox.length
    postAndDeliver({ rooms: [room2.profile.id] }, { senderId: 'charlie', content: 'Room 2 message', type: 'chat' })
    expect(aliceInbox.length).toBe(beforeCount) // Alice not in room 2
  })
})

describe('Integration — AI Agent with real Ollama', () => {
  const ollamaProvider = createOllamaProvider(DEFAULTS.ollamaBaseUrl)

  test('spawnAIAgent creates agent, joins rooms, posts join message', async () => {
    const { house, team, intro, postAndDeliver } = createSystem()

    const agent = await spawnAIAgent(
      {
        participantId: 'analyst-1',
        name: 'Analyst',
        description: 'Analyzes data',
        model: FAST_MODEL,
        systemPrompt: 'You are a data analyst. Be concise.',
        cooldownMs: 1000,
      },
      ollamaProvider, house, team, postAndDeliver,
    )

    expect(team.get('analyst-1')).toBe(agent)
    expect(agent.kind).toBe('ai')

    const introMsgs = intro.getRecent(10)
    const joinMsg = introMsgs.find(m => m.senderId === 'analyst-1' && m.type === 'join')
    expect(joinMsg).toBeDefined()
    expect(joinMsg!.content).toContain('[Analyst]')
    expect(joinMsg!.metadata?.agentName).toBe('Analyst')
  }, 60_000)

  test('human and AI agent converse via room', async () => {
    const { house, team, intro, postAndDeliver } = createSystem()

    const humanInbox: Message[] = []
    const human = createHumanAgent(
      { id: 'human-1', name: 'Alice', description: 'A curious researcher' },
      (msg) => { humanInbox.push(msg) },
    )
    await spawnHumanAgent(human, house, team, postAndDeliver, [intro])

    await spawnAIAgent(
      {
        participantId: 'responder-1',
        name: 'Responder',
        description: 'Responds to questions',
        model: FAST_MODEL,
        systemPrompt: 'You are a friendly assistant. Always respond to questions concisely. Never pass. Always target the room you are in.',
        cooldownMs: 500,
      },
      ollamaProvider, house, team, postAndDeliver,
    )

    // Wait for any initial response to complete before human asks
    await new Promise(resolve => setTimeout(resolve, 5_000))

    postAndDeliver(
      { rooms: [intro.profile.id] },
      { senderId: 'human-1', content: 'Can you tell me a fun fact about dolphins?', type: 'chat' },
    )

    await new Promise(resolve => setTimeout(resolve, 15_000))

    const aiResponse = humanInbox.find(m => m.senderId === 'responder-1' && m.type === 'chat')

    expect(aiResponse).toBeDefined()
    expect(aiResponse!.content.length).toBeGreaterThan(0)
    expect(aiResponse!.generationMs).toBeGreaterThan(0)
    console.log(`[Test] Human received: "${aiResponse!.content}" (${aiResponse!.generationMs}ms)`)
  }, 60_000)
})
