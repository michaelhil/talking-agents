// Agent types — Agent, AIAgent, state observability, team membership,
// AI configuration, response shape, and message-routing coordination.

import type { Message, MessageTarget, PostParams } from './messaging.ts'
import type { ToolDefinition, ToolExecutor } from './tool.ts'
import type { Room, House } from './room.ts'

// === Agent State — subscribe/get pattern for observability ===

export type StateValue = 'idle' | 'generating'

export interface AgentState {
  readonly get: () => StateValue
  readonly getContext: () => string | undefined
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
  readonly getDescription?: () => string
  readonly updateDescription?: (desc: string) => void
  // Capability/role tags — used for [[tag:X]] addressing via team.listByTag.
  readonly getTags?: () => ReadonlyArray<string>
  readonly updateTags?: (tags: ReadonlyArray<string>) => void
}

// === AIAgent — extended Agent with observability ===

// Per-agent toggles controlling which prompt sections are injected into the
// LLM system message. UI labels map to config keys as:
//   UI "Agent persona"   → `persona`        (the per-agent persona string)
//   UI "Room prompt"     → `room`           (the trigger room's roomPrompt)
//   UI "System prompt"   → `house`          (global housePrompt — NOT the LLM `role:'system'`)
//   UI "Response format" → `responseFormat` (global responseFormat)
// All default true; undefined at load → preserve current behavior.
export type PromptSection = 'persona' | 'room' | 'house' | 'responseFormat' | 'skills'
export type IncludePrompts = Partial<Record<PromptSection, boolean>>

// Sub-sections inside the generated CONTEXT block. Default all true; undefined
// preserves current behavior. Unlike `PromptSection`, these are fixed-purpose
// informational (not author-written text), so the magnifier shows the text
// that would be injected at request time.
export type ContextSection = 'participants' | 'artifacts' | 'activity' | 'knownAgents'
export type IncludeContext = Partial<Record<ContextSection, boolean>>

export interface AIAgent extends Agent {
  readonly whenIdle: (timeoutMs?: number) => Promise<void>
  readonly updatePersona: (persona: string) => void
  readonly getPersona: () => string
  readonly updateModel: (model: string) => void
  readonly getModel: () => string
  readonly cancelGeneration: () => void
  readonly getTemperature: () => number | undefined
  readonly updateTemperature?: (t: number | undefined) => void
  readonly getHistoryLimit: () => number | undefined
  readonly updateHistoryLimit?: (n: number) => void
  readonly getThinking: () => boolean
  readonly updateThinking?: (enabled: boolean) => void
  readonly getTools: () => ReadonlyArray<string> | undefined
  readonly updateTools?: (tools: ReadonlyArray<string>) => void
  readonly refreshTools?: (support: { toolExecutor?: ToolExecutor; toolDefinitions?: ReadonlyArray<ToolDefinition> }) => void
  // Context & Prompts toggles
  readonly getIncludePrompts: () => Required<IncludePrompts>
  readonly updateIncludePrompts: (partial: IncludePrompts) => void
  readonly getIncludeContext: () => Required<IncludeContext>
  readonly updateIncludeContext: (partial: IncludeContext) => void
  readonly getIncludeTools: () => boolean
  readonly updateIncludeTools: (enabled: boolean) => void
  readonly getPromptsEnabled: () => boolean
  readonly updatePromptsEnabled: (enabled: boolean) => void
  readonly getContextEnabled: () => boolean
  readonly updateContextEnabled: (enabled: boolean) => void
  readonly getMaxToolResultChars: () => number | undefined
  readonly updateMaxToolResultChars: (n: number | undefined) => void
  readonly getMaxToolIterations: () => number | undefined
  readonly updateMaxToolIterations: (n: number | undefined) => void
  // Context preview — runs buildSystemSections for a specific room and
  // returns section-by-section text + token estimate plus budget resolution.
  // Used by the UI panel so every magnifier has ground truth.
  readonly getContextPreview: (roomId: string) => ContextPreview
  // Memory introspection + management
  readonly getHistory?: (roomId: string) => ReadonlyArray<Message>
  readonly getIncoming?: () => ReadonlyArray<Message>
  readonly getMemoryStats?: () => AgentMemoryStats
  readonly clearHistory?: (roomId?: string) => void
  readonly deleteHistoryMessage?: (roomId: string, messageId: string) => boolean
  // Remove a cached profile from this agent's knowledge of other agents.
  // Called by System.removeAgent so surviving agents don't retain a stale
  // "known agents" entry for a deleted participant.
  readonly forgetAgent?: (agentId: string) => void
  // Returns a snapshot of the agent's current configuration (mutable fields resolved).
  // Use this when you need multiple config fields at once (e.g. for serialization).
  readonly getConfig: () => AIAgentConfig
  // Manual-mode primitives (general-purpose, not mode-specific):
  // ingestHistory appends unseen messages to the agent's room history without
  // triggering evaluation or compression; forceEvaluate triggers one eval
  // regardless of the room's delivery mode.
  readonly ingestHistory?: (roomId: string, messages: ReadonlyArray<Message>) => void
  readonly forceEvaluate?: (roomId: string) => void
}

