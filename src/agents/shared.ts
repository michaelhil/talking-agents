// ============================================================================
// Shared agent utilities — profile extraction and join metadata.
// ============================================================================

import type { Agent, AIAgent, AgentProfile, Message } from '../core/types.ts'

// Extract agent profile from a join message's metadata.
// Called by both AI and human agents in receive() and join().
export const extractAgentProfile = (
  message: Message,
  ownId: string,
  profiles: Map<string, AgentProfile>,
): void => {
  if (message.type !== 'join' || !message.metadata) return
  if (message.senderId === ownId) return

  const meta = message.metadata
  const name = meta.agentName
  const kind = meta.agentKind

  if (typeof name === 'string' && (kind === 'ai' || kind === 'human')) {
    const tags = Array.isArray(meta.agentTags) ? (meta.agentTags as ReadonlyArray<string>) : undefined
    profiles.set(message.senderId, {
      id: message.senderId,
      name,
      kind,
      ...(tags ? { tags } : {}),
    })
  }
}

// Build join message metadata from an agent's public fields.
// Used by spawn.ts and actions.ts when posting join messages.
export const makeJoinMetadata = (agent: Agent) => {
  const tags = agent.metadata?.tags as ReadonlyArray<string> | undefined
  return {
    agentName: agent.name,
    agentKind: agent.kind,
    ...(tags && tags.length > 0 ? { agentTags: tags } : {}),
  }
}

// Type-safe AI agent narrowing. Returns AIAgent if kind === 'ai', undefined otherwise.
// Use instead of manual `agent.kind === 'ai'` + `as AIAgent` casts.
export const asAIAgent = (agent: Agent): AIAgent | undefined =>
  agent.kind === 'ai' ? agent as AIAgent : undefined
