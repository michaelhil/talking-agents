import { describe, test, expect } from 'bun:test'
import { createTeam } from './team.ts'
import type { Agent } from '../core/types.ts'

const makeAgent = (overrides?: Partial<Agent>): Agent => ({
  id: 'agent-1',
  name: 'Test Agent',
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
    const agent = makeAgent()
    team.add(agent)

    expect(team.get('agent-1')).toBe(agent)
  })

  test('get returns undefined for unknown id', () => {
    const team = createTeam()
    expect(team.get('nope')).toBeUndefined()
  })

  test('remove deletes agent', () => {
    const team = createTeam()
    team.add(makeAgent())

    expect(team.remove('agent-1')).toBe(true)
    expect(team.get('agent-1')).toBeUndefined()
    expect(team.list()).toHaveLength(0)
  })

  test('remove returns false for unknown id', () => {
    const team = createTeam()
    expect(team.remove('nope')).toBe(false)
  })

  test('list returns all agents', () => {
    const team = createTeam()
    team.add(makeAgent({ id: 'a1', name: 'A' }))
    team.add(makeAgent({ id: 'a2', name: 'B' }))

    expect(team.list()).toHaveLength(2)
  })

  test('listByKind filters correctly', () => {
    const team = createTeam()
    team.add(makeAgent({ id: 'ai-1', kind: 'ai' }))
    team.add(makeAgent({ id: 'ai-2', kind: 'ai' }))
    team.add(makeAgent({ id: 'h-1', kind: 'human' }))

    expect(team.listByKind('ai')).toHaveLength(2)
    expect(team.listByKind('human')).toHaveLength(1)
  })

  test('replacing agent with same id overwrites', () => {
    const team = createTeam()
    team.add(makeAgent({ id: 'a1', name: 'Original' }))
    team.add(makeAgent({ id: 'a1', name: 'Replacement' }))

    expect(team.get('a1')!.name).toBe('Replacement')
    expect(team.list()).toHaveLength(1)
  })
})
