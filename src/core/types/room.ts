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
import type { Flow, FlowExecution, FlowEventDetails, FlowEventName } from './flow.ts'
import type { ArtifactStore, ArtifactTypeRegistry, OnArtifactChanged } from './artifact.ts'
import type { LLMCallOptions } from './llm.ts'

// === Room event callbacks ===

export type OnMessagePosted = (roomId: string, message: Message) => void
export type OnDeliveryModeChanged = (roomId: string, mode: DeliveryMode) => void
export type OnTurnChanged = (roomId: string, agentId?: string, waitingForHuman?: boolean) => void
export type OnFlowEvent = <E extends FlowEventName>(roomId: string, event: E, detail?: FlowEventDetails[E]) => void
export type OnRoomCreated = (profile: RoomProfile) => void
export type OnRoomDeleted = (roomId: string, roomName: string) => void
export type OnMembershipChanged = (roomId: string, roomName: string, agentId: string, agentName: string, action: 'added' | 'removed') => void

// === Room state snapshot (for UI sync on connect/reconnect) ===

export interface RoomState {
  readonly mode: DeliveryMode
  readonly paused: boolean
  readonly muted: ReadonlyArray<string>
  readonly members: ReadonlyArray<string>
  readonly flowExecution?: {
    readonly flowId: string
    readonly stepIndex: number
  }
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
  readonly setDeliveryMode: (mode: Exclude<DeliveryMode, 'flow'>) => void

  // Pause — room-level, prevents all delivery (join/leave and addressing still work)
  readonly paused: boolean
  readonly setPaused: (paused: boolean) => void

  // Room state snapshot (for UI sync)
  readonly getRoomState: () => RoomState

  // Muting — user-controlled, persistent, mode-independent
  readonly setMuted: (agentId: string, muted: boolean) => void
  readonly isMuted: (agentId: string) => boolean
  readonly getMutedIds: () => ReadonlySet<string>

  // Flow execution — blueprint is now an artifact; Room only manages execution
  readonly startFlow: (flow: Flow) => void   // caller resolves artifact → constructs Flow → passes here
  readonly cancelFlow: () => void
  readonly flowExecution: FlowExecution | undefined

  // Compression tracking — IDs of messages pruned from history (tombstones)
  readonly getCompressedIds: () => ReadonlySet<string>

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
  readonly onMessagePosted?: OnMessagePosted
  readonly onTurnChanged?: OnTurnChanged
  readonly onDeliveryModeChanged?: OnDeliveryModeChanged
  readonly onFlowEvent?: OnFlowEvent
  readonly onArtifactChanged?: OnArtifactChanged
  readonly onRoomCreated?: OnRoomCreated
  readonly onRoomDeleted?: OnRoomDeleted
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
  // System-level LLM access — available when callSystemLLM is provided via HouseCallbacks
  readonly callSystemLLM?: (options: LLMCallOptions) => Promise<string>
}

export interface RoomConfig {
  readonly name: string
  readonly roomPrompt?: string
  readonly createdBy: string
}
