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

import type { Artifact, ArtifactTypeDefinition } from '../core/types/artifact.ts'
import type { AgentHistory, AgentProfile, Message } from '../core/types/messaging.ts'
import type { ChatRequest } from '../core/types/llm.ts'
import type { FlowDeliveryContext } from '../core/types/flow.ts'
import type { IncludeContext, IncludePrompts } from '../core/types/agent.ts'
import { SYSTEM_SENDER_ID } from '../core/types/constants.ts'
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
  // Structured system-prompt blocks, stable blocks first. Forwarded as
  // ChatRequest.systemBlocks so Anthropic can attach cache_control markers.
  readonly systemBlocks?: ReadonlyArray<{ readonly text: string; readonly cacheable: boolean }>
}

// === Format a single message for LLM context ===

export const formatMessage = (
  msg: Message,
  prefix: string,
  agentId: string,
  resolveName: (senderId: string) => string,
  compressedIds?: ReadonlySet<string>,
  includeFlowStepPrompt: boolean = true,
): { role: 'user' | 'assistant'; content: string } | null => {
  if (msg.type === 'system' || msg.type === 'join' || msg.type === 'leave' || msg.type === 'pass' || msg.type === 'mute') return null
  const stepPrompt = (msg.metadata as Record<string, unknown> | undefined)?.stepPrompt as string | undefined
  if (msg.senderId === agentId) {
    const staleRef = compressedIds && msg.inReplyTo?.some(id => compressedIds.has(id))
    const suffix = staleRef ? '\n[↩ context compressed]' : ''
    return { role: 'assistant' as const, content: `${msg.content}${suffix}` }
  }
  const name = resolveName(msg.senderId)
  const stepLine = stepPrompt && includeFlowStepPrompt ? `\n[Step instruction: ${stepPrompt}]` : ''
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
  readonly includePrompts?: IncludePrompts       // undefined = all on; missing keys = on
  readonly includeContext?: IncludeContext       // CONTEXT sub-section toggles
  readonly includeFlowStepPrompt?: boolean       // suffix on flow messages; default true
  readonly maxHistoryChars?: number              // optional char cap for old messages
  readonly maxContextTokens?: number             // budget for system+history; undefined → caller default
}

const resolveIncludes = (inc: IncludePrompts | undefined): Required<IncludePrompts> => ({
  agent: inc?.agent ?? true,
  room: inc?.room ?? true,
  house: inc?.house ?? true,
  responseFormat: inc?.responseFormat ?? true,
  skills: inc?.skills ?? true,
})

const resolveIncludeContext = (inc: IncludeContext | undefined): Required<IncludeContext> => ({
  participants: inc?.participants ?? true,
  flow: inc?.flow ?? true,
  artifacts: inc?.artifacts ?? true,
  activity: inc?.activity ?? true,
  knownAgents: inc?.knownAgents ?? true,
})

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
  // NOTE: timestamps intentionally omitted. Relative times ("5 minutes ago")
  // change every minute and break prompt-prefix caching (both Gemini implicit
  // and Anthropic explicit). If the agent needs recency, surface it through
  // the incoming/history messages — those already carry timestamps and sit
  // *after* the cacheable prefix.
  const activityLines: string[] = []
  for (const [roomId, ctx] of deps.history.rooms) {
    if (roomId === triggerRoomId) continue
    activityLines.push(`- "${ctx.profile.name}" [id: ${roomId}]`)
  }
  if (activityLines.length === 0) return ''
  return `Your other rooms:\n${activityLines.join('\n')}`
}

// === System-message section model ===
// Each section is the atomic unit of the LLM system message: a labelled block
// of text that is either included or suppressed. `buildSystemSections` is the
// single source of truth — the context-preview API and the serialized prompt
// both derive from it.
export interface SystemSection {
  readonly key: SystemSectionKey
  readonly label: string
  readonly text: string
  readonly enabled: boolean
  readonly optional: boolean   // gated by a user toggle (false = always emitted)
}

export type SystemSectionKey =
  | 'house' | 'room' | 'agent' | 'responseFormat' | 'skills'
  | 'ctx_intro'       // "You are in room X" — always emitted
  | 'ctx_flow'
  | 'ctx_participants'
  | 'ctx_artifacts'
  | 'ctx_activity'
  | 'ctx_knownAgents'
  | 'ctx_newHint'     // "[NEW] hint" — always emitted

