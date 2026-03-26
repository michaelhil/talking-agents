// ============================================================================
// AI Agent — Self-contained agent that uses an LLM to decide responses.
//
// Orchestrates context building (context-builder.ts) and LLM evaluation
// (evaluation.ts) with message buffering and concurrency control.
//
// Two-buffer architecture for message context:
// - Room messages: Room is the source of truth. Room delivers each message
//   with the full history preceding it. The agent stores a history snapshot
//   (accepted when the incoming buffer is empty for that context) and an
//   incoming buffer (fresh messages not yet seen by the LLM).
// - DM messages: stored locally (no Room involved).
//
// ID Architecture: The agent generates its own UUID. The LLM sees names only.
// Names are resolved to UUIDs externally by resolveTarget in spawn.ts.
// The agent does NOT hold references to house, team, or routeMessage.
// Side effects are handled via the onDecision callback.
// ============================================================================

import type {
  AIAgent,
  AgentProfile,
  AgentState,
  AIAgentConfig,
  LLMProvider,
  Message,
  Room,
  RoomProfile,
  StateSubscriber,
  StateValue,
  ToolExecutor,
} from '../core/types.ts'
import { DEFAULTS, SYSTEM_SENDER_ID } from '../core/types.ts'
import { extractAgentProfile as extractProfile } from './shared.ts'
import { triggerKey, buildContext, flushIncoming, type BuildContextDeps } from './context-builder.ts'
import { evaluate, type OnDecision } from './evaluation.ts'

// Re-export Decision/OnDecision for consumers
export type { Decision, OnDecision } from './evaluation.ts'

// === Factory Options ===

export interface AIAgentOptions {
  readonly toolExecutor?: ToolExecutor
  readonly toolDescriptions?: string
  readonly getHousePrompt?: () => string
  readonly getResponseFormat?: () => string
}

// === Factory ===

