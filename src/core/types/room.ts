// Room + House — message delivery, membership, mode, and system-level
// collection. House also owns the artifact store and system-level LLM access.

import type {
  Message,
  RoomProfile,
  PostParams,
  DeliverFn,
  DeliveryMode,
  ResolveAgentName,
  ResolveTagFn,
} from './messaging.ts'
import type { ArtifactStore, ArtifactTypeRegistry, OnArtifactChanged } from './artifact.ts'
import type { LLMCallOptions } from './llm.ts'
import type { SummaryConfig } from './summary.ts'

// === Room event callbacks ===

export type OnMessagePosted = (roomId: string, message: Message) => void
export type OnDeliveryModeChanged = (roomId: string, mode: DeliveryMode) => void
export type OnTurnChanged = (roomId: string, agentId?: string, waitingForHuman?: boolean) => void
export type OnRoomCreated = (profile: RoomProfile) => void
export type OnRoomDeleted = (roomId: string, roomName: string) => void
export type OnMembershipChanged = (roomId: string, roomName: string, agentId: string, agentName: string, action: 'added' | 'removed') => void
export type OnBookmarksChanged = () => void
// Fired by the API/MCP layer after agent settings (persona, model, tools,
// triggers, name, etc.) are mutated. Bookmarks-style: argless, "something
// changed". Wire-system-events triggers a snapshot save so config edits
// don't sit in memory until the next message-post.
export type OnAgentSettingsChanged = () => void
// Fired when a room auto-switches Broadcast → Manual on the second AI join.
// UI toasts a one-off hint so the user can flip back to Broadcast if desired.
export type OnModeAutoSwitched = (roomId: string, toMode: DeliveryMode, reason: 'second-ai-joined') => void
// Fired when a room's summary config changes.
export type OnSummaryConfigChanged = (roomId: string, config: SummaryConfig) => void
// Fired when a summary or compression output is persisted to the room.
export type SummaryTarget = 'summary' | 'compression'
export type OnSummaryUpdated = (roomId: string, target: SummaryTarget) => void

// === Bookmarks — system-wide message snippets (Phase 1) ===

export interface Bookmark {
  readonly id: string
  readonly content: string
}

// === Room state snapshot (for UI sync on connect/reconnect) ===

export interface RoomState {
  readonly mode: DeliveryMode
  readonly paused: boolean
  readonly muted: ReadonlyArray<string>
  readonly members: ReadonlyArray<string>
  readonly summaryConfig?: SummaryConfig
  readonly latestSummary?: string
  readonly wikiBindings?: ReadonlyArray<string>
}

// === Room — self-contained component: stores messages and delivers to members ===

export interface Room {
  readonly profile: RoomProfile
  readonly post: (params: PostParams) => Message
  readonly getRecent: (n: number) => ReadonlyArray<Message>
  readonly getParticipantIds: () => ReadonlyArray<string>
  readonly addMember: (id: string) => void
  readonly removeMember: (id: string) => void
  readonly hasMember: (id: string) => boolean
  readonly getMessageCount: () => number
  readonly setRoomPrompt: (prompt: string) => void
  readonly deleteMessage: (messageId: string) => boolean
  readonly clearMessages: () => void

  // Delivery mode
  readonly deliveryMode: DeliveryMode
  readonly setDeliveryMode: (mode: DeliveryMode) => void
  // System-initiated auto-switch to manual (fires onModeAutoSwitched in addition
  // to the usual onDeliveryModeChanged + onManualModeEntered). No-op if already manual.
  readonly autoSwitchToManual: (reason: 'second-ai-joined') => void

  // Pause — room-level, prevents all delivery (join/leave and addressing still work)
  readonly paused: boolean
  readonly setPaused: (paused: boolean) => void

  // Room state snapshot (for UI sync)
  readonly getRoomState: () => RoomState

  // Muting — user-controlled, persistent, mode-independent
  readonly setMuted: (agentId: string, muted: boolean) => void
  readonly isMuted: (agentId: string) => boolean
  readonly getMutedIds: () => ReadonlySet<string>

  // Compression tracking — IDs of messages subsumed by the single evolving
  // `room_summary` message at the top of the stream. Populated only by
  // replaceCompression(); no cap-based pruning.
  readonly getCompressedIds: () => ReadonlySet<string>

