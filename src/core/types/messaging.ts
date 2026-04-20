// Messaging core types — Message, profiles, delivery, and per-agent history.
// Leaf module (no imports from other type domains).
//
// ID Architecture: UUIDs internal, names for LLM interaction.
// - All entities get auto-generated UUIDs (never caller-specified)
// - Names are unique per type, case-insensitive, immutable after creation
// - LLMs see and use names; the system resolves names to UUIDs at boundaries

// === Message — the fundamental unit of communication ===

export type MessageType = 'chat' | 'join' | 'leave' | 'system' | 'room_summary' | 'pass' | 'mute'

export interface Message {
  readonly id: string
  readonly senderId: string
  readonly senderName?: string        // human-readable sender name, set at post time
  readonly content: string
  readonly timestamp: number
  readonly type: MessageType
  readonly roomId: string             // every message lives in a room
  readonly correlationId?: string     // shared across multi-target deliveries
  readonly inReplyTo?: ReadonlyArray<string>  // IDs of messages this response is causally derived from
  readonly generationMs?: number
  readonly metadata?: Record<string, unknown>
}

// === Profiles — what agents know about rooms and other agents ===

export interface RoomProfile {
  readonly id: string
  readonly name: string
  readonly roomPrompt?: string
  readonly createdBy: string
  readonly createdAt: number
}

export interface AgentProfile {
  readonly id: string
  readonly name: string
  readonly kind: 'ai' | 'human'
  readonly model?: string
  readonly tags?: ReadonlyArray<string>
}

// === Agent History — unified per-agent state across all contexts ===
// Single structure owned by each AI agent. Sub-fields hold per-room history.
// The agent has full access to its complete history; only a historyLimit-sized
// window is passed to the LLM in each context build.

export interface RoomContext {
  readonly profile: RoomProfile
  history: ReadonlyArray<Message>   // all processed messages in this room (unbounded)
  lastActiveAt?: number             // timestamp of last flushIncoming into this context
}

export interface AgentHistory {
  readonly rooms: Map<string, RoomContext>        // roomId → context
  // Intentionally mutable buffer — messages arrive here before evaluation, then
  // flushIncoming moves processed messages to RoomContext history.
  // The `readonly` marker prevents field reassignment, not element mutation.
  // Safe: JavaScript's event loop ensures each flush runs to completion
  // before any other code can observe intermediate state.
  readonly incoming: Message[]
  readonly agentProfiles: Map<string, AgentProfile>
}

// === Message Target — where a response should be delivered ===

export interface MessageTarget {
  readonly rooms: ReadonlyArray<string>    // room IDs (or names for WS/HTTP callers)
}

// === Room Post Parameters — caller provides content, room stamps id/roomId/timestamp ===
// NOTE: PostParams derives from Message via Omit. Fields added to Message automatically
// appear here as optional (e.g. correlationId, generationMs, metadata). This is intentional —
// callers that need those fields set them; others leave them undefined.

export type PostParams = Omit<Message, 'id' | 'roomId' | 'timestamp'>

// === Delivery — callback for Room to deliver messages to agents ===
// History is no longer passed — agents initialise context via join() before
// the first message arrives, so delivered history is redundant.

export type DeliverFn = (agentId: string, message: Message) => void

// === Delivery Modes — room has exactly one active mode ===
// [[AgentName]] addressing and muting work as universal overrides in all modes.

export type DeliveryMode = 'broadcast' | 'flow' | 'manual'

// Modes that can be set directly via the delivery-mode endpoint.
// 'flow' is excluded — it is entered only via startFlow().
export const SETTABLE_DELIVERY_MODES = ['broadcast', 'manual'] as const satisfies ReadonlyArray<Exclude<DeliveryMode, 'flow'>>
export type SettableDeliveryMode = typeof SETTABLE_DELIVERY_MODES[number]

// === Delivery-side utility types ===

export type AgentDeliveryStatus = 'active' | 'waiting' | 'muted'

export type ResolveAgentName = (name: string) => string | undefined  // agent name → UUID
export type ResolveTagFn = (tag: string) => ReadonlyArray<string>    // tag → agent UUIDs
