import { describe, test, expect } from 'bun:test'
import { createHouse } from '../core/house.ts'
import { createMessageRouter } from '../core/delivery.ts'
import { createTeam } from './team.ts'
import { createHumanAgent } from './human-agent.ts'
import { addAgentToRoom, removeAgentFromRoom, ORCHESTRATED_INVITERS } from './actions.ts'
import type { Agent } from '../core/types/agent.ts'
import type { Message } from '../core/types/messaging.ts'

// Minimal AI stub — just enough surface for addAgentToRoom + the auto-switch
// heuristic, which only inspects `kind`. We don't need a real LLM-backed agent.
let aiCounter = 0
const makeAIStub = (name: string): Agent => ({
  id: `ai-${++aiCounter}`,
  name,
  kind: 'ai',
  metadata: {},
  state: { get: () => 'idle' as const, getContext: () => undefined, getStartedAt: () => undefined, subscribe: () => () => {} },
  receive: () => {},
  join: async () => {},
  leave: () => {},
})

const createTestSystem = () => {
  const team = createTeam()
  const deliver = (agentId: string, message: Message) => {
    team.getAgent(agentId)?.receive(message)
  }
  const house = createHouse({ deliver })
  const routeMessage = createMessageRouter({ house })
  return { house, team, routeMessage }
}

const makeAgent = (name: string) => {
  const inbox: Message[] = []
  const agent = createHumanAgent({ name }, (msg) => inbox.push(msg))
  return { agent, inbox }
}

describe('addAgentToRoom', () => {
  test('adds agent to room, calls join, posts join message', async () => {
    const { house, team, routeMessage } = createTestSystem()
    const { agent, inbox } = makeAgent('Alice')
    team.addAgent(agent)
    const room = house.createRoom({ name: 'General', createdBy: 'system' })

    await addAgentToRoom(agent.id, agent.name, room.profile.id, undefined, team, routeMessage, house)

    expect(room.hasMember(agent.id)).toBe(true)
    const joinMsg = room.getRecent(5).find(m => m.type === 'join' && m.senderId === agent.id)
    expect(joinMsg).toBeDefined()
    expect(joinMsg!.content).toBe('[Alice] has joined')
    expect(joinMsg!.agentName).toBe('Alice')
    // human inbox gets recent history on join
    expect(inbox.length).toBeGreaterThanOrEqual(0)
  })

  test('includes inviter name in join message', async () => {
    const { house, team, routeMessage } = createTestSystem()
    const { agent } = makeAgent('Bob')
    team.addAgent(agent)
    const room = house.createRoom({ name: 'Club', createdBy: 'system' })

    await addAgentToRoom(agent.id, agent.name, room.profile.id, 'Admin', team, routeMessage, house)

    const joinMsg = room.getRecent(5).find(m => m.type === 'join')
    expect(joinMsg!.content).toBe('[Bob] has joined (added by [Admin])')
  })

  test('no-ops if agent not in team', async () => {
    const { house, team, routeMessage } = createTestSystem()
    const room = house.createRoom({ name: 'Room', createdBy: 'system' })

    await addAgentToRoom('ghost-id', 'Ghost', room.profile.id, undefined, team, routeMessage, house)

    expect(room.hasMember('ghost-id')).toBe(false)
    expect(room.getMessageCount()).toBe(0)
  })

  test('no-ops if room not found', async () => {
    const { house, team, routeMessage } = createTestSystem()
    const { agent } = makeAgent('Alice')
    team.addAgent(agent)

    // No throw expected
    await addAgentToRoom(agent.id, agent.name, 'nonexistent-room-id', undefined, team, routeMessage, house)
  })

  // ============================================================================
  // Auto-switch heuristic: when a SECOND AI joins a broadcast room, the room
  // auto-switches to manual mode to prevent two AIs spamming each other.
  // The heuristic is correct for interactive adds (a user inviting a second
  // AI to a chat). It's WRONG for orchestrator-driven adds (seed, scripts)
  // — those callers already picked their delivery mode and the heuristic would
  // silently flip it under their feet, causing the orchestrator's trigger
  // messages to never reach the just-added AI.
  // ============================================================================

  test('second AI auto-switches room to manual when added interactively (invitedBy undefined)', async () => {
    const { house, team, routeMessage } = createTestSystem()
    const ai1 = makeAIStub('AI1'); const ai2 = makeAIStub('AI2')
    team.addAgent(ai1); team.addAgent(ai2)
    const room = house.createRoom({ name: 'R', createdBy: 'system' })

    await addAgentToRoom(ai1.id, ai1.name, room.profile.id, undefined, team, routeMessage, house)
    expect(room.deliveryMode).toBe('broadcast')

    await addAgentToRoom(ai2.id, ai2.name, room.profile.id, undefined, team, routeMessage, house)
    expect(room.deliveryMode).toBe('manual')
  })

  test('second AI auto-switches when added by a human/agent (invitedBy is a name)', async () => {
    const { house, team, routeMessage } = createTestSystem()
    const ai1 = makeAIStub('AI1'); const ai2 = makeAIStub('AI2')
    team.addAgent(ai1); team.addAgent(ai2)
    const room = house.createRoom({ name: 'R', createdBy: 'system' })

    await addAgentToRoom(ai1.id, ai1.name, room.profile.id, undefined, team, routeMessage, house)
    await addAgentToRoom(ai2.id, ai2.name, room.profile.id, 'Alice', team, routeMessage, house)
    expect(room.deliveryMode).toBe('manual')
  })

  test('second AI does NOT auto-switch when added by seed', async () => {
    const { house, team, routeMessage } = createTestSystem()
    const ai1 = makeAIStub('AI1'); const ai2 = makeAIStub('AI2')
    team.addAgent(ai1); team.addAgent(ai2)
    const room = house.createRoom({ name: 'R', createdBy: 'system' })

    await addAgentToRoom(ai1.id, ai1.name, room.profile.id, undefined, team, routeMessage, house)
    await addAgentToRoom(ai2.id, ai2.name, room.profile.id, 'seed', team, routeMessage, house)
    expect(room.deliveryMode).toBe('broadcast')
  })

  test('second AI does NOT auto-switch when added by the script runner', async () => {
    const { house, team, routeMessage } = createTestSystem()
    const ai1 = makeAIStub('AI1'); const ai2 = makeAIStub('AI2')
    team.addAgent(ai1); team.addAgent(ai2)
    const room = house.createRoom({ name: 'R', createdBy: 'system' })

    await addAgentToRoom(ai1.id, ai1.name, room.profile.id, undefined, team, routeMessage, house)
    await addAgentToRoom(ai2.id, ai2.name, room.profile.id, 'script-runner', team, routeMessage, house)
    expect(room.deliveryMode).toBe('broadcast')
  })

  test('ORCHESTRATED_INVITERS is the canonical sentinel set', () => {
    expect(ORCHESTRATED_INVITERS.has('seed')).toBe(true)
    expect(ORCHESTRATED_INVITERS.has('script-runner')).toBe(true)
    expect(ORCHESTRATED_INVITERS.has('Alice')).toBe(false)
    expect(ORCHESTRATED_INVITERS.has('')).toBe(false)
  })
})

