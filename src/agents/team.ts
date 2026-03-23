// ============================================================================
// Team — Agent collection (AI + human).
// Simple Map. No delivery logic. No awareness of rooms or house.
// ============================================================================

import type { Agent, Team } from '../core/types.ts'

export const createTeam = (): Team => {
  const agents = new Map<string, Agent>()

  const add = (agent: Agent): void => {
    agents.set(agent.id, agent)
  }

  const get = (id: string): Agent | undefined => agents.get(id)

  const remove = (id: string): boolean => agents.delete(id)

  const list = (): ReadonlyArray<Agent> => [...agents.values()]

  const listByKind = (kind: 'ai' | 'human'): ReadonlyArray<Agent> =>
    [...agents.values()].filter(a => a.kind === kind)

  return { add, get, remove, list, listByKind }
}
