// ============================================================================
// Context Builder — Assembles LLM context from AgentHistory.
//
// Two-buffer architecture: room-sourced history (old) + incoming buffer (new).
// Messages in incoming are tagged [NEW] so the LLM can prioritise them.
// After evaluation, flushIncoming moves processed messages out of incoming
// and appends them to the relevant RoomContext or DMContext in AgentHistory.
//
// Full history is preserved in AgentHistory; only a historyLimit-sized
// window is passed to the LLM on each context build.
// ============================================================================

import type {
  AgentHistory,
  AgentProfile,
  ChatRequest,
  FlowDeliveryContext,
  Message,
  RoomContext,
  TodoItem,
} from '../core/types.ts'
import { SYSTEM_SENDER_ID } from '../core/types.ts'
import { TOOL_RESPONSE_FORMAT_SUFFIX } from '../tools/format.ts'

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

// === Trigger key — unified string key for generatingContexts/pendingContexts sets ===
// Kept here as it defines the canonical format used in state context strings.

export const triggerKey = (roomId?: string, peerId?: string): string => {
  if (roomId && peerId) throw new Error('triggerKey: roomId and peerId are mutually exclusive')
  return roomId ? `room:${roomId}` : `dm:${peerId}`
}

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
// Moves processed messages from incoming into the appropriate RoomContext or DMContext.
// Full history is preserved (no cap); buildContext slices at historyLimit when reading.

export const flushIncoming = (
  info: FlushInfo,
  history: AgentHistory,
  agentId: string,
): void => {
  if (info.ids.size === 0) return

  const flushed = history.incoming.filter(m => info.ids.has(m.id))
  const remaining = history.incoming.filter(m => !info.ids.has(m.id))
  history.incoming.length = 0
  history.incoming.push(...remaining)

  // Append flushed room messages to RoomContext history
  if (info.triggerRoomId && flushed.length > 0) {
    const ctx = history.rooms.get(info.triggerRoomId)
    if (ctx) {
      ctx.history = [...ctx.history, ...flushed]
      ctx.lastActiveAt = Date.now()
    }
  }

  // Append flushed DMs to DMContext
  for (const msg of info.dmMessages) {
    const peerId = msg.senderId === agentId ? msg.recipientId! : msg.senderId
    if (!peerId) continue
    let ctx = history.dms.get(peerId)
    if (!ctx) {
      ctx = { history: [], lastActiveAt: undefined }
      history.dms.set(peerId, ctx)
    }
    ctx.history.push(msg)
    ctx.lastActiveAt = Date.now()
  }
}

// === Participant list for room context ===

export const getParticipantsForRoom = (
  roomId: string,
  history: AgentHistory,
  agentId: string,
): ReadonlyArray<AgentProfile | string> => {
  const ctx = history.rooms.get(roomId)
  const historyMsgs = ctx?.history ?? []
  const fresh = history.incoming.filter(m => m.roomId === roomId)
  const allMsgs = [...historyMsgs, ...fresh]

  const senderIds = new Set<string>()
  for (const msg of allMsgs) {
    if (msg.senderId !== SYSTEM_SENDER_ID && msg.senderId !== agentId) {
      senderIds.add(msg.senderId)
    }
  }
  return [...senderIds].map(id => history.agentProfiles.get(id) ?? id)
}

// === Format relative time ===

const relativeTime = (ts: number | undefined): string => {
  if (!ts) return 'idle'
  const secs = Math.floor((Date.now() - ts) / 1000)
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  return `${Math.floor(mins / 60)}h ago`
}

// === Build deps ===

export interface BuildContextDeps {
  readonly agentId: string
  readonly systemPrompt: string
  readonly housePrompt?: string
  readonly responseFormat?: string
  readonly history: AgentHistory
  readonly toolDescriptions?: string
  readonly historyLimit: number
  readonly resolveName: (senderId: string) => string
  readonly getRoomTodos?: (roomId: string) => ReadonlyArray<TodoItem>
}

