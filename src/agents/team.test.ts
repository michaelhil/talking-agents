import { describe, test, expect } from 'bun:test'
import { createTeam } from './team.ts'
import type { Agent } from '../core/types.ts'

let counter = 0
const makeAgent = (overrides?: Partial<Agent>): Agent => ({
  id: `agent-${++counter}`,
  name: `Agent ${counter}`,
  description: 'A test agent',
  kind: 'ai',
  metadata: {},
  state: { get: () => 'idle' as const, subscribe: () => () => {} },
  getMessages: () => [],
  receive: () => {},
  join: async () => {},
  getRoomIds: () => [],
  getMessagesForRoom: () => [],
  getMessagesForPeer: () => [],
  ...overrides,
})

describe('Team — agent collection', () => {
  test('starts empty', () => {
    const team = createTeam()
    expect(team.listAgents()).toEqual([])
  })

  test('add and get', () => {
    const team = createTeam()
    const agent = makeAgent({ name: 'Unique1' })
    team.addAgent(agent)

    expect(team.getAgent(agent.id)).toBe(agent)
  })

  test('get returns undefined for unknown id', () => {
    const team = createTeam()
    expect(team.getAgent('nope')).toBeUndefined()
  })

  test('findByName returns agent (case-insensitive)', () => {
    const team = createTeam()
    const agent = makeAgent({ name: 'Analyst' })
    team.addAgent(agent)

    expect(team.getAgent('Analyst')).toBe(agent)
    expect(team.getAgent('analyst')).toBe(agent)
    expect(team.getAgent('ANALYST')).toBe(agent)
    expect(team.getAgent('nope')).toBeUndefined()
  })

  test('name uniqueness enforced (case-insensitive)', () => {
    const team = createTeam()
    team.addAgent(makeAgent({ name: 'Analyst' }))

    expect(() => {
      team.addAgent(makeAgent({ name: 'Analyst' }))
    }).toThrow('Agent name "Analyst" is already taken')

    expect(() => {
      team.addAgent(makeAgent({ name: 'analyst' }))
    }).toThrow('Agent name "analyst" is already taken')
  })

  test('remove deletes agent', () => {
    const team = createTeam()
    const agent = makeAgent({ name: 'RemoveMe' })
    team.addAgent(agent)

    expect(team.removeAgent(agent.id)).toBe(true)
    expect(team.getAgent(agent.id)).toBeUndefined()
    expect(team.listAgents()).toHaveLength(0)
  })

  test('remove returns false for unknown id', () => {
    const team = createTeam()
    expect(team.removeAgent('nope')).toBe(false)
  })

  test('removed name can be reused', () => {
    const team = createTeam()
    const agent1 = makeAgent({ name: 'Reusable' })
    team.addAgent(agent1)
    team.removeAgent(agent1.id)

    const agent2 = makeAgent({ name: 'Reusable' })
    team.addAgent(agent2) // should not throw
    expect(team.getAgent('Reusable')).toBe(agent2)
  })

  test('list returns all agents', () => {
    const team = createTeam()
    team.addAgent(makeAgent({ name: 'A' }))
    team.addAgent(makeAgent({ name: 'B' }))

    expect(team.listAgents()).toHaveLength(2)
  })

  test('listByKind filters correctly', () => {
    const team = createTeam()
    team.addAgent(makeAgent({ name: 'AI1', kind: 'ai' }))
    team.addAgent(makeAgent({ name: 'AI2', kind: 'ai' }))
    team.addAgent(makeAgent({ name: 'Human1', kind: 'human' }))

    expect(team.listByKind('ai')).toHaveLength(2)
    expect(team.listByKind('human')).toHaveLength(1)
  })
})
