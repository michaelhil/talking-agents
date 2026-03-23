// ============================================================================
// Talking Agents — Core Type Definitions
//
// ID Architecture: UUIDs internal, names for LLM interaction.
// - All entities get auto-generated UUIDs (never caller-specified)
// - Names are unique per type, case-insensitive, immutable after creation
// - LLMs see and use names; the system resolves names to UUIDs at boundaries
// ============================================================================

// === Message — the fundamental unit of communication ===

export type MessageType = 'chat' | 'join' | 'leave' | 'system' | 'room_summary'

export interface Message {
  readonly id: string
  readonly senderId: string
  readonly content: string
  readonly timestamp: number
  readonly type: MessageType
  readonly roomId?: string            // present for room messages
  readonly recipientId?: string       // present for DMs (target agent's ID)
  readonly correlationId?: string     // shared across multi-target deliveries
  readonly generationMs?: number
  readonly metadata?: Record<string, unknown>
}

// === Profiles — what agents know about rooms and other agents ===

export interface RoomProfile {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly roomPrompt?: string
  readonly visibility: 'public' | 'private'
  readonly createdBy: string
  readonly createdAt: number
}

export interface AgentProfile {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly kind: 'ai' | 'human'
}

// === Message Target — where a response should be delivered ===
// Names at the LLM boundary, resolved to UUIDs by resolveTarget before delivery.

export interface MessageTarget {
  readonly rooms?: ReadonlyArray<string>    // room names (LLM) or IDs (internal)
  readonly agents?: ReadonlyArray<string>   // agent names (LLM) or IDs (internal)
}

// === Room Post Parameters — caller provides content, room stamps id/roomId/timestamp ===

export type PostParams = Omit<Message, 'id' | 'roomId' | 'timestamp' | 'recipientId'>

// === Room — pure data structure returned by createRoom ===

export interface Room {
  readonly profile: RoomProfile
  readonly post: (params: PostParams) => PostResult
  readonly getRecent: (n: number) => ReadonlyArray<Message>
  readonly getParticipantIds: () => ReadonlyArray<string>
  readonly addMember: (id: string) => void
  readonly removeMember: (id: string) => void
  readonly hasMember: (id: string) => boolean
  readonly getMessageCount: () => number
}

export interface PostResult {
  readonly message: Message
  readonly recipientIds: ReadonlyArray<string>
}

// === CreateResult — returned when name uniqueness is enforced ===

export interface CreateResult<T> {
  readonly value: T
  readonly requestedName: string
  readonly assignedName: string
}

// === House — room collection ===

export interface House {
  readonly createRoom: (config: RoomConfig) => Room
  readonly createRoomSafe: (config: RoomConfig) => CreateResult<Room>
  readonly getRoom: (id: string) => Room | undefined
  readonly findByName: (name: string) => Room | undefined
  readonly listPublicRooms: () => ReadonlyArray<RoomProfile>
  readonly listAllRooms: () => ReadonlyArray<RoomProfile>
  readonly removeRoom: (id: string) => boolean
}

export interface RoomConfig {
  readonly name: string
  readonly description?: string
  readonly roomPrompt?: string
  readonly visibility: 'public' | 'private'
  readonly createdBy: string
}

// === Agent State — subscribe/get pattern for observability ===

export type StateValue = 'idle' | 'generating'

export interface AgentState {
  readonly get: () => StateValue
  readonly subscribe: (fn: StateSubscriber) => () => void
}

export type StateSubscriber = (state: StateValue, agentId: string, context?: string) => void

// === Agent — unified interface for AI agents and humans ===

export interface Agent {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly kind: 'ai' | 'human'
  readonly metadata: Record<string, unknown>
  readonly state: AgentState
  readonly getMessages: () => ReadonlyArray<Message>
  readonly receive: (message: Message) => void
  readonly join: (room: Room) => Promise<void>
  readonly getRoomIds: () => ReadonlyArray<string>
  readonly getMessagesForRoom: (roomId: string, limit?: number) => ReadonlyArray<Message>
  readonly getMessagesForPeer: (peerId: string, limit?: number) => ReadonlyArray<Message>
}

