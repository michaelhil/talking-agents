// ============================================================================
// Shared agent utilities — profile extraction and join metadata.
// ============================================================================

import type { Agent, AgentProfile, Message } from '../core/types.ts'

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
  const description = meta.agentDescription
  const kind = meta.agentKind

  if (typeof name === 'string' && (kind === 'ai' || kind === 'human')) {
    profiles.set(message.senderId, {
      id: message.senderId,
      name,
      description: typeof description === 'string' ? description : '',
      kind,
    })
  }
}

// Build join message metadata from an agent's public fields.
// Used by spawn.ts and actions.ts when posting join messages.
export const makeJoinMetadata = (agent: Agent) => ({
  agentName: agent.name,
  agentDescription: agent.description,
  agentKind: agent.kind,
})