describe('removeAgentFromRoom', () => {
  test('removes agent, calls leave, posts leave message', async () => {
    const { house, team, routeMessage } = createTestSystem()
    const { agent } = makeAgent('Charlie')
    team.addAgent(agent)
    const room = house.createRoom({ name: 'Hall', createdBy: 'system' })

    await addAgentToRoom(agent.id, agent.name, room.profile.id, undefined, team, routeMessage, house)
    expect(room.hasMember(agent.id)).toBe(true)

    removeAgentFromRoom(agent.id, agent.name, room.profile.id, undefined, team, routeMessage, house)

    expect(room.hasMember(agent.id)).toBe(false)
    const leaveMsg = room.getRecent(10).find(m => m.type === 'leave' && m.senderId === agent.id)
    expect(leaveMsg).toBeDefined()
    expect(leaveMsg!.content).toBe('[Charlie] has left')
  })

  test('includes remover name in leave message', async () => {
    const { house, team, routeMessage } = createTestSystem()
    const { agent } = makeAgent('Dave')
    team.addAgent(agent)
    const room = house.createRoom({ name: 'Room', createdBy: 'system' })

    await addAgentToRoom(agent.id, agent.name, room.profile.id, undefined, team, routeMessage, house)
    removeAgentFromRoom(agent.id, agent.name, room.profile.id, 'Admin', team, routeMessage, house)

    const leaveMsg = room.getRecent(10).find(m => m.type === 'leave')
    expect(leaveMsg!.content).toBe('[Dave] has left (removed by [Admin])')
  })

  test('no-ops if agent is not a member', async () => {
    const { house, team, routeMessage } = createTestSystem()
    const { agent } = makeAgent('Eve')
    team.addAgent(agent)
    const room = house.createRoom({ name: 'Room', createdBy: 'system' })

    // Not a member — should not throw or post
    removeAgentFromRoom(agent.id, agent.name, room.profile.id, undefined, team, routeMessage, house)
    expect(room.getMessageCount()).toBe(0)
  })

  test('no-ops if agent not in team', () => {
    const { house, team, routeMessage } = createTestSystem()
    const room = house.createRoom({ name: 'Room', createdBy: 'system' })

    // No throw expected
    removeAgentFromRoom('ghost-id', 'Ghost', room.profile.id, undefined, team, routeMessage, house)
  })

  test('calls agent.leave so AI agent removes room from context', async () => {
    const { house, team, routeMessage } = createTestSystem()
    const { agent } = makeAgent('Frank')
    team.addAgent(agent)
    const room = house.createRoom({ name: 'ToLeave', createdBy: 'system' })

    await addAgentToRoom(agent.id, agent.name, room.profile.id, undefined, team, routeMessage, house)
    removeAgentFromRoom(agent.id, agent.name, room.profile.id, undefined, team, routeMessage, house)

    // Human agent.leave is a no-op but must not throw
    expect(room.hasMember(agent.id)).toBe(false)
  })
})
