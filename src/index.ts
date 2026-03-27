// ============================================================================
// samsinn — Public API
// ============================================================================

// Core types
export type {
  Message,
  MessageType,
  MessageTarget,
  RoomProfile,
  AgentProfile,
  PostParams,
  DeliverFn,
  CreateResult,
  Room,
  House,
  RoomConfig,
  Agent,
  AIAgent,
  Team,
  RouteMessage,
  AIAgentConfig,
  AgentResponse,
  AgentAction,
  AgentState,
  StateValue,
  StateSubscriber,
  WSInbound,
  WSOutbound,
  Tool,
  ToolCall,
  ToolResult,
  ToolContext,
  ToolRegistry,
  ToolExecutor,
  ChatRequest,
  ChatResponse,
  LLMProvider,
} from './core/types.ts'

export { SYSTEM_SENDER_ID, DEFAULTS } from './core/types.ts'

// Core factories
export { createRoom } from './core/room.ts'
export { createHouse } from './core/house.ts'
export { createMessageRouter } from './core/delivery.ts'

// Agent factories
export { createTeam } from './agents/team.ts'
export { createAIAgent } from './agents/ai-agent.ts'
export type { AIAgentOptions, Decision, OnDecision } from './agents/ai-agent.ts'
export { createHumanAgent } from './agents/human-agent.ts'
export type { HumanAgent, HumanAgentConfig, TransportSend } from './agents/human-agent.ts'

// Agent internals (for advanced use)
export { buildContext, flushIncoming, triggerKey, formatMessage } from './agents/context-builder.ts'
export type { FlushInfo, ContextResult, BuildContextDeps } from './agents/context-builder.ts'
export { evaluate, parseResponse } from './agents/evaluation.ts'
export type { EvalResult } from './agents/evaluation.ts'

// Agent wiring
export { spawnAIAgent, spawnHumanAgent } from './agents/spawn.ts'
export { addAgentToRoom, executeActions } from './agents/actions.ts'
export { extractAgentProfile, makeJoinMetadata } from './agents/shared.ts'
export { validateName, ensureUniqueName } from './core/names.ts'
export { createToolRegistry } from './core/tool-registry.ts'

// Built-in tools
export { createListRoomsTool, createGetTimeTool, createQueryAgentTool } from './tools/built-in.ts'

// LLM providers
export { createOllamaProvider } from './llm/ollama.ts'

// System + Server
export { createSystem } from './main.ts'
export type { System } from './main.ts'
export { createServer } from './api/server.ts'

// MCP Server
export { createMCPServer, wireEventNotifications, startMCPServerStdio } from './integrations/mcp/server.ts'

// Delivery modes
export type { DeliveryMode, Flow, FlowStep, FlowExecution } from './core/types.ts'
