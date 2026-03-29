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
  readonly roomId: string             // every message lives in a room
  readonly correlationId?: string     // shared across multi-target deliveries
  readonly inReplyTo?: ReadonlyArray<string>  // IDs of messages this response is causally derived from
  readonly generationMs?: number
  readonly metadata?: Record<string, unknown>
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

export type DeliveryMode = 'broadcast' | 'flow'

// Modes that can be set directly via the delivery-mode endpoint.
// 'flow' is excluded — it is entered only via startFlow().
export const SETTABLE_DELIVERY_MODES = ['broadcast'] as const satisfies ReadonlyArray<Exclude<DeliveryMode, 'flow'>>
export type SettableDeliveryMode = typeof SETTABLE_DELIVERY_MODES[number]

// --- Flow types ---

export interface FlowStep {
  readonly agentId: string         // agent UUID (resolved once at flow creation)
  readonly agentName: string       // human-readable name (for display and LLM context)
  readonly stepPrompt?: string     // per-step instruction for this agent
}

export interface Flow {
  readonly id: string              // crypto.randomUUID() — or artifact ID when sourced from an artifact
  readonly name: string
  readonly steps: ReadonlyArray<FlowStep>
  readonly loop: boolean           // repeat or stop after one pass
}

export interface FlowExecution {
  readonly flow: Flow
  readonly triggerMessageId: string
  stepIndex: number
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

// === Artifact System ===
// Artifacts are system-level collaborative objects (task lists, polls, flow blueprints, etc.).
// They live in House (not rooms) and are scoped to rooms via `scope`.
// The artifact type system mirrors the Tool plugin pattern.

// --- Embedded task item within a task_list artifact ---
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked'

export interface TaskItem {
  readonly id: string                          // local UUID within the list
  readonly content: string
  readonly status: TaskStatus
  readonly assignee?: string                   // agent name
  readonly assigneeId?: string                 // agent UUID
  readonly result?: string                     // resolution comment when completed
  readonly dependencies?: ReadonlyArray<string>  // other TaskItem ids within same list
  readonly createdBy: string                   // agent name
  readonly createdAt: number
  readonly updatedAt: number
}

// --- Built-in artifact body types ---

export interface TaskListBody {
  readonly description?: string
  readonly tasks: ReadonlyArray<TaskItem>
}

export interface PollOption {
  readonly id: string
  readonly text: string
}

export interface PollBody {
  readonly question: string
  readonly options: ReadonlyArray<PollOption>   // immutable after creation
  readonly votes: Record<string, ReadonlyArray<string>>  // optionId → agentId[]
  readonly allowMultiple: boolean
}

export interface FlowArtifactBody {
  readonly steps: ReadonlyArray<FlowStep>
  readonly loop: boolean
}

// --- Artifact instance ---

export interface Artifact {
  readonly id: string
  readonly type: string                         // artifact type name: 'task_list', 'poll', 'flow'
  readonly title: string                        // human-readable label
  readonly body: Record<string, unknown>        // type-specific payload
  readonly scope: ReadonlyArray<string>         // room IDs; empty = system-wide
  readonly createdBy: string                    // agent name
  readonly createdAt: number
  readonly updatedAt: number
  readonly resolution?: string                  // how/why it was resolved
  readonly resolvedAt?: number                  // timestamp of resolution
}

export interface ArtifactCreateConfig {
  readonly type: string
  readonly title: string
  readonly body: Record<string, unknown>
  readonly scope?: ReadonlyArray<string>        // defaults to []
  readonly createdBy: string
}

export interface ArtifactUpdateConfig {
  readonly title?: string
  readonly body?: Record<string, unknown>       // type's onUpdate decides merge strategy; default: shallow merge
  readonly resolution?: string                  // explicit resolution
}

// Returned by ArtifactTypeDefinition.onUpdate — overrides default shallow merge
export interface ArtifactUpdateResult {
  readonly newBody?: Record<string, unknown>    // replaces body if provided; if absent, default merge applies
  readonly resolution?: string                  // auto-resolves if set
}

// --- Artifact type definition (plugin contract, mirrors Tool) ---
// Types that need dependencies (ArtifactStore, Team) are factory functions injected at registration.

export interface ArtifactTypeDefinition {
  readonly type: string
  readonly description: string
  readonly bodySchema: Record<string, unknown>  // JSON Schema for body — used in tool parameters
  // Lifecycle hooks — all optional
  readonly onCreate?: (artifact: Artifact, ctx: ToolContext) => void
  readonly onUpdate?: (artifact: Artifact, updates: ArtifactUpdateConfig, ctx: ToolContext) => ArtifactUpdateResult | void
  readonly onRemove?: (artifact: Artifact) => void
  readonly checkAutoResolve?: (artifact: Artifact) => string | undefined
  // LLM context rendering — optional; generic fallback used if absent
  readonly formatForContext?: (artifact: Artifact) => string
  // Controls when a system message is posted to scoped rooms on change
  readonly postSystemMessageOn?: ReadonlyArray<'added' | 'removed' | 'resolved'>
}

export interface ArtifactTypeRegistry {
  readonly register: (def: ArtifactTypeDefinition) => void
  readonly get: (type: string) => ArtifactTypeDefinition | undefined
  readonly list: () => ReadonlyArray<ArtifactTypeDefinition>
}

// --- Artifact store (held by House) ---

export interface ArtifactFilter {
  readonly type?: string
  readonly scope?: string    // room ID — returns artifacts scoped to this room + system-wide
  readonly includeResolved?: boolean  // default false
}

export interface ArtifactStore {
  readonly add: (config: ArtifactCreateConfig) => Artifact
  readonly update: (id: string, updates: ArtifactUpdateConfig, ctx?: ToolContext) => Artifact | undefined
  readonly remove: (id: string) => boolean
  readonly get: (id: string) => Artifact | undefined
  readonly list: (filter?: ArtifactFilter) => ReadonlyArray<Artifact>
  readonly getForScope: (roomId: string) => ReadonlyArray<Artifact>
  readonly restore: (artifacts: ReadonlyArray<Artifact>) => void
}

// --- Callbacks ---

export type OnArtifactChanged = (action: 'added' | 'updated' | 'removed', artifact: Artifact) => void

// === Room event callbacks ===

export type OnMessagePosted = (roomId: string, message: Message) => void
export type OnDeliveryModeChanged = (roomId: string, mode: DeliveryMode) => void
export type OnTurnChanged = (roomId: string, agentId?: string, waitingForHuman?: boolean) => void
export type OnFlowEvent = (roomId: string, event: 'started' | 'step' | 'completed' | 'cancelled', detail?: Record<string, unknown>) => void
export type OnRoomCreated = (profile: RoomProfile) => void
export type OnRoomDeleted = (roomId: string, roomName: string) => void
export type OnMembershipChanged = (roomId: string, roomName: string, agentId: string, agentName: string, action: 'added' | 'removed') => void

// --- Room state snapshot (for UI sync on connect/reconnect) ---

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

export type AgentDeliveryStatus = 'active' | 'waiting' | 'muted'

// --- Room dependencies ---

export type ResolveAgentName = (name: string) => string | undefined  // agent name → UUID

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
  readonly onMessagePosted?: OnMessagePosted
  readonly onTurnChanged?: OnTurnChanged
  readonly onDeliveryModeChanged?: OnDeliveryModeChanged
  readonly onFlowEvent?: OnFlowEvent
  readonly onArtifactChanged?: OnArtifactChanged
  readonly onRoomCreated?: OnRoomCreated
  readonly onRoomDeleted?: OnRoomDeleted
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
}