export const buildSystemSections = (
  deps: BuildContextDeps,
  triggerRoomId: string,
): ReadonlyArray<SystemSection> => {
  const includes = resolveIncludes(deps.includePrompts)
  const ctxIncludes = resolveIncludeContext(deps.includeContext)
  const roomCtx = deps.history.rooms.get(triggerRoomId)
  const out: SystemSection[] = []

  out.push({
    key: 'house',
    label: 'HOUSE RULES',
    text: deps.housePrompt ?? '',
    enabled: includes.house && !!deps.housePrompt,
    optional: true,
  })

  out.push({
    key: 'room',
    label: `ROOM: ${roomCtx?.profile.name ?? ''}`,
    text: roomCtx?.profile.roomPrompt ?? '',
    enabled: includes.room && !!roomCtx?.profile.roomPrompt,
    optional: true,
  })

  out.push({
    key: 'agent',
    label: 'YOUR IDENTITY',
    text: deps.systemPrompt,
    enabled: includes.agent,
    optional: true,
  })

  const skillsText = deps.getSkills ? deps.getSkills(roomCtx?.profile.name ?? '') : ''
  out.push({
    key: 'skills',
    label: 'SKILLS',
    text: skillsText,
    enabled: includes.skills && !!skillsText,
    optional: true,
  })

  // CONTEXT sub-sections. `ctx_intro` and `ctx_newHint` are always-on
  // scaffolding. The other four are toggleable.
  out.push({
    key: 'ctx_intro',
    label: 'CONTEXT_INTRO',
    text: roomCtx ? `You are in room "${roomCtx.profile.name}" [id: ${triggerRoomId}].` : '',
    enabled: !!roomCtx,
    optional: false,
  })

  const freshForRoom = deps.history.incoming.filter(m => m.roomId === triggerRoomId)
  const latestWithFlow = [...freshForRoom].reverse().find(
    m => (m.metadata as Record<string, unknown> | undefined)?.flowContext,
  )
  const flowText = latestWithFlow
    ? buildFlowSection(
        (latestWithFlow.metadata as Record<string, unknown>).flowContext as FlowDeliveryContext,
        ((latestWithFlow.metadata as Record<string, unknown>).flowContext as FlowDeliveryContext).stepIndex,
      )
    : ''
  out.push({
    key: 'ctx_flow',
    label: 'Flow',
    text: flowText,
    enabled: ctxIncludes.flow && !!flowText,
    optional: true,
  })

  const participants = getParticipantsForRoom(triggerRoomId, deps.history, deps.agentId)
  out.push({
    key: 'ctx_participants',
    label: 'Participants',
    text: participants.length > 0 ? buildParticipantsSection(participants) : '',
    enabled: ctxIncludes.participants && participants.length > 0,
    optional: true,
  })

  const artifacts = deps.getArtifactsForScope ? deps.getArtifactsForScope(triggerRoomId) : []
  const artifactsText = artifacts.length > 0 ? buildArtifactsSection(artifacts, deps.getArtifactTypeDef) : ''
  out.push({
    key: 'ctx_artifacts',
    label: 'Artifacts',
    text: artifactsText,
    enabled: ctxIncludes.artifacts && !!artifactsText,
    optional: true,
  })

  const activityEligible = deps.history.rooms.size > 1
  out.push({
    key: 'ctx_activity',
    label: 'Activity',
    text: activityEligible ? buildActivitySection(deps, triggerRoomId) : '',
    enabled: ctxIncludes.activity && activityEligible,
    optional: true,
  })

  const knownAgents = [...deps.history.agentProfiles.values()].filter(a => a.id !== deps.agentId)
  const knownText = knownAgents.length > 0
    ? `Known agents: ${knownAgents.map(a => `"${a.name}" (${a.kind})`).join(', ')}`
    : ''
  out.push({
    key: 'ctx_knownAgents',
    label: 'Known agents',
    text: knownText,
    enabled: ctxIncludes.knownAgents && !!knownText,
    optional: true,
  })

  out.push({
    key: 'ctx_newHint',
    label: 'NEW_HINT',
    text: 'Messages marked [NEW] have arrived since you last responded.',
    enabled: true,
    optional: false,
  })

  out.push({
    key: 'responseFormat',
    label: 'RESPONSE FORMAT',
    text: deps.responseFormat ?? '',
    enabled: includes.responseFormat && !!deps.responseFormat,
    optional: true,
  })

  return out
}

// Assemble the final system-message string from enabled sections.
// Prompt-level sections get `=== LABEL ===\n` headers; CONTEXT sub-sections
// are collected under a single `=== CONTEXT ===` block matching the original
// wire format (so no downstream model sees a behavior change).
// Context sub-sections ordered stable-first (for cache-prefix stability).
// Anything that can change mid-conversation goes last so the stable prefix
// up to the first variable block caches cleanly on Gemini (implicit) and
// Anthropic (explicit cache_control).
const CTX_STABLE_KEYS: ReadonlyArray<SystemSectionKey> = [
  'ctx_intro', 'ctx_activity', 'ctx_newHint',
]
const CTX_VARIABLE_KEYS: ReadonlyArray<SystemSectionKey> = [
  'ctx_knownAgents', 'ctx_participants', 'ctx_artifacts', 'ctx_flow',
]