export interface ContextPreviewSection {
  readonly key: string
  readonly label: string
  readonly text: string
  readonly tokens: number
  readonly enabled: boolean
  readonly optional: boolean
}

export interface ContextPreview {
  readonly roomId: string
  readonly roomName: string
  readonly sections: ReadonlyArray<ContextPreviewSection>
  readonly modelMax: number   // model's context window; 0 if unknown
  readonly historyEstimate: { readonly messages: number; readonly chars: number }
}

export interface AgentMemoryStats {
  readonly rooms: ReadonlyArray<{
    readonly roomId: string
    readonly roomName: string
    readonly messageCount: number
    readonly lastActiveAt?: number
  }>
  readonly incomingCount: number
  readonly knownAgents: ReadonlyArray<string>
}

// === Team — agent collection (AI + human) ===

export interface Team {
  readonly addAgent: (agent: Agent) => void
  readonly getAgent: (idOrName: string) => Agent | undefined
  readonly removeAgent: (id: string) => boolean
  readonly listAgents: () => ReadonlyArray<Agent>
  readonly listByKind: (kind: 'ai' | 'human') => ReadonlyArray<Agent>
  readonly listByTag: (tag: string) => ReadonlyArray<Agent>
}

// === Message router — single coordination function ===

export interface RouterDeps {
  readonly house: House
}

export type RouteMessage = (target: MessageTarget, params: PostParams) => ReadonlyArray<Message>

// === AI Agent Configuration ===
// No ID field — system generates UUID automatically.

export interface AIAgentConfig {
  readonly name: string
  readonly model: string
  readonly persona: string
  readonly temperature?: number
  // Deterministic seed forwarded to every LLM call the agent issues, including
  // tool-initiated sub-calls via ToolContext.llm. Coverage is best-effort per
  // provider (Ollama + OpenAI/Groq/Cerebras/OpenRouter/Mistral/SambaNova honor
  // it; Anthropic + Gemini silently discard). See README "Scripted runs".
  readonly seed?: number
  readonly historyLimit?: number
  readonly tools?: ReadonlyArray<string>        // tool names this agent can use
  readonly maxToolIterations?: number           // default 5
  readonly maxToolResultChars?: number          // default: 4000
  readonly tags?: ReadonlyArray<string>         // capability/role tags for [[tag:X]] addressing
  readonly thinking?: boolean                    // enable model CoT (qwen3 thinking mode)
  // Context & Prompts toggles — all default true; undefined preserves current behavior
  readonly includePrompts?: IncludePrompts      // per-section prompt inclusion (persona/room/house/responseFormat/skills)
  readonly includeContext?: IncludeContext      // CONTEXT sub-sections (participants/artifacts/activity/knownAgents)
  readonly includeTools?: boolean               // master: send tool definitions to LLM (default: true)
  readonly promptsEnabled?: boolean             // master for all per-section prompt toggles (default: true)
  readonly contextEnabled?: boolean             // master for all context sub-section toggles (default: true)
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
