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
  TodoItem,
} from '../core/types.ts'
import { SYSTEM_SENDER_ID } from '../core/types.ts'
import { DEFAULT_RESPONSE_FORMAT_TOOLS } from '../core/house.ts'

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
  if (msg.type === 'system' || msg.type === 'join' || msg.type === 'leave' || msg.type === 'pass' || msg.type === 'mute') return null
  const stepPrompt = (msg.metadata as Record<string, unknown> | undefined)?.stepPrompt as string | undefined
  if (msg.senderId === agentId) {
    return { role: 'assistant' as const, content: msg.content }
  }
  const name = resolveName(msg.senderId)
  const stepLine = stepPrompt ? `\n[Step instruction: ${stepPrompt}]` : ''
  return { role: 'user' as const, content: `${prefix}[${name}]: ${msg.content}${stepLine}` }
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
  readonly housePrompt?: string
  readonly responseFormat?: string
  readonly incoming: Message[]
  readonly roomHistory: Map<string, ReadonlyArray<Message>>
  readonly roomProfiles: Map<string, RoomProfile>
  readonly agentProfiles: Map<string, AgentProfile>
  readonly toolDescriptions?: string
  readonly historyLimit: number
  readonly resolveName: (senderId: string) => string
  readonly getDMMessagesForPeer: (peerId: string) => ReadonlyArray<Message>
  readonly getRoomTodos?: (roomId: string) => ReadonlyArray<TodoItem>
}

export const buildContext = (
  deps: BuildContextDeps,
  triggerRoomId?: string,
  triggerPeerId?: string,
): ContextResult => {
  const flushIds = new Set<string>()
  const flushDMs: Message[] = []
  const sections: string[] = []

  // === HOUSE RULES === (global behavioral guidance)
  if (deps.housePrompt) {
    sections.push(`=== HOUSE RULES ===\n${deps.housePrompt}`)
  }

  // === ROOM === (contextual instructions)
  if (triggerRoomId) {
    const roomProfile = deps.roomProfiles.get(triggerRoomId)
    if (roomProfile?.roomPrompt) {
      sections.push(`=== ROOM: ${roomProfile.name} ===\n${roomProfile.roomPrompt}`)
    }
  }

  // === YOUR IDENTITY === (agent-specific personality/expertise)
  sections.push(`=== YOUR IDENTITY ===\n${deps.systemPrompt}`)

  // === CONTEXT === (auto-generated, not editable)
  const contextLines: string[] = []

  if (triggerRoomId) {
    const roomProfile = deps.roomProfiles.get(triggerRoomId)
    if (roomProfile) {
      contextLines.push(`You are in room "${roomProfile.name}".`)
    }

    const participants = getParticipantsForRoom(
      triggerRoomId, deps.incoming, deps.roomHistory, deps.agentId, deps.agentProfiles,
    )
    if (participants.length > 0) {
      const lines = participants.map(p =>
        typeof p === 'string' ? `- ${p}` : `- ${p.name} (${p.kind})`,
      )
      contextLines.push(`Other participants:\n${lines.join('\n')}`)
    }

    // Room todos
    if (deps.getRoomTodos) {
      const todos = deps.getRoomTodos(triggerRoomId)
      if (todos.length > 0) {
        const todoLines = todos.map(t => {
          const check = t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : t.status === 'blocked' ? '!' : ' '
          let line = `- [${check}] ${t.content}`
          if (t.assignee) line += ` (assigned to: ${t.assignee})`
          line += ` [${t.status}]`
          if (t.result) line += ` → Result: ${t.result}`
          return line
        })
        contextLines.push(`Room todos:\n${todoLines.join('\n')}`)
      }
    }
  } else if (triggerPeerId) {
    const peerProfile = deps.agentProfiles.get(triggerPeerId)
    const peerName = peerProfile?.name ?? triggerPeerId
    contextLines.push(`This is a direct conversation with ${peerName}.`)
  }

  if (deps.roomProfiles.size > 0) {
    const roomNames = [...deps.roomProfiles.values()].map(p => `"${p.name}"`)
    contextLines.push(`Your rooms: ${roomNames.join(', ')}`)
  }

  const knownAgents = [...deps.agentProfiles.values()].filter(a => a.id !== deps.agentId)
  if (knownAgents.length > 0) {
    const agentNames = knownAgents.map(a => `"${a.name}" (${a.kind})`)
    contextLines.push(`Known agents: ${agentNames.join(', ')}`)
  }

  if (deps.toolDescriptions) {
    contextLines.push(deps.toolDescriptions)
  }

  contextLines.push('Messages marked [NEW] have arrived since you last responded.')

  sections.push(`=== CONTEXT ===\n${contextLines.join('\n\n')}`)

  // === RESPONSE FORMAT === (editable protocol conventions)
  if (deps.responseFormat) {
    let format = deps.responseFormat
    if (deps.toolDescriptions) {
      format += DEFAULT_RESPONSE_FORMAT_TOOLS
    }
    sections.push(`=== RESPONSE FORMAT ===\n${format}`)
  }

  const systemContent = sections.join('\n\n')

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
