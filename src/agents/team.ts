// ============================================================================
// Team — Agent collection (AI + human).
// Simple Map. No delivery logic. No awareness of rooms or house.
// Names are unique (case-insensitive). add() throws on collision.
// ============================================================================

import type { Agent, Team } from '../core/types.ts'
import { validateName } from '../core/names.ts'

export const createTeam = (): Team => {
  const agents = new Map<string, Agent>()

  const add = (agent: Agent): void => {
    validateName(agent.name, 'Agent')
    const nameTaken = [...agents.values()].some(
      a => a.name.toLowerCase() === agent.name.toLowerCase(),
    )
    if (nameTaken) {
      throw new Error(`Agent name "${agent.name}" is already taken`)
    }
    agents.set(agent.id, agent)
  }

  const get = (id: string): Agent | undefined => agents.get(id)

  const findByName = (name: string): Agent | undefined => {
    const lower = name.toLowerCase()
    for (const agent of agents.values()) {
      if (agent.name.toLowerCase() === lower) return agent
    }
    return undefined
  }

  const remove = (id: string): boolean => agents.delete(id)

  const list = (): ReadonlyArray<Agent> => [...agents.values()]

  const listByKind = (kind: 'ai' | 'human'): ReadonlyArray<Agent> =>
    [...agents.values()].filter(a => a.kind === kind)

  return { add, get, findByName, remove, list, listByKind }
}
