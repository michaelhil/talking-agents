// ============================================================================
// Spawn — Wiring functions that create agents and connect them to the system.
// Creates agent → adds to team → joins rooms → posts join messages.
// Wires the onDecision callback to bridge agent decisions to postAndDeliver.
//
// resolveTarget translates LLM names → internal UUIDs using findByName.
// ============================================================================

import type {
  Agent,
  AIAgent,
  AIAgentConfig,
  House,
  LLMProvider,
  MessageTarget,
  PostAndDeliver,
  Room,
  Team,
} from '../core/types.ts'
import { createAIAgent } from './ai-agent.ts'
import type { Decision } from './ai-agent.ts'
import { executeActions } from './actions.ts'
import { makeJoinMetadata } from './shared.ts'

export const spawnAIAgent = async (
  config: AIAgentConfig,
  llmProvider: LLMProvider,
  house: House,
  team: Team,
  postAndDeliver: PostAndDeliver,
): Promise<AIAgent> => {

  // Resolve LLM names to internal UUIDs via findByName.
  const resolveTarget = (decision: Decision): MessageTarget => {
    if (decision.response.action !== 'respond') return {}

    const target = decision.response.target
    if (target && ((target.rooms && target.rooms.length > 0) || (target.agents && target.agents.length > 0))) {
      const resolvedRooms = target.rooms
        ?.map(name => house.findByName(name)?.profile.id)
        .filter((id): id is string => id !== undefined)

      const resolvedAgents = target.agents
        ?.map(name => team.findByName(name)?.id)
        .filter((id): id is string => id !== undefined)

      return { rooms: resolvedRooms, agents: resolvedAgents }
    }

    // Fallback: respond where the trigger came from
    if (decision.triggerRoomId) return { rooms: [decision.triggerRoomId] }
    if (decision.triggerPeerId) return { agents: [decision.triggerPeerId] }
    return {}
  }

  const onDecision = (decision: Decision): void => {
    if (decision.response.action === 'respond') {
      const target = resolveTarget(decision)
      postAndDeliver(target, {
        senderId: agent.id,
        content: decision.response.content,
        type: 'chat',
        generationMs: decision.generationMs,
      })
    }

    const actions = decision.response.actions
    if (actions && actions.length > 0) {
      executeActions(actions, agent.id, agent.name, house, team, postAndDeliver)
        .catch(err => console.error(`[${config.name}] Action execution failed:`, err))
    }
  }

  const agent = createAIAgent(config, llmProvider, onDecision)
  team.add(agent)

  const publicRooms = house.listPublicRooms()
  for (const roomProfile of publicRooms) {
    const room = house.getRoom(roomProfile.id)
    if (!room) continue

    room.addMember(agent.id)
    await agent.join(room)

    postAndDeliver(
      { rooms: [room.profile.id] },
      { senderId: agent.id, content: `[${agent.name}] has joined`, type: 'join', metadata: makeJoinMetadata(agent) },
    )
  }

  return agent
}

export const spawnHumanAgent = async (
  agent: Agent,
  house: House,
  team: Team,
  postAndDeliver: PostAndDeliver,
  roomsToJoin?: ReadonlyArray<Room>,
): Promise<Agent> => {
  team.add(agent)

  const rooms = roomsToJoin ?? house.listPublicRooms().map(
    profile => house.getRoom(profile.id),
  ).filter((r): r is Room => r !== undefined)

  for (const room of rooms) {
    room.addMember(agent.id)
    await agent.join(room)
    postAndDeliver(
      { rooms: [room.profile.id] },
      { senderId: agent.id, content: `[${agent.name}] has joined`, type: 'join', metadata: makeJoinMetadata(agent) },
    )
  }

  return agent
}
