// ============================================================================
// Talking Agents — Public API
// ============================================================================

// Core types
export type {
  Message,
  MessageType,
  MessageTarget,
  RoomProfile,
  AgentProfile,
  PostParams,
  PostResult,
  Room,
  House,
  RoomConfig,
  Agent,
  Team,
  PostAndDeliver,
  AIAgentConfig,
  AgentResponse,
  AgentAction,
  ChatRequest,
  ChatResponse,
  LLMProvider,
} from './core/types.ts'

export { SYSTEM_SENDER_ID, INTRODUCTIONS_ROOM_ID, DEFAULTS } from './core/types.ts'

// Core factories
export { createRoom } from './core/room.ts'
export { createHouse, initIntroductionsRoom } from './core/house.ts'

// Agent factories
export { createTeam } from './agents/team.ts'
export { createAIAgent } from './agents/ai-agent.ts'
export type { Decision, OnDecision } from './agents/ai-agent.ts'
export { createHumanAgent } from './agents/human-agent.ts'
export type { HumanAgentConfig, TransportSend } from './agents/human-agent.ts'

// Agent wiring
export { spawnAIAgent, spawnHumanAgent } from './agents/spawn.ts'
export { executeActions } from './agents/actions.ts'
export { extractAgentProfile, makeJoinMetadata } from './agents/shared.ts'

// LLM providers
export { createOllamaProvider } from './llm/ollama.ts'