export const createAIAgent = (
  config: AIAgentConfig,
  llmProvider: LLMProvider,
  onDecision: OnDecision,
  options?: AIAgentOptions,
): AIAgent => {
  const agentId = crypto.randomUUID()

  // Room message context: history snapshot from Room + incoming buffer
  const roomHistory = new Map<string, ReadonlyArray<Message>>()
  const incoming: Message[] = []

  // DM messages: stored locally (no Room source of truth)
  const dmMessages: Message[] = []

  // Agent knowledge
  const roomProfiles = new Map<string, RoomProfile>()
  const agentProfiles = new Map<string, AgentProfile>()

  // Concurrency control
  const generatingContexts = new Set<string>()
  const pendingContexts = new Set<string>()
  let idleResolvers: Array<() => void> = []
  const stateSubscribers = new Set<StateSubscriber>()
  let generationEpoch = 0  // incremented on cancelGeneration to discard stale results

  let currentSystemPrompt: string = config.systemPrompt
  let currentModel: string = config.model
  const historyLimit = config.historyLimit ?? DEFAULTS.historyLimit
  const maxToolIterations = config.maxToolIterations ?? 5
  const toolExecutor = options?.toolExecutor
  const toolDescriptions = options?.toolDescriptions
  const getHousePrompt = options?.getHousePrompt
  const getResponseFormat = options?.getResponseFormat

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

  // --- Name resolution ---

  const resolveName = (senderId: string): string => {
    if (senderId === SYSTEM_SENDER_ID) return 'System'
    if (senderId === agentId) return config.name
    return agentProfiles.get(senderId)?.name ?? senderId
  }

  // --- DM message management ---

  const addDMMessage = (message: Message): void => {
    dmMessages.push(message)
    const peerId = message.senderId === agentId ? message.recipientId : message.senderId
    if (!peerId) return
    const peerMsgs = dmMessages.filter(m =>
      m.roomId === undefined && (
        (m.senderId === peerId && m.recipientId === agentId) ||
        (m.senderId === agentId && m.recipientId === peerId)
      ),
    )
    if (peerMsgs.length > historyLimit) {
      const excess = peerMsgs.length - historyLimit
      const toRemove = new Set(peerMsgs.slice(0, excess).map(m => m.id))
      const kept = dmMessages.filter(m => !toRemove.has(m.id))
      dmMessages.length = 0
      dmMessages.push(...kept)
    }
  }

  const getDMMessagesForPeer = (peerId: string): ReadonlyArray<Message> => {
    const peerMsgs = dmMessages.filter(m =>
      m.roomId === undefined && (
        (m.senderId === peerId && m.recipientId === agentId) ||
        (m.senderId === agentId && m.recipientId === peerId)
      ),
    )
    if (peerMsgs.length <= historyLimit) return peerMsgs
    return peerMsgs.slice(-historyLimit)
  }

  // --- Idle detection ---

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

  // --- Context deps (shared state reference for buildContext) ---

  const contextDeps = (): BuildContextDeps => ({
    agentId,
    systemPrompt: currentSystemPrompt,
    housePrompt: getHousePrompt?.(),
    responseFormat: getResponseFormat?.(),
    incoming,
    roomHistory,
    roomProfiles,
    agentProfiles,
    toolDescriptions,
    historyLimit,
    resolveName,
    getDMMessagesForPeer,
  })

  // --- Evaluation loop: per-context generation with pending queue ---

  const tryEvaluate = (triggerRoomId?: string, triggerPeerId?: string): void => {
    const key = triggerKey(triggerRoomId, triggerPeerId)

    if (generatingContexts.has(key)) {
      pendingContexts.add(key)
      return
    }

    generatingContexts.add(key)
    notifyState('generating', key)

    const contextResult = buildContext(contextDeps(), triggerRoomId, triggerPeerId)
    const epochAtStart = generationEpoch

    const evalConfig = { ...config, model: currentModel, systemPrompt: currentSystemPrompt }
    evaluate(contextResult, evalConfig, llmProvider, toolExecutor, maxToolIterations, triggerRoomId, triggerPeerId)
      .then(({ decision, flushInfo }) => {
        // Discard results if generation was cancelled
        if (epochAtStart !== generationEpoch) return

        // Only flush incoming when the LLM actually responded.
        // On pass, keep messages in incoming so they stay [NEW] on re-eval.
        const didRespond = decision?.response.action === 'respond'
        if (didRespond) {
          flushIncoming(flushInfo, incoming, roomHistory, addDMMessage)
        }
        if (decision) onDecision(decision)
      })
      .catch(err => {
        if (epochAtStart !== generationEpoch) return  // cancelled, ignore error
        console.error(`[${config.name}] Evaluation error:`, err)
      })
      .finally(() => {
        if (epochAtStart !== generationEpoch) return  // cancelled, already cleaned up
        generatingContexts.delete(key)
        notifyState('idle', key)

        if (pendingContexts.has(key)) {
          pendingContexts.delete(key)
          tryEvaluate(triggerRoomId, triggerPeerId)
        } else {
          checkIdle()
        }
      })
  }

  // --- Receive ---

  const receive = (message: Message, history?: ReadonlyArray<Message>): void => {
    extractProfile(message, agentId, agentProfiles)

    if (message.roomId) {
      const key = triggerKey(message.roomId, undefined)
      const hasUnprocessed = incoming.some(m =>
        m.roomId === message.roomId && m.type !== 'room_summary' && m.senderId !== agentId,
      )
      if (history && !hasUnprocessed) {
        roomHistory.set(key, history)
      }
      if (message.senderId === agentId) {
        // Own room messages go straight to history (not incoming) so they're
        // visible as assistant context during re-evaluations.
        const current = roomHistory.get(key) ?? []
        roomHistory.set(key, [...current, message])
      } else {
        incoming.push(message)
      }
    } else {
      incoming.push(message)
    }

    if (message.senderId === agentId) return
    if (message.type === 'system' || message.type === 'leave' || message.type === 'pass') return

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
      extractProfile(msg, agentId, agentProfiles)
    }

    const messageLines = recent
      .filter(m => m.type === 'chat' || m.type === 'room_summary')
      .map(m => `[${resolveName(m.senderId)}]: ${m.content}`)
      .join('\n')

    if (messageLines.length === 0) return

    try {
      const summaryResponse = await llmProvider.chat({
        model: currentModel,
        messages: [
          {
            role: 'system',
            content: `Summarize the following room discussion concisely. When referring to participants, always use the format [participantName]. Include: 1) Main topics discussed 2) Key positions held by each participant 3) Any decisions or open questions. Be brief — this summary helps a new participant catch up.`,
          },
          {
            role: 'user',
            content: `Room: "${room.profile.name}"\n\nRecent discussion:\n${messageLines}`,
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
      incoming.push(summaryMessage)
    } catch (err) {
      console.error(`[${config.name}] Failed to generate join summary for ${room.profile.name}:`, err)
    }
  }

  // --- Query — synchronous side-channel for tool-based inter-agent communication ---

  let queryActive = false

  const query = async (question: string, askerId: string, askerName?: string): Promise<string> => {
    if (queryActive) throw new Error(`${config.name} is already processing a query`)
    queryActive = true

    try {
      const name = askerName ?? agentProfiles.get(askerId)?.name ?? askerId
      const response = await llmProvider.chat({
        model: config.model,
        messages: [
          { role: 'system', content: currentSystemPrompt },
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
    kind: 'ai',
    metadata: { model: currentModel },
    state,
    receive,
    join,
    whenIdle,
    query,
    updateSystemPrompt: (prompt: string) => { currentSystemPrompt = prompt },
    getSystemPrompt: () => currentSystemPrompt,
    updateModel: (model: string) => { currentModel = model },
    getModel: () => currentModel,
    cancelGeneration: () => {
      // Increment epoch so in-flight LLM calls discard their results
      generationEpoch++
      generatingContexts.clear()
      pendingContexts.clear()
      notifyState('idle')
    },
  }
}
