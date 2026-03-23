// ============================================================================
// AI Agent — Self-contained agent that uses an LLM to decide responses.
//
// Internal state: messages[], roomProfiles, agentProfiles, cooldowns, per-context generation.
// receive() adds message, extracts profiles, triggers evaluation.
// evaluate() builds context from own data → LLM call → parses JSON with target.
//
// Handles both room messages and DMs uniformly:
// - Room trigger: context built from room messages, room profile
// - DM trigger: context built from DM thread with peer
// Both paths produce the same AgentResponse with target field.
//
// The agent does NOT hold references to house, team, or postAndDeliver.
// Side effects are handled via the onDecision callback.
// ============================================================================

import type {
  Agent,
  AgentProfile,
  AIAgentConfig,
  AgentResponse,
  ChatRequest,
  LLMProvider,
  Message,
  MessageTarget,
  Room,
  RoomProfile,
} from '../core/types.ts'
import { DEFAULTS, SYSTEM_SENDER_ID } from '../core/types.ts'
import { extractAgentProfile as extractProfile } from './shared.ts'

// === Decision — what the agent wants to do after evaluation ===

export interface Decision {
  readonly response: AgentResponse
  readonly generationMs: number
  readonly triggerRoomId?: string
  readonly triggerPeerId?: string
}

export type OnDecision = (decision: Decision) => void

// === Trigger key — unified identifier for rooms and DM peers ===

const triggerKey = (roomId?: string, peerId?: string): string =>
  roomId ? `room:${roomId}` : `dm:${peerId}`

// === Factory ===