// === AIAgent — extended Agent with async evaluation observability ===

export interface AIAgent extends Agent {
  readonly whenIdle: (timeoutMs?: number) => Promise<void>
}

// === Team — agent collection (AI + human) ===

export interface Team {
  readonly add: (agent: Agent) => void
  readonly get: (id: string) => Agent | undefined
  readonly findByName: (name: string) => Agent | undefined
  readonly remove: (id: string) => boolean
  readonly list: () => ReadonlyArray<Agent>
  readonly listByKind: (kind: 'ai' | 'human') => ReadonlyArray<Agent>
}

// === PostAndDeliver — the single coordination function ===

export type PostAndDeliver = (target: MessageTarget, params: PostParams) => ReadonlyArray<Message>

// === AI Agent Configuration ===
// No ID field — system generates UUID automatically.

export interface AIAgentConfig {
  readonly name: string
  readonly description: string
  readonly model: string
  readonly systemPrompt: string
  readonly temperature?: number
  readonly cooldownMs: number
  readonly historyLimit?: number
}

// === Agent Response (JSON from LLM) ===
// Target uses names (resolved to UUIDs by resolveTarget before delivery).

export type AgentResponse =
  | {
      readonly action: 'respond'
      readonly content: string
      readonly target: MessageTarget
      readonly reason?: string
      readonly actions?: ReadonlyArray<AgentAction>
    }
  | {
      readonly action: 'pass'
      readonly reason?: string
      readonly actions?: ReadonlyArray<AgentAction>
    }

// Agent actions use names, not IDs. Resolved to UUIDs in actions.ts.
export type AgentAction =
  | {
      readonly type: 'create_room'
      readonly name: string
      readonly description?: string
      readonly roomPrompt?: string
      readonly visibility: 'public' | 'private'
      readonly add?: ReadonlyArray<string>  // agent names to add after creation
    }
  | {
      readonly type: 'add_to_room'
      readonly roomName: string
      readonly agentName: string  // self = join, other = invite
    }

// === LLM Provider ===

export interface ChatRequest {
  readonly model: string
  readonly messages: ReadonlyArray<{
    readonly role: 'system' | 'user' | 'assistant'
    readonly content: string
  }>
  readonly temperature?: number
  readonly maxTokens?: number
  readonly jsonMode?: boolean
}

export interface ChatResponse {
  readonly content: string
  readonly generationMs: number
  readonly tokensUsed: {
    readonly prompt: number
    readonly completion: number
  }
}

export interface LLMProvider {
  readonly chat: (request: ChatRequest) => Promise<ChatResponse>
  readonly models: () => Promise<string[]>
}

// === WebSocket Protocol — typed inbound/outbound messages ===

export type WSInbound =
  | { readonly type: 'post_message'; readonly target: MessageTarget; readonly content: string }
  | { readonly type: 'create_room'; readonly name: string; readonly description?: string; readonly roomPrompt?: string; readonly visibility: 'public' | 'private' }
  | { readonly type: 'add_to_room'; readonly roomName: string; readonly agentName: string }
  | { readonly type: 'create_agent'; readonly config: AIAgentConfig }
  | { readonly type: 'remove_agent'; readonly name: string }

export type WSOutbound =
  | { readonly type: 'message'; readonly message: Message }
  | { readonly type: 'agent_state'; readonly agentName: string; readonly state: StateValue; readonly context?: string }
  | { readonly type: 'room_created'; readonly profile: RoomProfile }
  | { readonly type: 'agent_joined'; readonly agentName: string; readonly roomName: string }
  | { readonly type: 'snapshot'; readonly rooms: ReadonlyArray<RoomProfile>; readonly agents: ReadonlyArray<AgentProfile>; readonly agentId: string; readonly sessionToken?: string }
  | { readonly type: 'error'; readonly message: string }

// === System Constants ===

export const SYSTEM_SENDER_ID = 'system' as const

export const DEFAULTS = {
  port: 3000,
  ollamaBaseUrl: 'http://localhost:11434',
  historyLimit: 50,
  roomMessageLimit: 500,
  cooldownMs: 15000,
  maxAgentActionsPerResponse: 5,
} as const
