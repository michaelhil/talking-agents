import { describe, test, expect } from 'bun:test'
import { createHouse } from '../core/house.ts'
import { createPostAndDeliver } from '../core/delivery.ts'
import { createTeam } from './team.ts'
import { createHumanAgent } from './human-agent.ts'
import { spawnAIAgent, spawnHumanAgent } from './spawn.ts'
import { createOllamaProvider } from '../llm/ollama.ts'
import type { Message } from '../core/types.ts'
import { DEFAULTS, SYSTEM_SENDER_ID } from '../core/types.ts'

const FAST_MODEL = 'llama3.2:latest'

// Create the full system wiring
const createSystem = () => {
  const house = createHouse()
  const team = createTeam()
  const postAndDeliver = createPostAndDeliver(house, team)
  const intro = house.createRoom({
    name: 'Introductions',
    description: 'All participants introduce themselves here',
    visibility: 'public',
    createdBy: SYSTEM_SENDER_ID,
  })

  return { house, team, intro, postAndDeliver }
}

describe('Integration — Room + Team + postAndDeliver', () => {
  test('human agent receives messages from room', () => {
    const { team, intro, postAndDeliver } = createSystem()

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

    postAndDeliver({ rooms: [intro.profile.id] }, { senderId: alice.id, content: '[Alice] has joined', type: 'join' })
    postAndDeliver({ rooms: [intro.profile.id] }, { senderId: bob.id, content: '[Bob] has joined', type: 'join' })
    postAndDeliver({ rooms: [intro.profile.id] }, { senderId: alice.id, content: 'Hello everyone!', type: 'chat' })

    expect(bobInbox.some(m => m.content === 'Hello everyone!')).toBe(true)
    expect(aliceInbox.some(m => m.content === 'Hello everyone!')).toBe(false)
  })

  test('postAndDeliver stamps roomId on room messages', () => {
    const { house, postAndDeliver } = createSystem()
    const specific = house.createRoom({ name: 'Specific', visibility: 'public', createdBy: 'test' })

    const msgs = postAndDeliver({ rooms: [specific.profile.id] }, { senderId: 'test', content: 'Hello', type: 'chat' })
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.roomId).toBe(specific.profile.id)
  })

  test('DM delivery: recipient and sender both receive', () => {
    const { team, postAndDeliver } = createSystem()

    const aliceInbox: Message[] = []
    const bobInbox: Message[] = []

    const alice = createHumanAgent({ name: 'Alice', description: 'Test' }, (msg) => { aliceInbox.push(msg) })
    const bob = createHumanAgent({ name: 'Bob', description: 'Test' }, (msg) => { bobInbox.push(msg) })

    team.addAgent(alice)
    team.addAgent(bob)

    const msgs = postAndDeliver({ agents: [bob.id] }, { senderId: alice.id, content: 'Private hello', type: 'chat' })

    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.recipientId).toBe(bob.id)
    expect(msgs[0]!.roomId).toBeUndefined()

    // Bob receives via transport
    expect(bobInbox.some(m => m.content === 'Private hello')).toBe(true)
    // Alice stores own DM internally but doesn't echo to transport
    expect(aliceInbox.some(m => m.content === 'Private hello')).toBe(false)
    expect(alice.getMessages().some(m => m.content === 'Private hello')).toBe(true)
  })

  test('correlationId shared across multi-target delivery', () => {
    const { team, intro, postAndDeliver } = createSystem()

    const aliceInbox: Message[] = []
    const bobInbox: Message[] = []

    const alice = createHumanAgent({ name: 'Alice', description: 'Test' }, (msg) => { aliceInbox.push(msg) })
    const bob = createHumanAgent({ name: 'Bob', description: 'Test' }, (msg) => { bobInbox.push(msg) })
    team.addAgent(alice)
    team.addAgent(bob)

    postAndDeliver({ rooms: [intro.profile.id] }, { senderId: alice.id, content: '[Alice] joined', type: 'join' })

    const charlie = createHumanAgent({ name: 'Charlie', description: 'Test' }, () => {})
    team.addAgent(charlie)
    postAndDeliver({ rooms: [intro.profile.id] }, { senderId: charlie.id, content: '[Charlie] joined', type: 'join' })

    const msgs = postAndDeliver(
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
    const { team, intro, postAndDeliver } = createSystem()

    const bob = createHumanAgent({ name: 'Bob', description: 'Test' }, () => {})
    team.addAgent(bob)

    postAndDeliver({ agents: [bob.id] }, { senderId: 'alice-temp', content: 'Secret', type: 'chat' })

    expect(intro.getMessageCount()).toBe(0)
  })

  test('agent self-DM is prevented', () => {
    const { team, postAndDeliver } = createSystem()

    const aliceInbox: Message[] = []
    const alice = createHumanAgent({ name: 'Alice', description: 'Test' }, (msg) => { aliceInbox.push(msg) })
    team.addAgent(alice)

    const msgs = postAndDeliver({ agents: [alice.id] }, { senderId: alice.id, content: 'Hello me', type: 'chat' })
    expect(msgs).toHaveLength(0)
  })

  test('multiple rooms operate independently with team delivery', () => {
    const { house, team, postAndDeliver } = createSystem()

    const room1 = house.createRoom({ name: 'Room 1', visibility: 'public', createdBy: 'test' })
    const room2 = house.createRoom({ name: 'Room 2', visibility: 'public', createdBy: 'test' })

    const aliceInbox: Message[] = []
    const alice = createHumanAgent({ name: 'Alice', description: 'Test' }, (msg) => { aliceInbox.push(msg) })
    team.addAgent(alice)

    const bob = createHumanAgent({ name: 'Bob', description: 'Test' }, () => {})
    const charlie = createHumanAgent({ name: 'Charlie', description: 'Test' }, () => {})
    team.addAgent(bob)
    team.addAgent(charlie)

    postAndDeliver({ rooms: [room1.profile.id] }, { senderId: alice.id, content: '[Alice] joined', type: 'join' })
    postAndDeliver({ rooms: [room1.profile.id] }, { senderId: bob.id, content: '[Bob] joined', type: 'join' })
    postAndDeliver({ rooms: [room2.profile.id] }, { senderId: charlie.id, content: '[Charlie] joined', type: 'join' })

    postAndDeliver({ rooms: [room1.profile.id] }, { senderId: bob.id, content: 'Room 1 message', type: 'chat' })
    expect(aliceInbox.some(m => m.content === 'Room 1 message')).toBe(true)

    const beforeCount = aliceInbox.length
    postAndDeliver({ rooms: [room2.profile.id] }, { senderId: charlie.id, content: 'Room 2 message', type: 'chat' })
    expect(aliceInbox.length).toBe(beforeCount) // Alice not in room 2
  })

  test('findByName resolves rooms and agents', () => {
    const { house, team } = createSystem()

    const room = house.createRoom({ name: 'Planning', visibility: 'public', createdBy: 'test' })
    expect(house.getRoom('Planning')).toBe(room)
    expect(house.getRoom('planning')).toBe(room) // case-insensitive

    const alice = createHumanAgent({ name: 'Alice', description: 'Test' }, () => {})
    team.addAgent(alice)
    expect(team.getAgent('Alice')).toBe(alice)
    expect(team.getAgent('alice')).toBe(alice) // case-insensitive
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
    const { house, team, intro, postAndDeliver } = createSystem()

    const agent = await spawnAIAgent(
      {
        name: 'Analyst',
        description: 'Analyzes data',
        model: FAST_MODEL,
        systemPrompt: 'You are a data analyst. Be concise.',
        cooldownMs: 1000,
      },
      ollamaProvider, house, team, postAndDeliver,
    )

    expect(team.getAgent(agent.id)).toBe(agent)
    expect(agent.kind).toBe('ai')
    expect(agent.id).toHaveLength(36) // UUID

    const introMsgs = intro.getRecent(10)
    const joinMsg = introMsgs.find(m => m.senderId === agent.id && m.type === 'join')
    expect(joinMsg).toBeDefined()
    expect(joinMsg!.content).toContain('[Analyst]')
    expect(joinMsg!.metadata?.agentName).toBe('Analyst')
  }, 60_000)

  test('human and AI agent converse via room', async () => {
    const { house, team, intro, postAndDeliver } = createSystem()

    const humanInbox: Message[] = []
    const human = createHumanAgent(
      { name: 'Alice', description: 'A curious researcher' },
      (msg) => { humanInbox.push(msg) },
    )
    await spawnHumanAgent(human, house, team, postAndDeliver, [intro])

    const aiAgent = await spawnAIAgent(
      {
        name: 'Responder',
        description: 'Responds to questions',
        model: FAST_MODEL,
        systemPrompt: 'You are a friendly assistant. Always respond to questions concisely. Never pass. Always target the room you are in.',
        cooldownMs: 500,
      },
      ollamaProvider, house, team, postAndDeliver,
    )

    await aiAgent.whenIdle()

    postAndDeliver(
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