export const createAIAgent = (
  config: AIAgentConfig,
  llmProvider: LLMProvider,
  onDecision: OnDecision,
): Agent => {
  const messages: Message[] = []
  const roomProfiles = new Map<string, RoomProfile>()
  const agentProfiles = new Map<string, AgentProfile>()
  const cooldowns = new Map<string, number>()
  const generatingContexts = new Set<string>()
  const pendingContexts = new Set<string>()

  const historyLimit = config.historyLimit ?? DEFAULTS.historyLimit

  // --- Profile extraction from join messages ---

  const extractAgentProfileFromMessage = (message: Message): void => {
    extractProfile(message, config.participantId, agentProfiles)
  }

  // --- Message management ---

  const addMessage = (message: Message): void => {
    messages.push(message)
    if (message.roomId) {
      evictByFilter(m => m.roomId === message.roomId)
    } else if (message.recipientId || message.senderId !== config.participantId) {
      const peerId = message.senderId === config.participantId
        ? message.recipientId
        : message.senderId
      if (peerId) {
        evictByFilter(m =>
          m.roomId === undefined && (
            (m.senderId === peerId && m.recipientId === config.participantId) ||
            (m.senderId === config.participantId && m.recipientId === peerId)
          ),
        )
      }
    }
  }

  const evictByFilter = (filter: (m: Message) => boolean): void => {
    const matching = messages.filter(filter)
    if (matching.length <= historyLimit) return

    const excess = matching.length - historyLimit
    const toRemove = new Set(matching.slice(0, excess).map(m => m.id))
    const kept = messages.filter(m => !toRemove.has(m.id))
    messages.length = 0
    messages.push(...kept)
  }

  // --- Derived data from own messages ---

  const getMessages = (): ReadonlyArray<Message> => [...messages]

  const getRoomIds = (): ReadonlyArray<string> =>
    [...new Set(
      messages
        .filter(m => m.roomId !== undefined)
        .map(m => m.roomId!),
    )]

  const getMessagesForRoom = (roomId: string, limit?: number): ReadonlyArray<Message> => {
    const roomMsgs = messages.filter(m => m.roomId === roomId)
    const effectiveLimit = limit ?? historyLimit
    if (roomMsgs.length <= effectiveLimit) return roomMsgs
    return roomMsgs.slice(-effectiveLimit)
  }

  const getMessagesForPeer = (peerId: string, limit?: number): ReadonlyArray<Message> => {
    const peerMsgs = messages.filter(m =>
      m.roomId === undefined && (
        (m.senderId === peerId && m.recipientId === config.participantId) ||
        (m.senderId === config.participantId && m.recipientId === peerId)
      ),
    )
    const effectiveLimit = limit ?? historyLimit
    if (peerMsgs.length <= effectiveLimit) return peerMsgs
    return peerMsgs.slice(-effectiveLimit)
  }

  const getParticipantsForRoom = (roomId: string): ReadonlyArray<AgentProfile | string> => {
    const senderIds = new Set<string>()
    for (const msg of messages) {
      if (msg.roomId === roomId && msg.senderId !== SYSTEM_SENDER_ID && msg.senderId !== config.participantId) {
        senderIds.add(msg.senderId)
      }
    }
    return [...senderIds].map(id => agentProfiles.get(id) ?? id)
  }

  // --- Name resolution ---

  const resolveName = (senderId: string): string => {
    if (senderId === SYSTEM_SENDER_ID) return 'System'
    if (senderId === config.participantId) return config.name
    return agentProfiles.get(senderId)?.name ?? senderId
  }

  // --- Cooldown ---

  const isOnCooldown = (key: string): boolean => {
    const lastTime = cooldowns.get(key)
    if (lastTime === undefined) return false
    return Date.now() - lastTime < config.cooldownMs
  }

  const setCooldown = (key: string): void => {
    cooldowns.set(key, Date.now())
  }

  // --- Context assembly ---

  const buildContext = (triggerRoomId?: string, triggerPeerId?: string): ChatRequest['messages'] => {
    let systemContent = config.systemPrompt

    // Current conversation context
    if (triggerRoomId) {
      const roomProfile = roomProfiles.get(triggerRoomId)
      if (roomProfile) {
        systemContent += `\n\nYou are in room "${roomProfile.name}".`
        if (roomProfile.description) systemContent += ` ${roomProfile.description}`
        if (roomProfile.roomPrompt) systemContent += `\n\nRoom instructions: ${roomProfile.roomPrompt}`
      }

      const participants = getParticipantsForRoom(triggerRoomId)
      if (participants.length > 0) {
        const lines = participants.map(p =>
          typeof p === 'string' ? p : `${p.name} [${p.id}]: ${p.description} (${p.kind})`,
        )
        systemContent += `\n\nOther participants in this room:\n${lines.join('\n')}`
      }
    } else if (triggerPeerId) {
      const peerProfile = agentProfiles.get(triggerPeerId)
      const peerName = peerProfile?.name ?? triggerPeerId
      systemContent += `\n\nThis is a direct conversation with ${peerName}.`
      if (peerProfile?.description) systemContent += ` ${peerProfile.description}`
    }

    // Available rooms (so agent can target them) — show ID prominently
    const roomIds = getRoomIds()
    if (roomIds.length > 0) {
      const roomLines = roomIds.map(id => {
        const rp = roomProfiles.get(id)
        return rp ? `"${id}" (${rp.name})` : `"${id}"`
      })
      systemContent += `\n\nYour room IDs: ${roomLines.join(', ')}`
    }

    // Known agents (so agent can DM them) — show ID prominently
    const knownAgents = [...agentProfiles.values()].filter(a => a.id !== config.participantId)
    if (knownAgents.length > 0) {
      const agentLines = knownAgents.map(a => `"${a.id}" (${a.name})`)
      systemContent += `\nKnown agent IDs: ${agentLines.join(', ')}`
    }

    // Response format with target — emphasize using IDs
    systemContent += `\n\nRespond with JSON. You MUST include a "target" with room IDs or agent IDs.
IMPORTANT: Use the exact IDs shown above, NOT display names.
To reply in a room: {"action": "respond", "content": "...", "target": {"rooms": ["room-id-here"]}}
To message an agent directly: {"action": "respond", "content": "...", "target": {"agents": ["agent-id-here"]}}
To do both: {"action": "respond", "content": "...", "target": {"rooms": ["room-id"], "agents": ["agent-id"]}}
To stay silent: {"action": "pass", "reason": "..."}

Only respond when you have substantive input. Do not respond just to acknowledge.`

    // Build message array
    const chatMessages: ChatRequest['messages'][number][] = [
      { role: 'system' as const, content: systemContent },
    ]

    // Get recent messages for the triggering conversation
    const recentMessages = triggerRoomId
      ? getMessagesForRoom(triggerRoomId)
      : triggerPeerId
        ? getMessagesForPeer(triggerPeerId)
        : []

    for (const msg of recentMessages) {
      if (msg.type === 'system' || msg.type === 'join' || msg.type === 'leave') continue
      if (msg.senderId === config.participantId) {
        chatMessages.push({ role: 'assistant' as const, content: msg.content })
      } else {
        const name = resolveName(msg.senderId)
        chatMessages.push({ role: 'user' as const, content: `[${name}]: ${msg.content}` })
      }
    }

    return chatMessages
  }

  // --- JSON parsing with fallback ---

  const parseResponse = (raw: string): AgentResponse => {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (parsed.action === 'respond' && typeof parsed.content === 'string' && (parsed.content as string).length > 0) {
        const target = parsed.target as MessageTarget | undefined
        if (target && ((target.rooms && target.rooms.length > 0) || (target.agents && target.agents.length > 0))) {
          return parsed as AgentResponse
        }
        // Valid respond but no/empty target — return with empty target (caller applies fallback)
        return { action: 'respond', content: parsed.content as string, target: {}, actions: parsed.actions as AgentResponse['actions'] }
      }
      if (parsed.action === 'pass') {
        return { action: 'pass', reason: parsed.reason as string | undefined }
      }
      return { action: 'pass', reason: 'Invalid response structure' }
    } catch {
      return { action: 'respond', content: raw, target: {} }
    }
  }

  // --- Evaluate ---

  const evaluate = async (triggerRoomId?: string, triggerPeerId?: string): Promise<Decision | null> => {
    const context = buildContext(triggerRoomId, triggerPeerId)

    try {
      const chatResponse = await llmProvider.chat({
        model: config.model,
        messages: context,
        temperature: config.temperature,
        jsonMode: true,
      })

      const agentResponse = parseResponse(chatResponse.content)

      return {
        response: agentResponse,
        generationMs: chatResponse.generationMs,
        triggerRoomId,
        triggerPeerId,
      }
    } catch (err) {
      console.error(`[${config.name}] LLM call failed:`, err)
      return null
    }
  }

  // --- Evaluation loop: per-context generation with pending queue ---

  const tryEvaluate = (triggerRoomId?: string, triggerPeerId?: string): void => {
    const key = triggerKey(triggerRoomId, triggerPeerId)

    if (generatingContexts.has(key)) {
      pendingContexts.add(key)
      return
    }

    if (isOnCooldown(key)) return

    generatingContexts.add(key)

    evaluate(triggerRoomId, triggerPeerId)
      .then(decision => {
        if (decision) {
          setCooldown(key)
          onDecision(decision)
        }
      })
      .catch(err => {
        console.error(`[${config.name}] Evaluation error:`, err)
      })
      .finally(() => {
        generatingContexts.delete(key)

        if (pendingContexts.has(key)) {
          pendingContexts.delete(key)
          tryEvaluate(triggerRoomId, triggerPeerId)
        }
      })
  }

  // --- Receive ---

  const receive = (message: Message): void => {
    addMessage(message)
    extractAgentProfileFromMessage(message)

    if (message.senderId === config.participantId) return
    if (message.type === 'system' || message.type === 'leave') return

    if (message.roomId) {
      tryEvaluate(message.roomId, undefined)
    } else {
      tryEvaluate(undefined, message.senderId)
    }
  }

  // --- Join ---

  const join = async (room: Room): Promise<void> => {
    roomProfiles.set(room.profile.id, room.profile)

    const recent = room.getRecent(historyLimit)
    if (recent.length === 0) return

    for (const msg of recent) {
      extractAgentProfileFromMessage(msg)
    }

    const messageLines = recent
      .filter(m => m.type === 'chat' || m.type === 'room_summary')
      .map(m => `[${resolveName(m.senderId)}]: ${m.content}`)
      .join('\n')

    if (messageLines.length === 0) return

    try {
      const summaryResponse = await llmProvider.chat({
        model: config.model,
        messages: [
          {
            role: 'system',
            content: `Summarize the following room discussion concisely. When referring to participants, always use the format [participantName]. Include: 1) Main topics discussed 2) Key positions held by each participant 3) Any decisions or open questions. Be brief — this summary helps a new participant catch up.`,
          },
          {
            role: 'user',
            content: `Room: "${room.profile.name}"${room.profile.description ? ` — ${room.profile.description}` : ''}\n\nRecent discussion:\n${messageLines}`,
          },
        ],
        temperature: 0.3,
      })

      const summaryMessage: Message = {
        id: crypto.randomUUID(),
        roomId: room.profile.id,
        senderId: SYSTEM_SENDER_ID,
        content: summaryResponse.content,
        timestamp: Date.now(),
        type: 'room_summary',
      }
      addMessage(summaryMessage)
    } catch (err) {
      console.error(`[${config.name}] Failed to generate join summary for ${room.profile.name}:`, err)
    }
  }

  return {
    id: config.participantId,
    name: config.name,
    description: config.description,
    kind: 'ai',
    metadata: { model: config.model },
    getMessages,
    receive,
    join,
    getRoomIds,
    getMessagesForRoom,
    getMessagesForPeer,
  }
}
