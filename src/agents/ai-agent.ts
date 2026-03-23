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
// ID Architecture: The agent generates its own UUID. The LLM sees names only.
// Names are resolved to UUIDs externally by resolveTarget in spawn.ts.
// The agent does NOT hold references to house, team, or postAndDeliver.
// Side effects are handled via the onDecision callback.
// ============================================================================

import type {
  AIAgent,
  AgentProfile,
  AgentState,
  AIAgentConfig,
  AgentResponse,
  ChatRequest,
  LLMProvider,
  Message,
  MessageTarget,
  Room,
  RoomProfile,
  StateSubscriber,
  StateValue,
  ToolCall,
  ToolExecutor,
} from '../core/types.ts'
import { DEFAULTS, SYSTEM_SENDER_ID } from '../core/types.ts'
import {
  addMessageWithEviction,
  getMessagesAll,
  getMessagesForPeer as getMessagesForPeerHelper,
  getMessagesForRoom as getMessagesForRoomHelper,
  getRoomIdsFromMessages,
} from '../core/messages.ts'
import { extractAgentProfile as extractProfile } from './shared.ts'

// === Decision — what the agent wants to do after evaluation ===

export interface Decision {
  readonly response: AgentResponse
  readonly generationMs: number
  readonly triggerRoomId?: string
  readonly triggerPeerId?: string
}

export type OnDecision = (decision: Decision) => void

// === Internal response type — includes tool_call (never leaves evaluate) ===

type InternalResponse =
  | AgentResponse
  | { readonly action: 'tool_call'; readonly toolCalls: ReadonlyArray<ToolCall> }

// === Trigger key — unified identifier for rooms and DM peers ===

const triggerKey = (roomId?: string, peerId?: string): string =>
  roomId ? `room:${roomId}` : `dm:${peerId}`

// === Factory ===

export interface AIAgentOptions {
  readonly toolExecutor?: ToolExecutor
  readonly toolDescriptions?: string  // pre-formatted tool descriptions for LLM
}

