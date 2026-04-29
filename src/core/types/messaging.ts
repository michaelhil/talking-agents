// Messaging core types — Message, profiles, delivery, and per-agent history.
// Leaf module.
//
// ID Architecture: UUIDs internal, names for LLM interaction.
// - All entities get auto-generated UUIDs (never caller-specified)
// - Names are unique per type, case-insensitive, immutable after creation
// - LLMs see and use names; the system resolves names to UUIDs at boundaries

// === Message — the fundamental unit of communication ===

export type MessageType = 'chat' | 'join' | 'leave' | 'system' | 'room_summary' | 'pass' | 'mute' | 'error'

// Discriminator for error messages — drives UI styling and the "Change model"
// affordance. Mirrors AgentResponseErrorCode in core/types/agent.ts; kept here
// (not imported) so the messaging module stays leaf-level.
export type MessageErrorCode =
  | 'no_api_key'
  | 'model_unavailable'
  | 'rate_limited'
  | 'network'
  | 'provider_down'
  | 'tool_loop_exceeded'
  | 'empty_response'
  | 'tools_unavailable'
  | 'unknown'

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

  // --- Chat / eval telemetry (set by spawn.onDecision on chat/pass messages) ---
  readonly promptTokens?: number
  readonly completionTokens?: number
  readonly contextMax?: number        // bound provider's context window for this call
  readonly provider?: string          // bound provider name (e.g. 'gemini', 'ollama')
  readonly model?: string             // model id reported by the provider

  // --- Error telemetry (set when type === 'error') ---
  readonly errorCode?: MessageErrorCode
  readonly errorProvider?: string     // provider hint, drives "Change model" affordance

  // --- Join-message agent profile (stamped by actions.ts via makeJoinMetadata) ---
  readonly agentName?: string         // joining agent's name
  readonly agentKind?: 'ai' | 'human'
  readonly agentTags?: ReadonlyArray<string>

  // --- Tool-call trace (stamped by spawn.onDecision for 'respond' actions that
  //     invoked tools during evaluation). One entry per tool call the agent made
  //     while producing this reply. Omitted when the agent didn't call any
  //     tools. `resultPreview` is truncated; the agent saw a larger preview in
  //     its own context. Primary consumer: the experiment runner's export_room
  //     tool — enables analyses like "which variants used web_search? how often?".
  readonly toolTrace?: ReadonlyArray<ToolTraceEntry>
}

export interface ToolTraceEntry {
  readonly tool: string
  readonly arguments: Record<string, unknown>
  readonly success: boolean
  readonly resultPreview: string   // <=200 chars (truncated result or error message)
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
// appear here as optional (e.g. correlationId, generationMs, promptTokens,
// agentName). This is intentional — callers that need those fields set them; others
// leave them undefined.

export type PostParams = Omit<Message, 'id' | 'roomId' | 'timestamp'>

// === Delivery — callback for Room to deliver messages to agents ===
// History is no longer passed — agents initialise context via join() before
// the first message arrives, so delivered history is redundant.

export type DeliverFn = (agentId: string, message: Message) => void

// === Delivery Modes — room has exactly one active mode ===
// [[AgentName]] addressing and muting work as universal overrides in all modes.
// Scripts (see core/script-engine.ts) drive their own turns and do not extend
// this enum — they take over the room while active.

export type DeliveryMode = 'broadcast' | 'manual'

export const SETTABLE_DELIVERY_MODES = ['broadcast', 'manual'] as const satisfies ReadonlyArray<DeliveryMode>
export type SettableDeliveryMode = typeof SETTABLE_DELIVERY_MODES[number]

// === Delivery-side utility types ===

export type AgentDeliveryStatus = 'active' | 'waiting' | 'muted'

export type ResolveAgentName = (name: string) => string | undefined  // agent name → UUID
export type ResolveTagFn = (tag: string) => ReadonlyArray<string>    // tag → agent UUIDs

// === Message-type predicates ===
// `pass` and `error` are agent decisions/outcomes — they post to the room so
// humans can see them, but they must not pollute LLM context, trigger summary
// runs, or kick off another agent's evaluation.

export const isAgentDecisionMessage = (msg: Pick<Message, 'type'>): boolean =>
  msg.type === 'pass' || msg.type === 'error'
