// ============================================================================
// Context Builder — Assembles LLM context from AgentHistory.
//
// Two-buffer architecture: room-sourced history (old) + incoming buffer (new).
// Messages in incoming are tagged [NEW] so the LLM can prioritise them.
// After evaluation, flushIncoming moves processed messages out of incoming
// and appends them to the relevant RoomContext in AgentHistory.
//
// Full history is preserved in AgentHistory; only a historyLimit-sized
// window is passed to the LLM on each context build.
// ============================================================================

import type {
  Artifact,
  ArtifactTypeDefinition,
  AgentHistory,
  AgentProfile,
  ChatRequest,
  FlowDeliveryContext,
  Message,
} from '../core/types.ts'
import { SYSTEM_SENDER_ID } from '../core/types.ts'
// Text tool protocol removed — all tools use native tool calling

// === Flush info — describes which incoming messages were consumed ===

export interface FlushInfo {
  readonly ids: Set<string>
  readonly triggerRoomId: string
}

// === Context result — ready for LLM consumption ===

export interface ContextResult {
  readonly messages: ChatRequest['messages']
  readonly flushInfo: FlushInfo
  readonly warnings: ReadonlyArray<string>
}

// === Format a single message for LLM context ===

export const formatMessage = (
  msg: Message,
  prefix: string,
  agentId: string,
  resolveName: (senderId: string) => string,
  compressedIds?: ReadonlySet<string>,
): { role: 'user' | 'assistant'; content: string } | null => {
  if (msg.type === 'system' || msg.type === 'join' || msg.type === 'leave' || msg.type === 'pass' || msg.type === 'mute') return null
  const stepPrompt = (msg.metadata as Record<string, unknown> | undefined)?.stepPrompt as string | undefined
  if (msg.senderId === agentId) {
    const staleRef = compressedIds && msg.inReplyTo?.some(id => compressedIds.has(id))
    const suffix = staleRef ? '\n[↩ context compressed]' : ''
    return { role: 'assistant' as const, content: `${msg.content}${suffix}` }
  }
  const name = resolveName(msg.senderId)
  const stepLine = stepPrompt ? `\n[Step instruction: ${stepPrompt}]` : ''
  return { role: 'user' as const, content: `${prefix}[${name}]: ${msg.content}${stepLine}` }
}

// === Flush incoming buffer after evaluation ===

