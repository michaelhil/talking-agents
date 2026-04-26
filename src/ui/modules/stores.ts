// ============================================================================
// Stores — all UI state as nanostores atoms, maps, and computeds.
//
// Single source of truth for the entire UI. WS dispatch writes here;
// render subscriptions read from here. No mutable module-scope variables
// should exist outside this file.
// ============================================================================

import { atom, map, computed, batched } from '../lib/nanostores.ts'
import type { ReadableAtom, MapStore } from '../lib/nanostores.ts'
import type { UIMessage, AgentInfo, RoomProfile, ArtifactInfo } from './render-types.ts'

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
export const $sessionToken = atom(
  typeof localStorage !== 'undefined' ? localStorage.getItem('ta_session') ?? '' : '',
)

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

// === Turn info (ephemeral, set by WS events) ===

export interface TurnInfo {
  readonly roomName: string
  readonly agentName?: string
  readonly waitingForHuman?: boolean
}
export const $turnInfo = atom<TurnInfo | null>(null)

// === Scripts ===

export interface ScriptCatalogEntry {
  readonly id: string
  readonly name: string
  readonly title: string
  readonly prompt?: string
  readonly cast: ReadonlyArray<{ name: string; model: string; starts: boolean }>
  readonly steps: number
}
export const $scriptCatalog = atom<ReadonlyArray<ScriptCatalogEntry>>([])

export interface ActiveScript {
  readonly scriptId: string
  readonly scriptName: string
  readonly title: string
  readonly stepIndex: number
  readonly totalSteps: number
  readonly stepTitle: string
  readonly readiness: Readonly<Record<string, boolean>>
  readonly whisperFailures: number
}
// Keyed by roomId.
export const $activeScriptByRoom = map<Record<string, ActiveScript>>({})

// === Ollama dashboard ===

export const $ollamaHealth = atom<Record<string, unknown> | null>(null)
export const $ollamaMetrics = atom<Record<string, unknown> | null>(null)

// === Provider routing ===
// The most recent provider routing event (bound / all_failed / stream_failed).
// Consumers (e.g. agent-inspector) subscribe and filter by agentId to react to
// verification outcomes for their pending model changes.

export type ProviderUIEvent =
  | { readonly type: 'provider_bound'; readonly agentId: string | null; readonly agentName: string | null; readonly model: string; readonly oldProvider: string | null; readonly newProvider: string; readonly at: number }
  | { readonly type: 'provider_all_failed'; readonly agentId: string | null; readonly agentName: string | null; readonly model: string; readonly attempts: ReadonlyArray<{ readonly provider: string; readonly reason: string }>; readonly at: number }
  | { readonly type: 'provider_stream_failed'; readonly agentId: string | null; readonly agentName: string | null; readonly model: string; readonly provider: string; readonly reason: string; readonly at: number }

export const $lastProviderEvent = atom<ProviderUIEvent | null>(null)

// Pending user-initiated model changes keyed by agentId. Agent-inspector sets
// { model, at } on save; cleared when a matching provider event arrives or
// after a 30s verification timeout.
export interface PendingModelChange {
  readonly model: string
  readonly at: number
}
export const $pendingModelChanges = map<Record<string, PendingModelChange>>({})

// === UI chrome ===

// Sidebar width in pixels. 0 = collapsed. Persisted to localStorage by the
// resize handler; stored here so any subscriber (e.g. layout measurements)
// can react. Read at boot from localStorage.
const readSidebarWidth = (): number => {
  if (typeof localStorage === 'undefined') return 160
  const raw = localStorage.getItem('samsinn-sidebar-width')
  if (raw === null) return 160
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 160
}
export const $sidebarWidth = atom<number>(readSidebarWidth())

// Tools/skills sidebar atoms moved to sidebar.ts (not shared).

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
  [$agents, $mutedAgents, $myAgentId, $selectedAgentId, $selectedRoomId, $roomMembers, $currentDeliveryMode],
  (
    agents: Record<string, AgentEntry>,
    mutedAgents: Set<string>,
    myAgentId: string | null,
    selectedAgentId: string | null,
    selectedRoomId: string | null,
    roomMembers: Record<string, string[]>,
    deliveryMode: string,
  ) => ({
    agents,
    mutedAgents,
    myAgentId,
    selectedAgentId,
    selectedRoomId,
    roomMemberIds: selectedRoomId ? (roomMembers[selectedRoomId] ?? []) : [],
    deliveryMode,
  }),
)
