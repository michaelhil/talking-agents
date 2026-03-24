// ============================================================================
// Context Builder — Assembles LLM context from message buffers.
//
// Two-buffer architecture: room-sourced history (old) + incoming buffer (new).
// Messages in incoming are tagged [NEW] so the LLM can prioritise them.
// After evaluation, flushIncoming moves processed messages out of incoming.
// ============================================================================

import type {
  AgentProfile,
  ChatRequest,
  Message,
  RoomProfile,
} from '../core/types.ts'
import { SYSTEM_SENDER_ID } from '../core/types.ts'

// === Flush info — describes which incoming messages were consumed ===

export interface FlushInfo {
  readonly ids: Set<string>
  readonly dmMessages: Message[]
  readonly triggerRoomId?: string
}

// === Context result — ready for LLM consumption ===

export interface ContextResult {
  readonly messages: ChatRequest['messages']
  readonly flushInfo: FlushInfo
}

// === Trigger key — unified identifier for rooms and DM peers ===

export const triggerKey = (roomId?: string, peerId?: string): string =>
  roomId ? `room:${roomId}` : `dm:${peerId}`

// === Format a single message for LLM context ===

export const formatMessage = (
  msg: Message,
  prefix: string,
  agentId: string,
  resolveName: (senderId: string) => string,
): { role: 'user' | 'assistant'; content: string } | null => {
  if (msg.type === 'system' || msg.type === 'join' || msg.type === 'leave' || msg.type === 'pass') return null
  if (msg.senderId === agentId) {
    return { role: 'assistant' as const, content: msg.content }
  }
  const name = resolveName(msg.senderId)
  return { role: 'user' as const, content: `${prefix}[${name}]: ${msg.content}` }
}

// === Flush incoming buffer after evaluation ===

export const flushIncoming = (
  info: FlushInfo,
  incoming: Message[],
  roomHistory: Map<string, ReadonlyArray<Message>>,
  addDMMessage: (msg: Message) => void,
): void => {
  if (info.ids.size === 0) return

  // Collect flushed messages before removing
  const flushed = incoming.filter(m => info.ids.has(m.id))

  // Remove from incoming
  const remaining = incoming.filter(m => !info.ids.has(m.id))
  incoming.length = 0
  incoming.push(...remaining)

  // Append flushed room messages to history snapshot for re-eval continuity
  if (info.triggerRoomId && flushed.length > 0) {
    const key = triggerKey(info.triggerRoomId, undefined)
    const current = roomHistory.get(key) ?? []
    roomHistory.set(key, [...current, ...flushed])
  }

  // Move flushed DMs to persistent DM store
  for (const msg of info.dmMessages) {
    addDMMessage(msg)
  }
}

// === Participant list for room context ===

export const getParticipantsForRoom = (
  roomId: string,
  incoming: ReadonlyArray<Message>,
  roomHistory: Map<string, ReadonlyArray<Message>>,
  agentId: string,
  agentProfiles: Map<string, AgentProfile>,
): ReadonlyArray<AgentProfile | string> => {
  const key = triggerKey(roomId, undefined)
  const history = roomHistory.get(key) ?? []
  const fresh = incoming.filter(m => m.roomId === roomId)
  const allMsgs = [...history, ...fresh]

  const senderIds = new Set<string>()
  for (const msg of allMsgs) {
    if (msg.senderId !== SYSTEM_SENDER_ID && msg.senderId !== agentId) {
      senderIds.add(msg.senderId)
    }
  }
  return [...senderIds].map(id => agentProfiles.get(id) ?? id)
}

// === Build full LLM context ===

export interface BuildContextDeps {
  readonly agentId: string
  readonly systemPrompt: string
  readonly incoming: Message[]
  readonly roomHistory: Map<string, ReadonlyArray<Message>>
  readonly roomProfiles: Map<string, RoomProfile>
  readonly agentProfiles: Map<string, AgentProfile>
  readonly toolDescriptions?: string
  readonly historyLimit: number
  readonly resolveName: (senderId: string) => string
  readonly getDMMessagesForPeer: (peerId: string) => ReadonlyArray<Message>
}