export const flushIncoming = (
  info: FlushInfo,
  history: AgentHistory,
): void => {
  if (info.ids.size === 0) return

  const flushed = history.incoming.filter(m => info.ids.has(m.id))
  const remaining = history.incoming.filter(m => !info.ids.has(m.id))
  history.incoming.length = 0
  history.incoming.push(...remaining)

  if (flushed.length > 0) {
    const ctx = history.rooms.get(info.triggerRoomId)
    if (ctx) {
      ctx.history = [...ctx.history, ...flushed]
      ctx.lastActiveAt = Date.now()
    }
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
  readonly getSkills?: (roomName: string) => string
  readonly historyLimit: number
  readonly resolveName: (senderId: string) => string
  readonly getArtifactsForScope?: (roomId: string) => ReadonlyArray<Artifact>
  readonly getArtifactTypeDef?: (type: string) => ArtifactTypeDefinition | undefined
  readonly getCompressedIds?: (roomId: string) => ReadonlySet<string>
}

// === Private section builders ===

const buildParticipantsSection = (
  participants: ReadonlyArray<AgentProfile | string>,
): string => {
  const lines = participants.map(p => {
    if (typeof p === 'string') return `- ${p}`
    const tagStr = p.tags && p.tags.length > 0 ? ` [tags: ${p.tags.join(', ')}]` : ''
    return `- ${p.name} (${p.kind})${tagStr}`
  })
  return `Other participants:\n${lines.join('\n')}`
}

const formatArtifact = (artifact: Artifact, getTypeDef?: (type: string) => ArtifactTypeDefinition | undefined): string => {
  const typeDef = getTypeDef?.(artifact.type)
  if (typeDef?.formatForContext) return typeDef.formatForContext(artifact)
  // Generic fallback
  return `${artifact.type}: "${artifact.title}" [id: ${artifact.id}]`
}

const buildArtifactsSection = (
  artifacts: ReadonlyArray<Artifact>,
  getTypeDef?: (type: string) => ArtifactTypeDefinition | undefined,
): string => {
  if (artifacts.length === 0) return ''
  const lines = artifacts.map(a => formatArtifact(a, getTypeDef))
  return `Room artifacts:\n${lines.join('\n\n')}`
}

const buildFlowSection = (fc: FlowDeliveryContext, stepIndex: number): string => {
  const stepNum = stepIndex + 1
  const loopTag = fc.loop ? ' · loop on' : ''
  const sequenceParts = fc.steps.map((s, i) =>
    i === stepIndex ? `${s.agentName} (you)` : s.agentName,
  )
  if (fc.loop) sequenceParts.push('(repeats)')
  const lines = [`Flow: "${fc.flowName}" · step ${stepNum} of ${fc.totalSteps}${loopTag}`]
  if (fc.artifactDescription) lines.push(`Purpose: ${fc.artifactDescription}`)
  if (fc.goalChain && fc.goalChain.length > 1) {
    lines.push(`Goal context: ${fc.goalChain.join(' → ')}`)
  }
  lines.push(`Sequence: ${sequenceParts.join(' → ')}`)
  return lines.join('\n')
}

const buildActivitySection = (
  deps: BuildContextDeps,
  triggerRoomId: string,
): string => {
  const activityLines: string[] = []

  for (const [roomId, ctx] of deps.history.rooms) {
    if (roomId === triggerRoomId) continue
    const timeStr = relativeTime(ctx.lastActiveAt)
    activityLines.push(`- Room "${ctx.profile.name}" [id: ${roomId}]: ${timeStr}`)
  }

  return `Your activity in other contexts:\n${activityLines.join('\n')}`
}

const buildSystemMessage = (
  deps: BuildContextDeps,
  triggerRoomId: string,
): string => {
  const sections: string[] = []

  if (deps.housePrompt) {
    sections.push(`=== HOUSE RULES ===\n${deps.housePrompt}`)
  }

  const roomCtx = deps.history.rooms.get(triggerRoomId)
  if (roomCtx?.profile.roomPrompt) {
    sections.push(`=== ROOM: ${roomCtx.profile.name} ===\n${roomCtx.profile.roomPrompt}`)
  }

  sections.push(`=== YOUR IDENTITY ===\n${deps.systemPrompt}`)

  if (deps.getSkills) {
    const roomName = roomCtx?.profile.name ?? ''
    const skillsSection = deps.getSkills(roomName)
    if (skillsSection) {
      sections.push(`=== SKILLS ===\n${skillsSection}`)
    }
  }

  const contextLines: string[] = []

  if (roomCtx) {
    contextLines.push(`You are in room "${roomCtx.profile.name}" [id: ${triggerRoomId}].`)
  }

  const freshForRoom = deps.history.incoming.filter(m => m.roomId === triggerRoomId)
  const latestWithFlow = [...freshForRoom].reverse().find(
    m => (m.metadata as Record<string, unknown> | undefined)?.flowContext,
  )
  if (latestWithFlow) {
    const fc = (latestWithFlow.metadata as Record<string, unknown>).flowContext as FlowDeliveryContext
    contextLines.push(buildFlowSection(fc, fc.stepIndex))
  }

  const participants = getParticipantsForRoom(triggerRoomId, deps.history, deps.agentId)
  if (participants.length > 0) {
    contextLines.push(buildParticipantsSection(participants))
  }

  // Artifacts scoped to this room (system-wide artifacts excluded from per-room context)
  if (deps.getArtifactsForScope) {
    const artifacts = deps.getArtifactsForScope(triggerRoomId)
    const artifactsSection = buildArtifactsSection(artifacts, deps.getArtifactTypeDef)
    if (artifactsSection) contextLines.push(artifactsSection)
  }

  if (deps.history.rooms.size > 1) {
    contextLines.push(buildActivitySection(deps, triggerRoomId))
  }

  const knownAgents = [...deps.history.agentProfiles.values()].filter(a => a.id !== deps.agentId)
  if (knownAgents.length > 0) {
    const agentNames = knownAgents.map(a => `"${a.name}" (${a.kind})`)
    contextLines.push(`Known agents: ${agentNames.join(', ')}`)
  }

  contextLines.push('Messages marked [NEW] have arrived since you last responded.')

  sections.push(`=== CONTEXT ===\n${contextLines.join('\n\n')}`)

  if (deps.responseFormat) {
    sections.push(`=== RESPONSE FORMAT ===\n${deps.responseFormat}`)
  }

  return sections.join('\n\n')
}

// === Token estimation ===
// Rough heuristic: ~4 characters per token for English text.
// Tool definitions with JSON schema are denser; this is a conservative estimate.

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

// === Build full LLM context ===

// Context budget: 8000 tokens for system message + history, within 16384 num_ctx.
// Remaining budget covers native tool definitions (~2000) + generation output (~2000).
const DEFAULT_MAX_CONTEXT_TOKENS = 8000

export const buildContext = (
  deps: BuildContextDeps,
  triggerRoomId: string,
  maxContextTokens = DEFAULT_MAX_CONTEXT_TOKENS,
): ContextResult => {
  const flushIds = new Set<string>()

  const systemContent = buildSystemMessage(deps, triggerRoomId)

  const chatMessages: ChatRequest['messages'][number][] = [
    { role: 'system' as const, content: systemContent },
  ]

  const ctx = deps.history.rooms.get(triggerRoomId)
  const all = ctx?.history ?? []
  const old = all.length > deps.historyLimit ? all.slice(-deps.historyLimit) : all
  const fresh = deps.history.incoming.filter(m => m.roomId === triggerRoomId)
  const roomCompressedIds = deps.getCompressedIds?.(triggerRoomId)

  // Format all candidate messages
  const formattedOld: ChatRequest['messages'][number][] = []
  for (const msg of old) {
    const formatted = formatMessage(msg, '', deps.agentId, deps.resolveName, roomCompressedIds)
    if (formatted) formattedOld.push(formatted)
  }

  const formattedFresh: Array<{ formatted: ChatRequest['messages'][number]; id: string }> = []
  for (const msg of fresh) {
    const formatted = formatMessage(msg, '[NEW] ', deps.agentId, deps.resolveName, roomCompressedIds)
    if (formatted) formattedFresh.push({ formatted, id: msg.id })
  }

  // Context budget: system + fresh messages are mandatory; trim old messages to fit
  const systemTokens = estimateTokens(systemContent)
  const freshTokens = formattedFresh.reduce((sum, f) => sum + estimateTokens(f.formatted.content), 0)
  const budgetForOld = maxContextTokens - systemTokens - freshTokens

  const warnings: string[] = []
  let trimmedOld = formattedOld
  if (budgetForOld > 0) {
    // Trim from oldest (front) until within budget
    let oldTokens = formattedOld.reduce((sum, m) => sum + estimateTokens(m.content), 0)
    while (trimmedOld.length > 0 && oldTokens > budgetForOld) {
      const removed = trimmedOld.shift()
      if (removed) oldTokens -= estimateTokens(removed.content)
    }
    if (trimmedOld.length < formattedOld.length) {
      const dropped = formattedOld.length - trimmedOld.length
      warnings.push(`Context trimmed: dropped ${dropped} old messages to fit ${maxContextTokens} token budget`)
    }
  } else {
    // System + fresh alone exceed budget — skip all old messages
    trimmedOld = []
    if (formattedOld.length > 0) {
      warnings.push(`Context budget exceeded by system+fresh alone — all old messages dropped`)
    }
  }

  chatMessages.push(...trimmedOld)
  for (const f of formattedFresh) {
    chatMessages.push(f.formatted)
    flushIds.add(f.id)
  }

  return {
    messages: chatMessages,
    flushInfo: { ids: flushIds, triggerRoomId },
    warnings,
  }
}
