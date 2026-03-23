import { describe, test, expect } from 'bun:test'
import { createHouse } from '../core/house.ts'
import { createPostAndDeliver } from '../core/delivery.ts'
import { createTeam } from './team.ts'
import { createHumanAgent } from './human-agent.ts'
import { executeActions } from './actions.ts'
import type { AgentAction, Message } from '../core/types.ts'
import { SYSTEM_SENDER_ID } from '../core/types.ts'

const createTestSystem = () => {
  const house = createHouse()
  const team = createTeam()
  const postAndDeliver = createPostAndDeliver(house, team)
  return { house, team, postAndDeliver }
}

const makeAgent = (name: string) => {
  const inbox: Message[] = []
  const agent = createHumanAgent({ name, description: `Test ${name}` }, (msg) => inbox.push(msg))
  return { agent, inbox }
}

describe('executeActions — create_room', () => {
  test('creates a public room and adds creator', async () => {
    const { house, team, postAndDeliver } = createTestSystem()
    const { agent } = makeAgent('Creator')
    team.add(agent)

    await executeActions(
      [{ type: 'create_room', name: 'New Room', visibility: 'public' }],
      agent.id, agent.name, house, team, postAndDeliver,
    )

    const room = house.findByName('New Room')
    expect(room).toBeDefined()
    expect(room!.profile.visibility).toBe('public')
    expect(room!.hasMember(agent.id)).toBe(true)
  })

  test('auto-renames on collision and notifies agent', async () => {
    const { house, team, postAndDeliver } = createTestSystem()
    const { agent } = makeAgent('Creator')
    team.add(agent)

    house.createRoom({ name: 'Planning', visibility: 'public', createdBy: 'test' })

    await executeActions(
      [{ type: 'create_room', name: 'Planning', visibility: 'public' }],
      agent.id, agent.name, house, team, postAndDeliver,
    )

    expect(house.findByName('Planning-2')).toBeDefined()

    const systemMsg = agent.getMessages().find(
      m => m.senderId === SYSTEM_SENDER_ID && m.content.includes('Planning-2'),
    )
    expect(systemMsg).toBeDefined()
  })

  test('adds invited agents to room', async () => {
    const { house, team, postAndDeliver } = createTestSystem()
    const { agent: creator } = makeAgent('Creator')
    const { agent: invitee } = makeAgent('Invitee')
    team.add(creator)
    team.add(invitee)

    await executeActions(
      [{ type: 'create_room', name: 'Private Room', visibility: 'private', add: ['Invitee'] }],
      creator.id, creator.name, house, team, postAndDeliver,
    )

    const room = house.findByName('Private Room')
    expect(room).toBeDefined()
    expect(room!.hasMember(creator.id)).toBe(true)
    expect(room!.hasMember(invitee.id)).toBe(true)

    const joinMsg = room!.getRecent(10).find(m => m.content.includes('[Invitee] has joined'))
    expect(joinMsg).toBeDefined()
  })

  test('handles nonexistent invite name gracefully', async () => {
    const { house, team, postAndDeliver } = createTestSystem()
    const { agent } = makeAgent('Creator')
    team.add(agent)

    await executeActions(
      [{ type: 'create_room', name: 'WithGhost', visibility: 'public', add: ['Ghost'] }],
      agent.id, agent.name, house, team, postAndDeliver,
    )

    // Room created, ghost silently skipped
    expect(house.findByName('WithGhost')).toBeDefined()
  })
})

