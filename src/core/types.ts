// ============================================================================
// Talking Agents — Core Type Definitions
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

export interface MessageTarget {
  readonly rooms?: ReadonlyArray<string>    // room IDs
  readonly agents?: ReadonlyArray<string>   // agent IDs (for DMs)
}

// === Room Post Parameters — caller provides content, room stamps id/roomId/timestamp ===

export interface PostParams {
  readonly senderId: string
  readonly content: string
  readonly type: MessageType
  readonly generationMs?: number
  readonly correlationId?: string
  readonly metadata?: Record<string, unknown>
}

// === Room — pure data structure returned by createRoom ===

export interface Room {
  readonly profile: RoomProfile
  readonly post: (params: PostParams) => PostResult
  readonly getRecent: (n: number) => ReadonlyArray<Message>
  readonly getParticipantIds: () => ReadonlyArray<string>
  readonly getMessageCount: () => number
}

export interface PostResult {
  readonly message: Message
  readonly recipientIds: ReadonlyArray<string>
}

// === House — room collection ===

export interface House {
  readonly createRoom: (config: RoomConfig) => Room
  readonly getRoom: (id: string) => Room | undefined
  readonly listPublicRooms: () => ReadonlyArray<RoomProfile>
  readonly listAllRooms: () => ReadonlyArray<RoomProfile>
  readonly removeRoom: (id: string) => boolean
}

export interface RoomConfig {
  readonly id?: string
  readonly name: string
  readonly description?: string
  readonly roomPrompt?: string
  readonly visibility: 'public' | 'private'
  readonly createdBy: string
}

// === Agent — unified interface for AI agents and humans ===

export interface Agent {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly kind: 'ai' | 'human'
  readonly metadata: Record<string, unknown>
  readonly getMessages: () => ReadonlyArray<Message>
  readonly receive: (message: Message) => void
  readonly join: (room: Room) => Promise<void>
  readonly getRoomIds: () => ReadonlyArray<string>
  readonly getMessagesForRoom: (roomId: string, limit?: number) => ReadonlyArray<Message>
  readonly getMessagesForPeer: (peerId: string, limit?: number) => ReadonlyArray<Message>
}

// === Team — agent collection (AI + human) ===

export interface Team {
  readonly add: (agent: Agent) => void
  readonly get: (id: string) => Agent | undefined
  readonly remove: (id: string) => boolean
  readonly list: () => ReadonlyArray<Agent>
  readonly listByKind: (kind: 'ai' | 'human') => ReadonlyArray<Agent>
}

// === PostAndDeliver — the single coordination function ===

export type PostAndDeliver = (target: MessageTarget, params: PostParams) => ReadonlyArray<Message>

// === AI Agent Configuration (internal to createAIAgent factory) ===

export interface AIAgentConfig {
  readonly participantId: string
  readonly name: string
  readonly description: string
  readonly model: string
  readonly systemPrompt: string
  readonly temperature?: number
  readonly cooldownMs: number
  readonly historyLimit?: number
}

// === Agent Response (JSON from LLM) ===

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

export type AgentAction =
  | {
      readonly type: 'create_room'
      readonly name: string
      readonly description?: string
      readonly roomPrompt?: string
      readonly visibility: 'public' | 'private'
      readonly inviteIds?: ReadonlyArray<string>
    }
  | { readonly type: 'join_room'; readonly roomId: string }
  | {
      readonly type: 'invite_to_room'
      readonly roomId: string
      readonly participantId: string
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

// === System Constants ===

export const SYSTEM_SENDER_ID = 'system' as const
export const INTRODUCTIONS_ROOM_ID = 'introductions' as const

export const DEFAULTS = {
  port: 3000,
  ollamaBaseUrl: 'http://localhost:11434',
  historyLimit: 50,
  cooldownMs: 15000,
  maxAgentActionsPerResponse: 5,
} as const
