// ============================================================================
// Stores — all UI state as nanostores atoms, maps, and computeds.
//
// Single source of truth for the entire UI. WS dispatch writes here;
// render subscriptions read from here. No mutable module-scope variables
// should exist outside this file.
// ============================================================================

import { atom, map, computed, batched } from '../lib/nanostores.ts'
import type { ReadableAtom, MapStore } from '../lib/nanostores.ts'
import type { UIMessage, AgentInfo, RoomProfile, ArtifactInfo } from './ui-renderer.ts'

// === Types ===

export type StateValue = 'idle' | 'generating'

export interface AgentEntry {
  readonly id: string
  readonly name: string
  readonly kind: 'ai' | 'human'
  readonly model?: string
  readonly state: StateValue
  readonly context?: string          // roomId the agent is generating in
}

// Re-export for convenience
export type { UIMessage, AgentInfo, RoomProfile, ArtifactInfo }

// === Identity ===

export const $myAgentId = atom<string | null>(null)
export const $myName = atom('')
export const $sessionToken = atom('')

// === Connection ===

export const $connected = atom(false)

// === Selection (mutual exclusion: room XOR agent) ===

export const $selectedRoomId = atom<string | null>(null)
export const $selectedAgentId = atom<string | null>(null)

// === Rooms ===

export const $rooms = map<Record<string, RoomProfile>>({})
export const $pausedRooms = atom<Set<string>>(new Set())
export const $unreadCounts = map<Record<string, number>>({})

/** Reverse lookup: room name → room ID.  Many WS events carry roomName. */
export const $roomIdByName: ReadableAtom<Record<string, string>> = computed(
  $rooms,
  (rooms: Record<string, RoomProfile>) => {
    const m: Record<string, string> = {}
    for (const [id, r] of Object.entries(rooms)) m[r.name] = id
    return m
  },
)

// === Agents ===

export const $agents = map<Record<string, AgentEntry>>({})

/** Reverse lookup: agent name → agent ID.  WS events use agentName. */
export const $agentIdByName: ReadableAtom<Record<string, string>> = computed(
  $agents,
  (agents: Record<string, AgentEntry>) => {
    const m: Record<string, string> = {}
    for (const [id, a] of Object.entries(agents)) m[a.name] = id
    return m
  },
)

// === Room membership ===

/** roomId → agentId[] */
export const $roomMembers = map<Record<string, string[]>>({})

// === Muted agents (for the currently selected room, keyed by agent ID) ===

export const $mutedAgents = atom<Set<string>>(new Set())

// === Derived: rooms that have at least one generating agent ===

/** Rooms where at least one agent is actively generating.
 *  Uses agent.context (the triggerRoomId) to determine WHICH room the agent
 *  is generating in — not just membership. An agent may be a member of
 *  multiple rooms but only generates in one at a time. */
export const $generatingRoomIds: ReadableAtom<Set<string>> = computed(
  [$agents],
  (agents: Record<string, AgentEntry>) => {
    const result = new Set<string>()
    for (const agent of Object.values(agents)) {
      if (agent.state === 'generating' && agent.context) {
        result.add(agent.context)
      }
    }
    return result
  },
)

// === Messages (per room, lazily populated on selection) ===

export const $roomMessages = map<Record<string, UIMessage[]>>({})

// === Artifacts ===

export const $artifacts = map<Record<string, ArtifactInfo>>({})

/** Artifacts scoped to the currently selected room. */
export const $selectedRoomArtifacts: ReadableAtom<ArtifactInfo[]> = computed(
  [$artifacts, $selectedRoomId],
  (artifacts: Record<string, ArtifactInfo>, roomId: string | null) => {
    if (!roomId) return []
    return Object.values(artifacts).filter(a => a.scope?.includes(roomId))
  },
)

// === Thinking state (streaming preview) ===

/** agentId → accumulated chunk text */
export const $thinkingPreviews = map<Record<string, string>>({})

/** agentId → tool status string ("web_search...", "web_search ✓") */
export const $thinkingTools = map<Record<string, string>>({})

// === Prompt context (for inspector) ===

export interface AgentContext {
  readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>
  readonly model: string
  readonly temperature?: number
  readonly toolCount: number
}

/** agentId → context snapshot from the current generation */
export const $agentContexts = map<Record<string, AgentContext>>({})

/** agentId → accumulated warnings from current generation */
export const $agentWarnings = map<Record<string, string[]>>({})

/** messageId → context snapshot (transferred from $agentContexts when message arrives) */
export const $messageContexts = map<Record<string, AgentContext>>({})

/** messageId → warnings (transferred from $agentWarnings when message arrives) */
export const $messageWarnings = map<Record<string, string[]>>({})


// === Delivery mode + room pause ===

export const $currentDeliveryMode = atom<string>('broadcast')
export const $roomPaused = atom(false)

// === Turn / flow info (ephemeral, set by WS events) ===

export interface TurnInfo {
  readonly roomName: string
  readonly agentName?: string
  readonly waitingForHuman?: boolean
}
export const $turnInfo = atom<TurnInfo | null>(null)

export interface FlowStatus {
  readonly roomName: string
  readonly event: string
  readonly detail?: Record<string, unknown>
}
export const $flowStatus = atom<FlowStatus | null>(null)

// === Pinned messages ===

export interface PinnedMessage {
  readonly senderId: string
  readonly content: string
  readonly senderName?: string
}
export const $pinnedMessages = map<Record<string, PinnedMessage>>({})

// === Ollama dashboard ===

export const $ollamaHealth = atom<Record<string, unknown> | null>(null)
export const $ollamaMetrics = atom<Record<string, unknown> | null>(null)

// === UI chrome ===

export const $sidebarCollapsed = atom(
  typeof localStorage !== 'undefined'
    ? localStorage.getItem('samsinn-sidebar-collapsed') === 'true'
    : false,
)

// === Lazy-loaded section counts ===

export const $toolsLoaded = atom(false)
export const $skillsLoaded = atom(false)
export const $toolCount = atom(0)
export const $skillCount = atom(0)

// === Batched view stores (combine multiple stores for render subscriptions) ===

/** Combined room view — triggers one render when any input changes. */
export const $roomListView = batched(
  [$rooms, $selectedRoomId, $pausedRooms, $unreadCounts, $generatingRoomIds],
  (
    rooms: Record<string, RoomProfile>,
    selectedRoomId: string | null,
    pausedRooms: Set<string>,
    unreadCounts: Record<string, number>,
    generatingRoomIds: Set<string>,
  ) => ({ rooms, selectedRoomId, pausedRooms, unreadCounts, generatingRoomIds }),
)

/** Combined agent list view — triggers one render when any input changes. */
export const $agentListView = batched(
  [$agents, $mutedAgents, $myAgentId, $selectedAgentId, $selectedRoomId, $roomMembers],
  (
    agents: Record<string, AgentEntry>,
    mutedAgents: Set<string>,
    myAgentId: string | null,
    selectedAgentId: string | null,
    selectedRoomId: string | null,
    roomMembers: Record<string, string[]>,
  ) => ({
    agents,
    mutedAgents,
    myAgentId,
    selectedAgentId,
    selectedRoomId,
    roomMemberIds: selectedRoomId ? (roomMembers[selectedRoomId] ?? []) : [],
  }),
)
