// ============================================================================
// Human Agent — Agent backed by a human via WebSocket (or other transport).
//
// Same Agent interface as AI agents. The difference:
// - receive() pushes message over transport instead of LLM evaluation
// - join() sends recent history over transport (no LLM summary)
//
// No message storage — Room is the source of truth for room messages.
// Room membership tracked by Room.hasMember (House.getRoomsForAgent for lookup).
// ID is auto-generated UUID, same as AI agents.
// ============================================================================

import type { Agent, AgentState, Message, Room } from '../core/types.ts'
import { DEFAULTS } from '../core/types.ts'

export interface HumanAgentConfig {
  readonly name: string
  readonly description: string
  readonly metadata?: Record<string, unknown>
}

export type TransportSend = (message: Message) => void

export interface HumanAgent extends Agent {
  readonly setTransport: (newSend: TransportSend) => void
}

export const createHumanAgent = (
  config: HumanAgentConfig,
  initialSend: TransportSend,
): HumanAgent => {
  const agentId = crypto.randomUUID()
  let send = initialSend
  const historyLimit = DEFAULTS.historyLimit

  // Human agents are always 'idle' — state changes come from UI interaction, not LLM
  const state: AgentState = {
    get: () => 'idle',
    subscribe: () => () => {},
  }

  const receive = (message: Message, _history?: ReadonlyArray<Message>): void => {
    // Don't echo own messages back over transport
    if (message.senderId === agentId) return

    try {
      send(message)
    } catch (err) {
      console.error(`[${config.name}] Transport send failed:`, err)
    }
  }

  const join = async (room: Room): Promise<void> => {
    const recent = room.getRecent(historyLimit)
    for (const msg of recent) {
      try {
        send(msg)
      } catch (err) {
        console.error(`[${config.name}] Failed to send history for ${room.profile.name}:`, err)
        break
      }
    }
  }

  return {
    id: agentId,
    name: config.name,
    description: config.description,
    kind: 'human',
    metadata: config.metadata ?? {},
    state,
    receive,
    join,
    setTransport: (newSend: TransportSend) => { send = newSend },
  }
}