export const createAIAgent = (
  config: AIAgentConfig,
  llmProvider: LLMProvider,
  onDecision: OnDecision,
  options?: AIAgentOptions,
): AIAgent => {
  const agentId = crypto.randomUUID()
  const messages: Message[] = []
  const roomProfiles = new Map<string, RoomProfile>()
  const agentProfiles = new Map<string, AgentProfile>()
  const cooldowns = new Map<string, number>()
  const generatingContexts = new Set<string>()
  const pendingContexts = new Set<string>()
  let idleResolvers: Array<() => void> = []
  const stateSubscribers = new Set<StateSubscriber>()

  const historyLimit = config.historyLimit ?? DEFAULTS.historyLimit
  const maxToolIterations = config.maxToolIterations ?? 5
  const toolExecutor = options?.toolExecutor
  const toolDescriptions = options?.toolDescriptions

  // --- State observability ---

  const notifyState = (value: StateValue, context?: string): void => {
    for (const fn of stateSubscribers) fn(value, agentId, context)
  }

  const state: AgentState = {
    get: () => generatingContexts.size > 0 ? 'generating' : 'idle',
    subscribe: (fn: StateSubscriber) => {
      stateSubscribers.add(fn)
      return () => { stateSubscribers.delete(fn) }
    },
  }

  // --- Profile extraction from join messages ---

  const extractAgentProfileFromMessage = (message: Message): void => {
    extractProfile(message, agentId, agentProfiles)
  }

  // --- Message management (delegates to shared helpers) ---

  const addMessage = (message: Message): void => {
    addMessageWithEviction(messages, message, agentId, historyLimit)
  }

  const getMessages = (): ReadonlyArray<Message> => getMessagesAll(messages)
  const getRoomIds = (): ReadonlyArray<string> => getRoomIdsFromMessages(messages)
  const getMessagesForRoom = (roomId: string, limit?: number): ReadonlyArray<Message> =>
    getMessagesForRoomHelper(messages, roomId, limit ?? historyLimit)
  const getMessagesForPeer = (peerId: string, limit?: number): ReadonlyArray<Message> =>
    getMessagesForPeerHelper(messages, agentId, peerId, limit ?? historyLimit)

  const getParticipantsForRoom = (roomId: string): ReadonlyArray<AgentProfile | string> => {
    const senderIds = new Set<string>()
    for (const msg of messages) {
      if (msg.roomId === roomId && msg.senderId !== SYSTEM_SENDER_ID && msg.senderId !== agentId) {
        senderIds.add(msg.senderId)
      }
    }
    return [...senderIds].map(id => agentProfiles.get(id) ?? id)
  }

  // --- Name resolution ---

  const resolveName = (senderId: string): string => {
    if (senderId === SYSTEM_SENDER_ID) return 'System'
    if (senderId === agentId) return config.name
    return agentProfiles.get(senderId)?.name ?? senderId
  }

  // --- Cooldown ---

  const isOnCooldown = (key: string): boolean => {
    const lastTime = cooldowns.get(key)
    if (lastTime === undefined) return false
    const now = Date.now()
    if (now - lastTime >= config.cooldownMs) {
      cooldowns.delete(key)  // lazy prune expired entries
      return false
    }
    return true
  }

  const setCooldown = (key: string): void => {
    cooldowns.set(key, Date.now())
  }

  // --- Idle detection — resolves when all evaluations complete ---

  const checkIdle = (): void => {
    if (generatingContexts.size === 0 && pendingContexts.size === 0) {
      const resolvers = idleResolvers
      idleResolvers = []
      for (const resolve of resolvers) resolve()
    }
  }

  const whenIdle = (timeoutMs = 30_000): Promise<void> => {
    if (generatingContexts.size === 0 && pendingContexts.size === 0) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`whenIdle timed out after ${timeoutMs}ms`)),
        timeoutMs,
      )
      idleResolvers.push(() => { clearTimeout(timer); resolve() })
    })
  }

  // --- Context assembly (names only — no UUIDs shown to LLM) ---

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
          typeof p === 'string' ? `- ${p}` : `- ${p.name}: ${p.description} (${p.kind})`,
        )
        systemContent += `\n\nOther participants:\n${lines.join('\n')}`
      }
    } else if (triggerPeerId) {
      const peerProfile = agentProfiles.get(triggerPeerId)
      const peerName = peerProfile?.name ?? triggerPeerId
      systemContent += `\n\nThis is a direct conversation with ${peerName}.`
      if (peerProfile?.description) systemContent += ` ${peerProfile.description}`
    }

    // Available rooms — names only
    const roomIds = getRoomIds()
    if (roomIds.length > 0) {
      const roomNames = roomIds
        .map(id => roomProfiles.get(id)?.name ?? id)
        .map(name => `"${name}"`)
      systemContent += `\n\nYour rooms: ${roomNames.join(', ')}`
    }

    // Known agents — names only
    const knownAgents = [...agentProfiles.values()].filter(a => a.id !== agentId)
    if (knownAgents.length > 0) {
      const agentNames = knownAgents.map(a => `"${a.name}" (${a.kind})`)
      systemContent += `\nKnown agents: ${agentNames.join(', ')}`
    }

    // Tool descriptions (only if agent has tools)
    if (toolDescriptions) {
      systemContent += `\n\n${toolDescriptions}`
    }

    // Response format — target is optional (defaults to replying where the message came from)
    systemContent += `\n\nRespond with JSON.
To reply: {"action": "respond", "content": "..."}
To redirect to a specific room or agent: {"action": "respond", "content": "...", "target": {"rooms": ["Room Name"]}} or {"target": {"agents": ["Agent Name"]}}
To stay silent: {"action": "pass", "reason": "..."}`

    if (toolDescriptions) {
      systemContent += `\nTo call a tool: {"action": "tool_call", "toolCalls": [{"tool": "tool_name", "arguments": {...}}]}
Tool results will be provided, then you respond normally.`
    }

    systemContent += `\n\nOnly respond when you have substantive input. Do not respond just to acknowledge.`

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
      if (msg.senderId === agentId) {
        chatMessages.push({ role: 'assistant' as const, content: msg.content })
      } else {
        const name = resolveName(msg.senderId)
        chatMessages.push({ role: 'user' as const, content: `[${name}]: ${msg.content}` })
      }
    }

    return chatMessages
  }

  // --- JSON parsing with fallback ---

  const parseResponse = (raw: string): InternalResponse => {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (parsed.action === 'respond' && typeof parsed.content === 'string' && (parsed.content as string).length > 0) {
        const target = parsed.target as MessageTarget | undefined
        if (target && ((target.rooms && target.rooms.length > 0) || (target.agents && target.agents.length > 0))) {
          return parsed as AgentResponse
        }
        return { action: 'respond', content: parsed.content as string, target: {}, actions: parsed.actions as AgentResponse['actions'] }
      }
      if (parsed.action === 'pass') {
        return { action: 'pass', reason: parsed.reason as string | undefined }
      }
      if (parsed.action === 'tool_call' && Array.isArray(parsed.toolCalls) && parsed.toolCalls.length > 0) {
        const validCalls = (parsed.toolCalls as ReadonlyArray<Record<string, unknown>>)
          .filter(c => typeof c.tool === 'string')
          .map(c => ({ tool: c.tool as string, arguments: (c.arguments ?? {}) as Record<string, unknown> }))
        if (validCalls.length > 0) {
          return { action: 'tool_call', toolCalls: validCalls }
        }
      }
      return { action: 'pass', reason: 'Invalid response structure' }
    } catch {
      return { action: 'respond', content: raw, target: {} }
    }
  }

  // --- Evaluate ---

  const evaluate = async (triggerRoomId?: string, triggerPeerId?: string): Promise<Decision | null> => {
    const context = [...buildContext(triggerRoomId, triggerPeerId)]
    let totalGenerationMs = 0

    try {
      // Loop: 1 initial call + up to maxToolIterations tool rounds
      for (let toolRound = 0; toolRound <= maxToolIterations; toolRound++) {
        const chatResponse = await llmProvider.chat({
          model: config.model,
          messages: context,
          temperature: config.temperature,
          jsonMode: true,
        })

        totalGenerationMs += chatResponse.generationMs
        const parsed = parseResponse(chatResponse.content)

        // Tool call — execute and continue loop
        if (parsed.action === 'tool_call' && toolExecutor) {
          const results = await toolExecutor(parsed.toolCalls)

          // Add assistant's tool call as context
          context.push({ role: 'assistant' as const, content: chatResponse.content })

          // Add tool results as user message
          const resultText = results
            .map((r, i) => `Tool "${parsed.toolCalls[i]?.tool}": ${r.success ? JSON.stringify(r.data) : `Error: ${r.error}`}`)
            .join('\n')
          context.push({ role: 'user' as const, content: `Tool results:\n${resultText}\n\nNow respond based on the tool results.` })

          continue
        }

        // tool_call without executor — fall back to pass
        if (parsed.action === 'tool_call') {
          return {
            response: { action: 'pass', reason: 'Tool calls not available' },
            generationMs: totalGenerationMs,
            triggerRoomId,
            triggerPeerId,
          }
        }

        // respond or pass — return decision
        return {
          response: parsed,
          generationMs: totalGenerationMs,
          triggerRoomId,
          triggerPeerId,
        }
      }

      // Max iterations reached
      return {
        response: { action: 'pass', reason: `Tool call loop exceeded ${maxToolIterations} iterations` },
        generationMs: totalGenerationMs,
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
    notifyState('generating', key)

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
        } else {
          notifyState('idle', key)
          checkIdle()
        }
      })
  }

  // --- Receive ---

  const receive = (message: Message): void => {
    addMessage(message)
    extractAgentProfileFromMessage(message)

    if (message.senderId === agentId) return
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

  // --- Query — synchronous side-channel for tool-based inter-agent communication ---
  // Same LLM, same personality, no message history involvement, no onDecision.
  // Returns the response text directly to the caller.

  let queryActive = false

  const query = async (question: string, askerId: string, askerName?: string): Promise<string> => {
    if (queryActive) throw new Error(`${config.name} is already processing a query`)
    queryActive = true

    try {
      const name = askerName ?? agentProfiles.get(askerId)?.name ?? askerId
      const response = await llmProvider.chat({
        model: config.model,
        messages: [
          { role: 'system', content: config.systemPrompt },
          { role: 'user', content: `[${name}] asks: ${question}` },
        ],
        temperature: config.temperature,
      })
      return response.content
    } finally {
      queryActive = false
    }
  }

  return {
    id: agentId,
    name: config.name,
    description: config.description,
    kind: 'ai',
    metadata: { model: config.model },
    state,
    getMessages,
    receive,
    join,
    getRoomIds,
    getMessagesForRoom,
    getMessagesForPeer,
    whenIdle,
    query,
  }
}
