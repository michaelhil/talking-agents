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

import type { Agent, AgentState } from '../core/types/agent.ts'
import type { Message } from '../core/types/messaging.ts'
import type { Room } from '../core/types/room.ts'
import { DEFAULTS } from '../core/types/constants.ts'

export interface HumanAgentConfig {
  readonly name: string
  readonly description?: string
  readonly metadata?: Record<string, unknown>
}

export type TransportSend = (message: Message) => void

export interface HumanAgent extends Agent {
  readonly setTransport: (newSend: TransportSend) => void
}

export const createHumanAgent = (
  config: HumanAgentConfig,
  initialSend: TransportSend,
  overrideId?: string,
): HumanAgent => {
  const agentId = overrideId ?? crypto.randomUUID()
  let send = initialSend
  let isInactive = false
  let description = config.description ?? ''
  const historyLimit = DEFAULTS.historyLimit

  // Human agents are always 'idle' — state changes come from UI interaction, not LLM
  const state: AgentState = {
    get: () => 'idle',
    getContext: () => undefined,
    subscribe: () => () => {},
  }

  const receive = (message: Message): void => {
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

  const seededTags = (config.metadata?.tags as ReadonlyArray<string> | undefined) ?? []
  let currentTags: ReadonlyArray<string> = seededTags
  const liveMetadata: Record<string, unknown> = { ...(config.metadata ?? {}), tags: currentTags }

  return {
    id: agentId,
    name: config.name,
    kind: 'human',
    metadata: liveMetadata,
    state,
    receive,
    join,
    leave: (_roomId: string): void => { /* no internal room state to clean up */ },
    setTransport: (newSend: TransportSend) => { send = newSend },
    get inactive() { return isInactive },
    setInactive: (value: boolean) => { isInactive = value },
    getDescription: () => description,
    updateDescription: (desc: string) => { description = desc },
    getTags: () => currentTags,
    updateTags: (tags: ReadonlyArray<string>) => {
      currentTags = tags
      liveMetadata.tags = tags
    },
  }
}