export interface RoomConfig {
  readonly name: string
  readonly roomPrompt?: string
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
  readonly receive: (message: Message) => void
  readonly join: (room: Room) => Promise<void>
  readonly leave: (roomId: string) => void
  readonly inactive?: boolean
  readonly setInactive?: (value: boolean) => void
}

// === AIAgent — extended Agent with observability ===

export interface AIAgent extends Agent {
  readonly whenIdle: (timeoutMs?: number) => Promise<void>
  readonly updateSystemPrompt: (prompt: string) => void
  readonly getSystemPrompt: () => string
  readonly updateModel: (model: string) => void
  readonly getModel: () => string
  readonly cancelGeneration: () => void
  readonly getTemperature: () => number | undefined
  readonly getHistoryLimit: () => number | undefined
  readonly getTools: () => ReadonlyArray<string> | undefined
  // Returns a snapshot of the agent's current configuration (mutable fields resolved).
  // Use this when you need multiple config fields at once (e.g. for serialization).
  readonly getConfig: () => AIAgentConfig
}

// === Team — agent collection (AI + human) ===

export interface Team {
  readonly addAgent: (agent: Agent) => void
  readonly getAgent: (idOrName: string) => Agent | undefined
  readonly removeAgent: (id: string) => boolean
  readonly listAgents: () => ReadonlyArray<Agent>
  readonly listByKind: (kind: 'ai' | 'human') => ReadonlyArray<Agent>
}

// === RouterDeps — configuration object for createMessageRouter ===

export interface RouterDeps {
  readonly house: House
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
  readonly roomId?: string    // current trigger room ID — available when tool is called from a room context
}

export interface Tool {
  readonly name: string
  readonly description: string
  readonly usage?: string           // when to use / when not to — injected into LLM context
  readonly returns?: string         // human-readable description of the return value
  readonly parameters: Record<string, unknown>  // JSON Schema for LLM
  readonly execute: (params: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>
}

export interface ToolRegistry {
  readonly register: (tool: Tool) => void
  readonly registerAll: (tools: ReadonlyArray<Tool>) => void
  readonly get: (name: string) => Tool | undefined
  readonly has: (name: string) => boolean
  readonly list: () => ReadonlyArray<Tool>
}

export type ToolExecutor = (calls: ReadonlyArray<ToolCall>, roomId?: string) => Promise<ReadonlyArray<ToolResult>>

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
  readonly maxToolResultChars?: number          // default: 4000
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

// === LLM Provider ===

// OpenAI/Ollama-compatible tool definition (used in native tool calling)
export interface ToolDefinition {
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly description: string
    readonly parameters: Record<string, unknown>
  }
}