export const buildContext = (
  deps: BuildContextDeps,
  triggerRoomId?: string,
  triggerPeerId?: string,
): ContextResult => {
  const flushIds = new Set<string>()
  const flushDMs: Message[] = []
  let systemContent = deps.systemPrompt

  // Current conversation context
  if (triggerRoomId) {
    const roomProfile = deps.roomProfiles.get(triggerRoomId)
    if (roomProfile) {
      systemContent += `\n\nYou are in room "${roomProfile.name}".`
      if (roomProfile.description) systemContent += ` ${roomProfile.description}`
      if (roomProfile.roomPrompt) systemContent += `\n\nRoom instructions: ${roomProfile.roomPrompt}`
    }

    const participants = getParticipantsForRoom(
      triggerRoomId, deps.incoming, deps.roomHistory, deps.agentId, deps.agentProfiles,
    )
    if (participants.length > 0) {
      const lines = participants.map(p =>
        typeof p === 'string' ? `- ${p}` : `- ${p.name} (${p.kind})`,
      )
      systemContent += `\n\nOther participants:\n${lines.join('\n')}`
    }
  } else if (triggerPeerId) {
    const peerProfile = deps.agentProfiles.get(triggerPeerId)
    const peerName = peerProfile?.name ?? triggerPeerId
    systemContent += `\n\nThis is a direct conversation with ${peerName}.`
    if (peerProfile?.description) systemContent += ` ${peerProfile.description}`
  }

  // Available rooms
  if (deps.roomProfiles.size > 0) {
    const roomNames = [...deps.roomProfiles.values()].map(p => `"${p.name}"`)
    systemContent += `\n\nYour rooms: ${roomNames.join(', ')}`
  }

  // Known agents
  const knownAgents = [...deps.agentProfiles.values()].filter(a => a.id !== deps.agentId)
  if (knownAgents.length > 0) {
    const agentNames = knownAgents.map(a => `"${a.name}" (${a.kind})`)
    systemContent += `\nKnown agents: ${agentNames.join(', ')}`
  }

  // Tool descriptions
  if (deps.toolDescriptions) {
    systemContent += `\n\n${deps.toolDescriptions}`
  }

  // Response format — plain text protocol
  systemContent += `\n\nResponse format:
- By default, just write your message as natural text. Your response IS the message others will read.
- To stay silent, start your response with exactly ::PASS:: followed by a brief reason.
  Example: ::PASS:: This question was already answered by someone else
- Never wrap your response in JSON, code blocks, or data structures.`

  if (deps.toolDescriptions) {
    systemContent += `\n- To use a tool, write ONLY ::TOOL:: followed by the tool name on its own line. Do not write anything else — just the tool call. Add JSON arguments after the name if needed.
  Example: ::TOOL:: get_time
  Example: ::TOOL:: query_agent {"target": "Alice", "question": "status?"}
  You may call multiple tools, one ::TOOL:: per line. After tools run you will receive results and should then write a normal response.
- IMPORTANT: You do NOT have access to real-time information like the current time or date. When asked about these, you MUST use the appropriate tool. Never guess or make up values for information a tool can provide.`
  }

  systemContent += `\n\nMessages marked [NEW] have arrived since you last responded. Prioritise responding to these. Always respond to direct questions or messages addressed to you. Use ::PASS:: only when the conversation genuinely does not need your input.`

  // Build message array
  const chatMessages: ChatRequest['messages'][number][] = [
    { role: 'system' as const, content: systemContent },
  ]

  // Room context: history (old) + incoming (new)
  if (triggerRoomId) {
    const key = triggerKey(triggerRoomId, undefined)
    const old = deps.roomHistory.get(key) ?? []
    const fresh = deps.incoming.filter(m => m.roomId === triggerRoomId)

    for (const msg of old) {
      const formatted = formatMessage(msg, '', deps.agentId, deps.resolveName)
      if (formatted) chatMessages.push(formatted)
    }
    for (const msg of fresh) {
      const formatted = formatMessage(msg, '[NEW] ', deps.agentId, deps.resolveName)
      if (formatted) chatMessages.push(formatted)
      flushIds.add(msg.id)
    }
  }

  // DM context: local DM history (old) + incoming DMs (new)
  if (triggerPeerId) {
    const old = deps.getDMMessagesForPeer(triggerPeerId)
    const fresh = deps.incoming.filter(m =>
      m.roomId === undefined && (m.senderId === triggerPeerId || m.recipientId === triggerPeerId),
    )

    for (const msg of old) {
      const formatted = formatMessage(msg, '', deps.agentId, deps.resolveName)
      if (formatted) chatMessages.push(formatted)
    }
    for (const msg of fresh) {
      const formatted = formatMessage(msg, '[NEW] ', deps.agentId, deps.resolveName)
      if (formatted) chatMessages.push(formatted)
      flushIds.add(msg.id)
      flushDMs.push(msg)
    }
  }

  return {
    messages: chatMessages,
    flushInfo: { ids: flushIds, dmMessages: flushDMs, triggerRoomId },
  }
}