describe('executeActions — add_to_room', () => {
  test('agent adds itself to a public room (= join)', async () => {
    const { house, team, postAndDeliver } = createTestSystem()
    const { agent } = makeAgent('Joiner')
    team.add(agent)

    house.createRoom({ name: 'Open Room', visibility: 'public', createdBy: 'test' })

    await executeActions(
      [{ type: 'add_to_room', roomName: 'Open Room', agentName: 'Joiner' }],
      agent.id, agent.name, house, team, postAndDeliver,
    )

    const room = house.findByName('Open Room')
    expect(room!.hasMember(agent.id)).toBe(true)
    expect(room!.getParticipantIds()).toContain(agent.id)
  })

  test('member adds another agent to a room (= invite)', async () => {
    const { house, team, postAndDeliver } = createTestSystem()
    const { agent: host } = makeAgent('Host')
    const { agent: guest } = makeAgent('Guest')
    team.add(host)
    team.add(guest)

    const room = house.createRoom({ name: 'Club', visibility: 'private', createdBy: 'test' })
    room.addMember(host.id)
    room.post({ senderId: host.id, content: 'Welcome', type: 'chat' })

    await executeActions(
      [{ type: 'add_to_room', roomName: 'Club', agentName: 'Guest' }],
      host.id, host.name, house, team, postAndDeliver,
    )

    expect(room.hasMember(guest.id)).toBe(true)
    const joinMsg = room.getRecent(10).find(m => m.content.includes('[Guest] has joined (added by [Host])'))
    expect(joinMsg).toBeDefined()
  })

  test('rejects non-member adding to private room', async () => {
    const { house, team, postAndDeliver } = createTestSystem()
    const { agent: outsider } = makeAgent('Outsider')
    const { agent: target } = makeAgent('Target')
    team.add(outsider)
    team.add(target)

    house.createRoom({ name: 'Secret', visibility: 'private', createdBy: 'test' })

    await executeActions(
      [{ type: 'add_to_room', roomName: 'Secret', agentName: 'Target' }],
      outsider.id, outsider.name, house, team, postAndDeliver,
    )

    const room = house.findByName('Secret')
    expect(room!.hasMember(target.id)).toBe(false)
  })

  test('allows invited member to add themselves to private room', async () => {
    const { house, team, postAndDeliver } = createTestSystem()
    const { agent } = makeAgent('Invited')
    team.add(agent)

    const room = house.createRoom({ name: 'Private', visibility: 'private', createdBy: 'test' })
    room.addMember(agent.id)

    await executeActions(
      [{ type: 'add_to_room', roomName: 'Private', agentName: 'Invited' }],
      agent.id, agent.name, house, team, postAndDeliver,
    )

    expect(room.getParticipantIds()).toContain(agent.id)
  })

  test('handles nonexistent room gracefully', async () => {
    const { house, team, postAndDeliver } = createTestSystem()
    const { agent } = makeAgent('Confused')
    team.add(agent)

    await executeActions(
      [{ type: 'add_to_room', roomName: 'Nonexistent', agentName: 'Confused' }],
      agent.id, agent.name, house, team, postAndDeliver,
    )
    // Should not throw
  })

  test('handles nonexistent agent gracefully', async () => {
    const { house, team, postAndDeliver } = createTestSystem()
    const { agent } = makeAgent('Inviter')
    team.add(agent)

    const room = house.createRoom({ name: 'MyRoom', visibility: 'public', createdBy: 'test' })
    room.addMember(agent.id)

    await executeActions(
      [{ type: 'add_to_room', roomName: 'MyRoom', agentName: 'Ghost' }],
      agent.id, agent.name, house, team, postAndDeliver,
    )
    // Should not throw
  })
})

describe('executeActions — limits', () => {
  test('actions limited to maxAgentActionsPerResponse', async () => {
    const { house, team, postAndDeliver } = createTestSystem()
    const { agent } = makeAgent('Spammer')
    team.add(agent)

    const actions: AgentAction[] = Array.from({ length: 10 }, (_, i) => ({
      type: 'create_room' as const,
      name: `Spam Room ${i}`,
      visibility: 'public' as const,
    }))

    await executeActions(actions, agent.id, agent.name, house, team, postAndDeliver)

    expect(house.listAllRooms()).toHaveLength(5)
  })
})