// Tool call returned by native tool-calling models
export interface NativeToolCall {
  readonly function: {
    readonly name: string
    readonly arguments: Record<string, unknown>
  }
}

export interface ChatRequest {
  readonly model: string
  readonly messages: ReadonlyArray<{
    readonly role: 'system' | 'user' | 'assistant'
    readonly content: string
  }>
  readonly temperature?: number
  readonly maxTokens?: number
  readonly jsonMode?: boolean
  readonly tools?: ReadonlyArray<ToolDefinition>
}

export interface ChatResponse {
  readonly content: string
  readonly generationMs: number
  readonly tokensUsed: {
    readonly prompt: number
    readonly completion: number
  }
  readonly toolCalls?: ReadonlyArray<NativeToolCall>
}

export interface LLMProvider {
  readonly chat: (request: ChatRequest) => Promise<ChatResponse>
  readonly models: () => Promise<string[]>
  readonly runningModels?: () => Promise<string[]>
}

// === WebSocket Protocol — typed inbound/outbound messages ===

export type WSInbound =
  | { readonly type: 'post_message'; readonly target: MessageTarget; readonly content: string }
  | { readonly type: 'create_room'; readonly name: string; readonly roomPrompt?: string }
  | { readonly type: 'add_to_room'; readonly roomName: string; readonly agentName: string }
  | { readonly type: 'remove_from_room'; readonly roomName: string; readonly agentName: string }
  | { readonly type: 'create_agent'; readonly config: AIAgentConfig }
  | { readonly type: 'remove_agent'; readonly name: string }
  | { readonly type: 'update_agent'; readonly name: string; readonly systemPrompt?: string; readonly model?: string }
  // Delivery mode
  | { readonly type: 'set_delivery_mode'; readonly roomName: string; readonly mode: 'broadcast' }
  // Pause
  | { readonly type: 'set_paused'; readonly roomName: string; readonly paused: boolean }
  // Muting
  | { readonly type: 'set_muted'; readonly roomName: string; readonly agentName: string; readonly muted: boolean }
  // Flow execution (blueprint lives in artifacts; these commands control execution only)
  | { readonly type: 'start_flow'; readonly roomName: string; readonly flowArtifactId: string; readonly content: string }
  | { readonly type: 'cancel_flow'; readonly roomName: string }
  | { readonly type: 'cancel_generation'; readonly name: string }
  // Artifact management
  | { readonly type: 'add_artifact'; readonly artifactType: string; readonly title: string; readonly body: Record<string, unknown>; readonly scope?: ReadonlyArray<string> }
  | { readonly type: 'update_artifact'; readonly artifactId: string; readonly title?: string; readonly body?: Record<string, unknown>; readonly resolution?: string }
  | { readonly type: 'remove_artifact'; readonly artifactId: string }
  | { readonly type: 'cast_vote'; readonly artifactId: string; readonly optionId: string }

export type WSOutbound =
  | { readonly type: 'message'; readonly message: Message }
  | { readonly type: 'agent_state'; readonly agentName: string; readonly state: StateValue; readonly context?: string }
  | { readonly type: 'room_created'; readonly profile: RoomProfile }
  | { readonly type: 'agent_joined'; readonly agent: AgentProfile }
  | { readonly type: 'agent_removed'; readonly agentName: string }
  | { readonly type: 'snapshot'; readonly rooms: ReadonlyArray<RoomProfile>; readonly agents: ReadonlyArray<AgentProfile>; readonly agentId: string; readonly roomStates?: Record<string, RoomState>; readonly sessionToken?: string }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'delivery_mode_changed'; readonly roomName: string; readonly mode: DeliveryMode; readonly paused: boolean }
  | { readonly type: 'mute_changed'; readonly roomName: string; readonly agentName: string; readonly muted: boolean }
  | { readonly type: 'turn_changed'; readonly roomName: string; readonly agentName?: string; readonly waitingForHuman?: boolean }
  | { readonly type: 'flow_event'; readonly roomName: string; readonly event: 'started' | 'step' | 'completed' | 'cancelled'; readonly detail?: Record<string, unknown> }
  | { readonly type: 'artifact_changed'; readonly action: 'added' | 'updated' | 'removed'; readonly artifact: Artifact }
  | { readonly type: 'membership_changed'; readonly roomName: string; readonly agentName: string; readonly action: 'added' | 'removed' }
  | { readonly type: 'room_deleted'; readonly roomName: string }

// === System Constants ===

export const SYSTEM_SENDER_ID = 'system' as const

export const DEFAULTS = {
  port: 3000,
  ollamaBaseUrl: 'http://localhost:11434',
  historyLimit: 50,
  roomMessageLimit: 500,
} as const
