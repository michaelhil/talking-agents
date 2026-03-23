// ============================================================================
// Team — Agent collection (AI + human).
// Simple Map. No delivery logic. No awareness of rooms or house.
// Names are unique (case-insensitive). addAgent() throws on collision.
// getAgent() accepts UUID or name (dual lookup).
// ============================================================================

import type { Agent, Team } from '../core/types.ts'
import { validateName } from '../core/names.ts'

export const createTeam = (): Team => {
  const agents = new Map<string, Agent>()

  const addAgent = (agent: Agent): void => {
    validateName(agent.name, 'Agent')
    const nameTaken = [...agents.values()].some(
      a => a.name.toLowerCase() === agent.name.toLowerCase(),
    )
    if (nameTaken) {
      throw new Error(`Agent name "${agent.name}" is already taken`)
    }
    agents.set(agent.id, agent)
  }

  const getAgent = (idOrName: string): Agent | undefined => {
    const byId = agents.get(idOrName)
    if (byId) return byId
    const lower = idOrName.toLowerCase()
    for (const agent of agents.values()) {
      if (agent.name.toLowerCase() === lower) return agent
    }
    return undefined
  }

  const removeAgent = (id: string): boolean => agents.delete(id)

  const listAgents = (): ReadonlyArray<Agent> => [...agents.values()]

  const listByKind = (kind: 'ai' | 'human'): ReadonlyArray<Agent> =>
    [...agents.values()].filter(a => a.kind === kind)

  return { addAgent, getAgent, removeAgent, listAgents, listByKind }
}
