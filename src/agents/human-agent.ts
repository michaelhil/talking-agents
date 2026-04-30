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
import type { Trigger } from '../core/triggers/types.ts'
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
  let currentName = config.name
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

  let triggers: ReadonlyArray<Trigger> = []

  return {
    id: agentId,
    get name() { return currentName },
    kind: 'human',
    metadata: liveMetadata,
    state,
    receive,
    join,
    leave: (_roomId: string): void => { /* no internal room state to clean up */ },
    setTransport: (newSend: TransportSend) => { send = newSend },
    get inactive() { return isInactive },
    setInactive: (value: boolean) => { isInactive = value },
    setName: (newName: string) => { currentName = newName },
    getDescription: () => description,
    updateDescription: (desc: string) => { description = desc },
    getTags: () => currentTags,
    updateTags: (tags: ReadonlyArray<string>) => {
      currentTags = tags
      liveMetadata.tags = tags
    },
    getTriggers: () => triggers,
    addTrigger: (t: Trigger) => { triggers = [...triggers, t] },
    updateTrigger: (id: string, patch: Partial<Trigger>): boolean => {
      const idx = triggers.findIndex(x => x.id === id)
      if (idx < 0) return false
      const next = [...triggers]
      next[idx] = { ...next[idx]!, ...patch, id } as Trigger
      triggers = next
      return true
    },
    deleteTrigger: (id: string): boolean => {
      const before = triggers.length
      triggers = triggers.filter(x => x.id !== id)
      return triggers.length < before
    },
    markTriggerFired: (id: string, when: number): void => {
      const idx = triggers.findIndex(x => x.id === id)
      if (idx < 0) return
      const next = [...triggers]
      next[idx] = { ...next[idx]!, lastFiredAt: when } as Trigger
      triggers = next
    },
  }
}
