// ============================================================================
// samsinn — Core Type Definitions
//
// ID Architecture: UUIDs internal, names for LLM interaction.
// - All entities get auto-generated UUIDs (never caller-specified)
// - Names are unique per type, case-insensitive, immutable after creation
// - LLMs see and use names; the system resolves names to UUIDs at boundaries
// ============================================================================

// === Message — the fundamental unit of communication ===

export type MessageType = 'chat' | 'join' | 'leave' | 'system' | 'room_summary' | 'pass' | 'mute'

export interface Message {
  readonly id: string
  readonly senderId: string
  readonly senderName?: string        // human-readable sender name, set at post time
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
  readonly roomPrompt?: string
  readonly visibility: 'public' | 'private'
  readonly createdBy: string
  readonly createdAt: number
}

export interface AgentProfile {
  readonly id: string
  readonly name: string
  readonly kind: 'ai' | 'human'
  readonly model?: string
}

// === Message Target — where a response should be delivered ===
// Names at the LLM boundary, resolved to UUIDs by resolveTarget before delivery.

export interface MessageTarget {
  readonly rooms?: ReadonlyArray<string>    // room names (LLM) or IDs (internal)
  readonly agents?: ReadonlyArray<string>   // agent names (LLM) or IDs (internal)
}

// === Room Post Parameters — caller provides content, room stamps id/roomId/timestamp ===

export type PostParams = Omit<Message, 'id' | 'roomId' | 'timestamp' | 'recipientId'>

// === Delivery — callback for Room to deliver messages to agents ===

export type DeliverFn = (agentId: string, message: Message, history: ReadonlyArray<Message>) => void

// === Delivery Modes — room has exactly one active mode ===
// [[AgentName]] addressing and muting work as universal overrides in all modes.

export type DeliveryMode = 'broadcast' | 'flow'

// --- Flow types ---

export interface FlowStep {
  readonly agentId: string         // agent UUID (resolved once at flow creation)
  readonly agentName: string       // human-readable name (for display and LLM context)
  readonly stepPrompt?: string     // per-step instruction for this agent
}

export interface Flow {
  readonly id: string              // crypto.randomUUID()
  readonly name: string
  readonly steps: ReadonlyArray<FlowStep>
  readonly loop: boolean           // repeat or stop after one pass
}

export interface FlowExecution {
  readonly flow: Flow
  readonly triggerMessageId: string
  stepIndex: number
  active: boolean
}

// Carried in message.metadata when delivering in flow mode.
// Gives the receiving agent structural awareness of the flow.
export interface FlowDeliveryContext {
  readonly flowName: string
  readonly stepIndex: number                                    // 0-based index of this step
  readonly totalSteps: number
  readonly loop: boolean
  readonly steps: ReadonlyArray<{ readonly agentName: string }>
}

// --- Todo types ---

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'blocked'

export interface TodoItem {
  readonly id: string              // crypto.randomUUID()
  readonly content: string         // task description
  readonly status: TodoStatus
  readonly assignee?: string       // agent name (for LLM readability)
  readonly assigneeId?: string     // agent UUID (for internal lookups)
  readonly result?: string         // outcome when completed (persists as context for dependent todos)
  readonly dependencies?: ReadonlyArray<string>  // other todo IDs
  readonly createdBy: string       // agent name
  readonly createdAt: number
  readonly updatedAt: number
}

// --- Room event callbacks ---

export type OnTodoChanged = (roomId: string, action: 'added' | 'updated' | 'removed', todo: TodoItem) => void

// --- Room state snapshot (for UI sync on connect/reconnect) ---

export interface RoomState {
  readonly mode: DeliveryMode
  readonly paused: boolean
  readonly muted: ReadonlyArray<string>
  readonly flowExecution?: {
    readonly flowId: string
    readonly stepIndex: number
    readonly active: boolean
  }
}

export type AgentDeliveryStatus = 'active' | 'waiting' | 'muted'

// --- Room dependencies ---

export type ResolveAgentName = (name: string) => string | undefined  // agent name → UUID

// --- Room event callbacks ---