// === Private section builders ===

const buildParticipantsSection = (
  participants: ReadonlyArray<AgentProfile | string>,
): string => {
  const lines = participants.map(p =>
    typeof p === 'string' ? `- ${p}` : `- ${p.name} (${p.kind})`,
  )
  return `Other participants:\n${lines.join('\n')}`
}

const buildTodosSection = (todos: ReadonlyArray<TodoItem>): string => {
  const todoLines = todos.map(t => {
    const check = t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : t.status === 'blocked' ? '!' : ' '
    let line = `- [${check}] ${t.content} [id: ${t.id}]`
    if (t.assignee) line += ` (assigned to: ${t.assignee})`
    line += ` [${t.status}]`
    if (t.result) line += ` → Result: ${t.result}`
    return line
  })
  return `Room todos:\n${todoLines.join('\n')}`
}

const buildFlowSection = (fc: FlowDeliveryContext, stepIndex: number): string => {
  const stepNum = stepIndex + 1
  const loopTag = fc.loop ? ' · loop on' : ''
  const sequenceParts = fc.steps.map((s, i) =>
    i === stepIndex ? `${s.agentName} (you)` : s.agentName,
  )
  if (fc.loop) sequenceParts.push('(repeats)')
  return `Flow: "${fc.flowName}" · step ${stepNum} of ${fc.totalSteps}${loopTag}\nSequence: ${sequenceParts.join(' → ')}`
}

const buildActivitySection = (
  deps: BuildContextDeps,
  triggerRoomId: string | undefined,
  triggerPeerId: string | undefined,
): string => {
  const activityLines: string[] = []

  for (const [roomId, ctx] of deps.history.rooms) {
    if (roomId === triggerRoomId) continue
    const timeStr = relativeTime(ctx.lastActiveAt)
    let line = `- Room "${ctx.profile.name}" [id: ${roomId}]: ${timeStr}`
    if (deps.getRoomTodos) {
      const inProgress = deps.getRoomTodos(roomId).filter(t => t.status === 'in_progress')
      if (inProgress.length > 0) {
        const todoStrs = inProgress.map(t => `"${t.content}" [id: ${t.id}]`).join(', ')
        line += `\n  → In-progress todos: ${todoStrs}`
      }
    }
    activityLines.push(line)
  }

  for (const [peerId, ctx] of deps.history.dms) {
    if (peerId === triggerPeerId) continue
    if (ctx.history.length === 0 && !ctx.lastActiveAt) continue
    const peerName = deps.history.agentProfiles.get(peerId)?.name ?? peerId
    activityLines.push(`- DM with ${peerName} [peerId: ${peerId}]: ${relativeTime(ctx.lastActiveAt)}`)
  }

  return `Your activity in other contexts:\n${activityLines.join('\n')}`
}