  // Summary & compression state (per-room feature).
  readonly summaryConfig: SummaryConfig
  readonly setSummaryConfig: (config: SummaryConfig) => void
  readonly getLatestSummary: () => string | undefined
  readonly setLatestSummary: (text: string) => void
  // Replace the single evolving compression at the top of the stream.
  // Removes the prior `room_summary` message (if any), flags oldestIds as
  // compressed (tombstones), and inserts a fresh `room_summary` at position 0.
  // Returns the inserted message.
  readonly replaceCompression: (oldestIds: ReadonlyArray<string>, newText: string) => Message
  // Current `room_summary` at top of stream, if any.
  readonly getCurrentCompressionMessage: () => Message | undefined

  // Wiki bindings — wikis bound to this room. Effective bindings for an
  // agent in this room = room.wikiBindings ∪ agent.wikiBindings.
  readonly getWikiBindings: () => ReadonlyArray<string>
  readonly setWikiBindings: (wikiIds: ReadonlyArray<string>) => void

  // Snapshot restore — bypass delivery, populate state directly
  readonly injectMessages: (msgs: ReadonlyArray<Message>) => void
  readonly restoreState: (state: RoomRestoreParams) => void
}

export interface RoomRestoreParams {
  readonly members: ReadonlyArray<string>
  readonly muted: ReadonlyArray<string>
  readonly mode: DeliveryMode
  readonly paused: boolean
  readonly compressedIds?: ReadonlyArray<string>
  readonly summaryConfig?: SummaryConfig
  readonly latestSummary?: string
  readonly wikiBindings?: ReadonlyArray<string>
}

// === CreateResult — returned when name uniqueness is enforced ===

export interface CreateResult<T> {
  readonly value: T
  readonly requestedName: string
  readonly assignedName: string
}

// === HouseCallbacks — configuration object for createHouse ===

export interface HouseCallbacks {
  readonly deliver?: DeliverFn
  readonly resolveAgentName?: ResolveAgentName
  readonly resolveTag?: ResolveTagFn
  readonly resolveKind?: (id: string) => 'ai' | 'human' | undefined
  readonly onMessagePosted?: OnMessagePosted
  readonly onTurnChanged?: OnTurnChanged
  readonly onDeliveryModeChanged?: OnDeliveryModeChanged
  readonly onArtifactChanged?: OnArtifactChanged
  readonly onRoomCreated?: OnRoomCreated
  readonly onRoomDeleted?: OnRoomDeleted
  readonly onBookmarksChanged?: OnBookmarksChanged
  readonly onManualModeEntered?: (roomId: string) => void
  readonly onModeAutoSwitched?: OnModeAutoSwitched
  readonly onSummaryConfigChanged?: OnSummaryConfigChanged
  readonly onSummaryUpdated?: OnSummaryUpdated
  readonly callSystemLLM?: (options: LLMCallOptions) => Promise<string>
}

// === House — room collection + artifact system ===

export interface House {
  readonly createRoom: (config: RoomConfig) => Room
  readonly createRoomSafe: (config: RoomConfig) => CreateResult<Room>
  readonly getRoom: (idOrName: string) => Room | undefined
  readonly getRoomsForAgent: (agentId: string) => ReadonlyArray<Room>
  readonly listAllRooms: () => ReadonlyArray<RoomProfile>
  readonly removeRoom: (id: string) => boolean
  readonly getHousePrompt: () => string
  readonly setHousePrompt: (prompt: string) => void
  readonly getResponseFormat: () => string
  readonly setResponseFormat: (format: string) => void
  readonly restoreRoom: (profile: RoomProfile) => Room
  // Artifact system
  readonly artifacts: ArtifactStore
  readonly artifactTypes: ArtifactTypeRegistry
  // System-wide message bookmarks. New entries at index 0 (top).
  readonly listBookmarks: () => ReadonlyArray<Bookmark>
  readonly addBookmark: (content: string) => Bookmark
  readonly updateBookmark: (id: string, content: string) => Bookmark | undefined
  readonly deleteBookmark: (id: string) => boolean
  readonly restoreBookmarks: (bookmarks: ReadonlyArray<Bookmark>) => void
  // System-level LLM access — available when callSystemLLM is provided via HouseCallbacks
  readonly callSystemLLM?: (options: LLMCallOptions) => Promise<string>
}

export interface RoomConfig {
  readonly name: string
  readonly roomPrompt?: string
  readonly createdBy: string
}