export type OnMessagePosted = (roomId: string, message: Message) => void
export type OnDeliveryModeChanged = (roomId: string, mode: DeliveryMode) => void
export type OnTurnChanged = (roomId: string, agentId?: string, waitingForHuman?: boolean) => void
export type OnFlowEvent = (roomId: string, event: 'started' | 'step' | 'completed' | 'cancelled', detail?: Record<string, unknown>) => void

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

  // Flow management
  readonly addFlow: (config: Omit<Flow, 'id'>) => Flow
  readonly removeFlow: (flowId: string) => boolean
  readonly getFlows: () => ReadonlyArray<Flow>
  readonly startFlow: (flowId: string) => void
  readonly cancelFlow: () => void
  readonly flowExecution: FlowExecution | undefined

  // Todo management — shared task list, any member can CRUD
  readonly addTodo: (config: { content: string; assignee?: string; assigneeId?: string; dependencies?: ReadonlyArray<string>; createdBy: string }) => TodoItem
  readonly updateTodo: (todoId: string, updates: { status?: TodoStatus; assignee?: string; assigneeId?: string; content?: string; result?: string }) => TodoItem | undefined
  readonly removeTodo: (todoId: string) => boolean
  readonly getTodos: () => ReadonlyArray<TodoItem>

  // Snapshot restore — bypass delivery, populate state directly
  readonly injectMessages: (msgs: ReadonlyArray<Message>) => void
  readonly restoreState: (state: {
    readonly members: ReadonlyArray<string>
    readonly muted: ReadonlyArray<string>
    readonly mode: DeliveryMode
    readonly paused: boolean
    readonly flows: ReadonlyArray<Flow>
    readonly todos: ReadonlyArray<TodoItem>
  }) => void
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
  readonly getRoom: (idOrName: string) => Room | undefined
  readonly getRoomsForAgent: (agentId: string) => ReadonlyArray<Room>
  readonly listPublicRooms: () => ReadonlyArray<RoomProfile>
  readonly listAllRooms: () => ReadonlyArray<RoomProfile>
  readonly removeRoom: (id: string) => boolean
  readonly getHousePrompt: () => string
  readonly setHousePrompt: (prompt: string) => void
  readonly getResponseFormat: () => string
  readonly setResponseFormat: (format: string) => void
  readonly restoreRoom: (profile: RoomProfile) => Room
}

export interface RoomConfig {
  readonly name: string
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
  readonly kind: 'ai' | 'human'
  readonly metadata: Record<string, unknown>
  readonly state: AgentState
  readonly receive: (message: Message, history?: ReadonlyArray<Message>) => void
  readonly join: (room: Room) => Promise<void>
  readonly inactive?: boolean
  readonly setInactive?: (value: boolean) => void
}

// === AIAgent — extended Agent with query + observability ===

export interface AIAgent extends Agent {
  readonly whenIdle: (timeoutMs?: number) => Promise<void>
  readonly query: (question: string, askerId: string, askerName?: string) => Promise<string>
  readonly updateSystemPrompt: (prompt: string) => void
  readonly getSystemPrompt: () => string
  readonly updateModel: (model: string) => void
  readonly getModel: () => string
  readonly cancelGeneration: () => void
}

// === Team — agent collection (AI + human) ===

export interface Team {
  readonly addAgent: (agent: Agent) => void
  readonly getAgent: (idOrName: string) => Agent | undefined
  readonly removeAgent: (id: string) => boolean
  readonly listAgents: () => ReadonlyArray<Agent>
  readonly listByKind: (kind: 'ai' | 'human') => ReadonlyArray<Agent>
}

// === RouteMessage — the single coordination function ===

export type RouteMessage = (target: MessageTarget, params: PostParams) => ReadonlyArray<Message>

// === Tool Use Framework ===

export interface ToolCall {
  readonly tool: string
  readonly arguments: Record<string, unknown>
}

export interface ToolResult {
  readonly success: boolean
  readonly data?: unknown
  readonly error?: string
}

export interface ToolContext {
  readonly callerId: string
  readonly callerName: string
}

