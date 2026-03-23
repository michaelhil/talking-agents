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
    expect(team.list()).toEqual([])
  })

  test('add and get', () => {
    const team = createTeam()
    const agent = makeAgent({ name: 'Unique1' })
    team.add(agent)

    expect(team.get(agent.id)).toBe(agent)
  })

  test('get returns undefined for unknown id', () => {
    const team = createTeam()
    expect(team.get('nope')).toBeUndefined()
  })

  test('findByName returns agent (case-insensitive)', () => {
    const team = createTeam()
    const agent = makeAgent({ name: 'Analyst' })
    team.add(agent)

    expect(team.findByName('Analyst')).toBe(agent)
    expect(team.findByName('analyst')).toBe(agent)
    expect(team.findByName('ANALYST')).toBe(agent)
    expect(team.findByName('nope')).toBeUndefined()
  })

  test('name uniqueness enforced (case-insensitive)', () => {
    const team = createTeam()
    team.add(makeAgent({ name: 'Analyst' }))

    expect(() => {
      team.add(makeAgent({ name: 'Analyst' }))
    }).toThrow('Agent name "Analyst" is already taken')

    expect(() => {
      team.add(makeAgent({ name: 'analyst' }))
    }).toThrow('Agent name "analyst" is already taken')
  })

  test('remove deletes agent', () => {
    const team = createTeam()
    const agent = makeAgent({ name: 'RemoveMe' })
    team.add(agent)

    expect(team.remove(agent.id)).toBe(true)
    expect(team.get(agent.id)).toBeUndefined()
    expect(team.list()).toHaveLength(0)
  })

  test('remove returns false for unknown id', () => {
    const team = createTeam()
    expect(team.remove('nope')).toBe(false)
  })

  test('removed name can be reused', () => {
    const team = createTeam()
    const agent1 = makeAgent({ name: 'Reusable' })
    team.add(agent1)
    team.remove(agent1.id)

    const agent2 = makeAgent({ name: 'Reusable' })
    team.add(agent2) // should not throw
    expect(team.findByName('Reusable')).toBe(agent2)
  })

  test('list returns all agents', () => {
    const team = createTeam()
    team.add(makeAgent({ name: 'A' }))
    team.add(makeAgent({ name: 'B' }))

    expect(team.list()).toHaveLength(2)
  })

  test('listByKind filters correctly', () => {
    const team = createTeam()
    team.add(makeAgent({ name: 'AI1', kind: 'ai' }))
    team.add(makeAgent({ name: 'AI2', kind: 'ai' }))
    team.add(makeAgent({ name: 'Human1', kind: 'human' }))

    expect(team.listByKind('ai')).toHaveLength(2)
    expect(team.listByKind('human')).toHaveLength(1)
  })
})
