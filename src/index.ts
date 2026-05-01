// ============================================================================
// samsinn — Public API
// ============================================================================

// Core types
export type {
  Message, MessageType, MessageTarget, RoomProfile, AgentProfile, PostParams, DeliverFn,
} from './core/types/messaging.ts'
export type { CreateResult, Room, House, RoomConfig } from './core/types/room.ts'
export type {
  Agent, AIAgent, Team, RouteMessage, AIAgentConfig, AgentResponse, AgentState, StateValue, StateSubscriber,
} from './core/types/agent.ts'
export type { WSInbound, WSOutbound } from './core/types/ws-protocol.ts'
export type { Tool, ToolCall, ToolResult, ToolContext, ToolRegistry, ToolExecutor } from './core/types/tool.ts'
export type { ChatRequest, ChatResponse, LLMProvider } from './core/types/llm.ts'

export { SYSTEM_SENDER_ID, DEFAULTS } from './core/types/constants.ts'

// Core factories
export { createRoom } from './core/rooms/room.ts'
export { createHouse } from './core/house.ts'
export { createMessageRouter } from './core/delivery.ts'

// Agent factories
export { createTeam } from './agents/team.ts'
export { createAIAgent } from './agents/ai-agent.ts'
export type { AIAgentOptions, Decision, OnDecision } from './agents/ai-agent.ts'
export { createHumanAgent } from './agents/human-agent.ts'
export type { HumanAgent, HumanAgentConfig, TransportSend } from './agents/human-agent.ts'

// Agent internals (for advanced use) — @internal, subject to change
export { buildContext, flushIncoming, formatMessage } from './agents/context-builder.ts'
export type { FlushInfo, ContextResult, BuildContextDeps } from './agents/context-builder.ts'
export { evaluate } from './agents/evaluation.ts'
export type { EvalResult } from './agents/evaluation.ts'

// Agent wiring — @internal helpers exposed for testing and custom runtimes
export { spawnAIAgent, spawnHumanAgent } from './agents/spawn.ts'
export { addAgentToRoom, removeAgentFromRoom } from './agents/actions.ts'
export { extractAgentProfile, makeJoinFields } from './agents/shared.ts'
export { validateName, ensureUniqueName } from './core/names.ts'
export { createToolRegistry } from './core/tool-registry.ts'

// Built-in tools
export { createListRoomsTool, createGetTimeTool } from './tools/built-in/index.ts'

// LLM providers
export { createOllamaProvider } from './llm/ollama.ts'

// System + Server
export { createSystem } from './main.ts'
export type { System } from './main.ts'
export { createServer } from './api/server.ts'

// MCP Server
export { createMCPServer, wireEventNotifications, startMCPServerStdio } from './integrations/mcp/server.ts'

// Delivery modes
export type { DeliveryMode } from './core/types/messaging.ts'