const buildSystemMessage = (
  deps: BuildContextDeps,
  triggerRoomId: string | undefined,
  triggerPeerId: string | undefined,
): string => {
  const sections: string[] = []

  if (deps.housePrompt) {
    sections.push(`=== HOUSE RULES ===\n${deps.housePrompt}`)
  }

  if (triggerRoomId) {
    const roomCtx = deps.history.rooms.get(triggerRoomId)
    if (roomCtx?.profile.roomPrompt) {
      sections.push(`=== ROOM: ${roomCtx.profile.name} ===\n${roomCtx.profile.roomPrompt}`)
    }
  }

  sections.push(`=== YOUR IDENTITY ===\n${deps.systemPrompt}`)

  const contextLines: string[] = []

  if (triggerRoomId) {
    const roomCtx = deps.history.rooms.get(triggerRoomId)
    if (roomCtx) {
      contextLines.push(`You are in room "${roomCtx.profile.name}" [id: ${triggerRoomId}].`)
    }

    const freshForRoom = deps.history.incoming.filter(m => m.roomId === triggerRoomId)
    const latestWithFlow = [...freshForRoom].reverse().find(
      m => (m.metadata as Record<string, unknown> | undefined)?.flowContext,
    )
    if (latestWithFlow) {
      const fc = (latestWithFlow.metadata as Record<string, unknown>).flowContext as FlowDeliveryContext
      const triggerMsg = latestWithFlow
      const stepIndex = (triggerMsg.metadata as Record<string, unknown>)?.flowContext
        ? fc.stepIndex
        : 0
      contextLines.push(buildFlowSection(fc, stepIndex))
    }

    const participants = getParticipantsForRoom(triggerRoomId, deps.history, deps.agentId)
    if (participants.length > 0) {
      contextLines.push(buildParticipantsSection(participants))
    }

    if (deps.getRoomTodos) {
      const todos = deps.getRoomTodos(triggerRoomId)
      if (todos.length > 0) {
        contextLines.push(buildTodosSection(todos))
      }
    }
  } else if (triggerPeerId) {
    const peerProfile = deps.history.agentProfiles.get(triggerPeerId)
    const peerName = peerProfile?.name ?? triggerPeerId
    contextLines.push(`This is a direct conversation with ${peerName} [id: ${triggerPeerId}].`)
  }

  const activitySection = buildActivitySection(deps, triggerRoomId, triggerPeerId)
  // Only include if there are actual other contexts listed
  const hasActivity = deps.history.rooms.size > (triggerRoomId ? 1 : 0) ||
    [...deps.history.dms].some(([peerId, ctx]) =>
      peerId !== triggerPeerId && (ctx.history.length > 0 || ctx.lastActiveAt !== undefined),
    )
  if (hasActivity) {
    contextLines.push(activitySection)
  }

  const knownAgents = [...deps.history.agentProfiles.values()].filter(a => a.id !== deps.agentId)
  if (knownAgents.length > 0) {
    const agentNames = knownAgents.map(a => `"${a.name}" (${a.kind})`)
    contextLines.push(`Known agents: ${agentNames.join(', ')}`)
  }

  if (deps.toolDescriptions) {
    contextLines.push(deps.toolDescriptions)
  }

  contextLines.push('Messages marked [NEW] have arrived since you last responded.')

  sections.push(`=== CONTEXT ===\n${contextLines.join('\n\n')}`)

  if (deps.responseFormat) {
    let format = deps.responseFormat
    if (deps.toolDescriptions) {
      format += TOOL_RESPONSE_FORMAT_SUFFIX
    }
    sections.push(`=== RESPONSE FORMAT ===\n${format}`)
  }

  return sections.join('\n\n')
}

// === Build full LLM context ===

export const buildContext = (
  deps: BuildContextDeps,
  triggerRoomId?: string,
  triggerPeerId?: string,
): ContextResult => {
  const flushIds = new Set<string>()
  const flushDMs: Message[] = []

  const systemContent = buildSystemMessage(deps, triggerRoomId, triggerPeerId)

  const chatMessages: ChatRequest['messages'][number][] = [
    { role: 'system' as const, content: systemContent },
  ]

  // Room context: history window (old) + incoming (new)
  if (triggerRoomId) {
    const ctx = deps.history.rooms.get(triggerRoomId)
    const all = ctx?.history ?? []
    // Apply historyLimit window at read time — full history preserved in AgentHistory
    const old = all.length > deps.historyLimit ? all.slice(-deps.historyLimit) : all
    const fresh = deps.history.incoming.filter(m => m.roomId === triggerRoomId)

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

  // DM context: history window (old) + incoming DMs (new)
  if (triggerPeerId) {
    const ctx = deps.history.dms.get(triggerPeerId)
    const all = ctx?.history ?? []
    const old = all.length > deps.historyLimit ? all.slice(-deps.historyLimit) : all
    const fresh = deps.history.incoming.filter(m =>
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