export interface Tool {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>  // JSON Schema for LLM
  readonly execute: (params: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>
}

export interface ToolRegistry {
  readonly register: (tool: Tool) => void
  readonly get: (name: string) => Tool | undefined
  readonly list: () => ReadonlyArray<Tool>
}

export type ToolExecutor = (calls: ReadonlyArray<ToolCall>) => Promise<ReadonlyArray<ToolResult>>

// === AI Agent Configuration ===
// No ID field — system generates UUID automatically.

export interface AIAgentConfig {
  readonly name: string
  readonly model: string
  readonly systemPrompt: string
  readonly temperature?: number
  readonly historyLimit?: number
  readonly tools?: ReadonlyArray<string>        // tool names this agent can use
  readonly maxToolIterations?: number           // default 5
}

// === Agent Response (parsed from LLM plain text output) ===

export type AgentResponse =
  | {
      readonly action: 'respond'
      readonly content: string
    }
  | {
      readonly action: 'pass'
      readonly reason?: string
    }

// Agent actions use names, not IDs. Resolved to UUIDs in actions.ts.
export type AgentAction =
  | {
      readonly type: 'create_room'
      readonly name: string
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
  readonly runningModels: () => Promise<string[]>
}

// === WebSocket Protocol — typed inbound/outbound messages ===

export type WSInbound =
  | { readonly type: 'post_message'; readonly target: MessageTarget; readonly content: string }
  | { readonly type: 'create_room'; readonly name: string; readonly roomPrompt?: string; readonly visibility: 'public' | 'private' }
  | { readonly type: 'add_to_room'; readonly roomName: string; readonly agentName: string }
  | { readonly type: 'create_agent'; readonly config: AIAgentConfig }
  | { readonly type: 'remove_agent'; readonly name: string }
  | { readonly type: 'update_agent'; readonly name: string; readonly systemPrompt?: string; readonly model?: string }
  // Delivery mode
  | { readonly type: 'set_delivery_mode'; readonly roomName: string; readonly mode: 'broadcast' }
  // Pause
  | { readonly type: 'set_paused'; readonly roomName: string; readonly paused: boolean }
  // Muting
  | { readonly type: 'set_muted'; readonly roomName: string; readonly agentName: string; readonly muted: boolean }
  // Flow management (callers provide agentId — no server-side resolution)
  | { readonly type: 'add_flow'; readonly roomName: string; readonly name: string; readonly steps: ReadonlyArray<FlowStep>; readonly loop?: boolean }
  | { readonly type: 'remove_flow'; readonly roomName: string; readonly flowId: string }
  | { readonly type: 'start_flow'; readonly roomName: string; readonly flowId: string; readonly content: string }
  | { readonly type: 'cancel_flow'; readonly roomName: string }
  // Todo management
  | { readonly type: 'add_todo'; readonly roomName: string; readonly content: string; readonly assignee?: string; readonly assigneeId?: string; readonly dependencies?: ReadonlyArray<string> }
  | { readonly type: 'update_todo'; readonly roomName: string; readonly todoId: string; readonly status?: TodoStatus; readonly assignee?: string; readonly assigneeId?: string; readonly content?: string; readonly result?: string }
  | { readonly type: 'remove_todo'; readonly roomName: string; readonly todoId: string }

export type WSOutbound =
  | { readonly type: 'message'; readonly message: Message }
  | { readonly type: 'agent_state'; readonly agentName: string; readonly state: StateValue; readonly context?: string }
  | { readonly type: 'room_created'; readonly profile: RoomProfile }
  | { readonly type: 'agent_joined'; readonly agent: AgentProfile }
  | { readonly type: 'agent_removed'; readonly agentName: string }
  | { readonly type: 'snapshot'; readonly rooms: ReadonlyArray<RoomProfile>; readonly agents: ReadonlyArray<AgentProfile>; readonly agentId: string; readonly sessionToken?: string }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'delivery_mode_changed'; readonly roomName: string; readonly mode: DeliveryMode; readonly paused: boolean }
  | { readonly type: 'mute_changed'; readonly roomName: string; readonly agentName: string; readonly muted: boolean }
  | { readonly type: 'turn_changed'; readonly roomName: string; readonly agentName?: string; readonly waitingForHuman?: boolean }
  | { readonly type: 'flow_event'; readonly roomName: string; readonly event: 'started' | 'step' | 'completed' | 'cancelled'; readonly detail?: Record<string, unknown> }
  | { readonly type: 'todo_changed'; readonly roomName: string; readonly action: 'added' | 'updated' | 'removed'; readonly todo: TodoItem }

// === System Constants ===

export const SYSTEM_SENDER_ID = 'system' as const

export const DEFAULTS = {
  port: 3000,
  ollamaBaseUrl: 'http://localhost:11434',
  historyLimit: 50,
  roomMessageLimit: 500,
  maxAgentActionsPerResponse: 5,
} as const