// Produce the system prompt as an ordered list of blocks with a `cacheable`
// flag. Stable blocks (HOUSE/ROOM/AGENT/SKILLS/RESPONSE_FORMAT + stable CONTEXT
// subsections) are cacheable; the variable CONTEXT subsections are not.
// Consumers that can't use cache markers simply join block texts.
const buildSystemBlocks = (
  deps: BuildContextDeps,
  triggerRoomId: string,
): ReadonlyArray<{ text: string; cacheable: boolean }> => {
  const sections = buildSystemSections(deps, triggerRoomId).filter(s => s.enabled)
  const byKey = new Map<SystemSectionKey, string>()
  for (const s of sections) byKey.set(s.key, s.text)

  // Stable top-level prompt sections, in order.
  const promptOrder: ReadonlyArray<SystemSectionKey> = [
    'house', 'room', 'agent', 'skills', 'responseFormat',
  ]
  const stableLines: string[] = []
  for (const key of promptOrder) {
    const text = byKey.get(key)
    if (text === undefined) continue
    const s = sections.find(x => x.key === key)!
    stableLines.push(`=== ${s.label} ===\n${text}`)
  }
  // Stable CONTEXT subsections.
  const stableCtx: string[] = []
  for (const key of CTX_STABLE_KEYS) {
    const text = byKey.get(key)
    if (text) stableCtx.push(text)
  }
  // Variable CONTEXT subsections.
  const variableCtx: string[] = []
  for (const key of CTX_VARIABLE_KEYS) {
    const text = byKey.get(key)
    if (text) variableCtx.push(text)
  }

  const blocks: Array<{ text: string; cacheable: boolean }> = []
  const stablePart = [...stableLines, stableCtx.length > 0 ? `=== CONTEXT ===\n${stableCtx.join('\n\n')}` : '']
    .filter(Boolean).join('\n\n')
  if (stablePart) blocks.push({ text: stablePart, cacheable: true })

  if (variableCtx.length > 0) {
    // If there was no stable CONTEXT, open a CONTEXT header here; otherwise
    // the variable subsections extend the existing CONTEXT block visually
    // (the stable part already has the header).
    const needsHeader = stableCtx.length === 0
    const text = needsHeader
      ? `=== CONTEXT ===\n${variableCtx.join('\n\n')}`
      : variableCtx.join('\n\n')
    blocks.push({ text, cacheable: false })
  }

  return blocks
}

// Flat system message — joins all blocks. Kept for exports consumed by the
// context preview API; buildContext inlines the join directly.
export const buildSystemMessage = (
  deps: BuildContextDeps,
  triggerRoomId: string,
): string => buildSystemBlocks(deps, triggerRoomId).map(b => b.text).filter(Boolean).join('\n\n')

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
  maxContextTokensArg?: number,
): ContextResult => {
  // Priority: explicit function arg > deps.maxContextTokens > default constant.
  // The arg form is kept for callers that already pass it explicitly.
  const maxContextTokens = maxContextTokensArg ?? deps.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS
  const flushIds = new Set<string>()

  const systemBlocks = buildSystemBlocks(deps, triggerRoomId)
  const systemContent = systemBlocks.map(b => b.text).filter(Boolean).join('\n\n')

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
    const formatted = formatMessage(msg, '', deps.agentId, deps.resolveName, roomCompressedIds, deps.includeFlowStepPrompt ?? true)
    if (formatted) formattedOld.push(formatted)
  }

  const formattedFresh: Array<{ formatted: ChatRequest['messages'][number]; id: string }> = []
  for (const msg of fresh) {
    const formatted = formatMessage(msg, '[NEW] ', deps.agentId, deps.resolveName, roomCompressedIds, deps.includeFlowStepPrompt ?? true)
    if (formatted) formattedFresh.push({ formatted, id: msg.id })
  }

  const warnings: string[] = []

  // Trim layers (in order):
  //   1. historyLimit (count) — slice above
  //   2. maxHistoryChars (per-agent char cap) — here
  //   3. maxContextTokens (global token budget) — below
  if (deps.maxHistoryChars !== undefined && deps.maxHistoryChars > 0) {
    let totalChars = formattedOld.reduce((s, m) => s + m.content.length, 0)
    const originalLen = formattedOld.length
    while (formattedOld.length > 0 && totalChars > deps.maxHistoryChars) {
      const removed = formattedOld.shift()!
      totalChars -= removed.content.length
    }
    if (formattedOld.length < originalLen) {
      const dropped = originalLen - formattedOld.length
      warnings.push(`Context trimmed by char cap: dropped ${dropped} old messages to fit ${deps.maxHistoryChars}-char budget`)
    }
  }

  // Context budget: system + fresh messages are mandatory; trim old messages to fit
  const systemTokens = estimateTokens(systemContent)
  const freshTokens = formattedFresh.reduce((sum, f) => sum + estimateTokens(f.formatted.content), 0)
  const budgetForOld = maxContextTokens - systemTokens - freshTokens

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
    systemBlocks,
  }
}
