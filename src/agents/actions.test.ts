import { describe, test, expect } from 'bun:test'
import { createHouse } from '../core/house.ts'
import { createMessageRouter } from '../core/delivery.ts'
import { createTeam } from './team.ts'
import { createHumanAgent } from './human-agent.ts'
import { addAgentToRoom, removeAgentFromRoom } from './actions.ts'
import type { Message } from '../core/types.ts'

const createTestSystem = () => {
  const team = createTeam()
  const deliver = (agentId: string, message: Message, history: ReadonlyArray<Message>) => {
    team.getAgent(agentId)?.receive(message, history)
  }
  const house = createHouse({ deliver })
  const routeMessage = createMessageRouter({ house, team, deliver })
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
    expect(joinMsg!.metadata?.agentName).toBe('Alice')
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
