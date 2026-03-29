// ============================================================================
// AI Agent — Self-contained agent that uses an LLM to decide responses.
//
// Orchestrates context building (context-builder.ts) and LLM evaluation
// (evaluation.ts) with message buffering and concurrency control.
//
// History architecture: a single AgentHistory struct owns all per-agent state.
//   - rooms: per-room processed history + room profile + last-active timestamp
//   - dms: per-peer DM history + last-active timestamp
//   - incoming: shared buffer of unprocessed messages across all contexts
//   - agentProfiles: knowledge about other agents in the system
//
// join() initialises the RoomContext (with profile) before the first message
// arrives, so receive() never needs to handle first-contact lazily.
//
// ID Architecture: The agent generates its own UUID. The LLM sees names only.
// Names are resolved to UUIDs externally by resolveTarget in spawn.ts.
// The agent does NOT hold references to house, team, or routeMessage.
// Side effects are handled via the onDecision callback.
// ============================================================================

import type {
  AIAgent,
  AgentHistory,
  AgentProfile,
  AgentState,
  AIAgentConfig,
  LLMProvider,
  Message,
  Room,
  RoomProfile,
  StateSubscriber,
  StateValue,
  TodoItem,
  ToolDefinition,
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
  readonly toolDefinitions?: ReadonlyArray<ToolDefinition>
  readonly getHousePrompt?: () => string
  readonly getResponseFormat?: () => string
  readonly getRoomTodos?: (roomId: string) => ReadonlyArray<TodoItem>
}

// === Factory ===

export const createAIAgent = (
  config: AIAgentConfig,
  llmProvider: LLMProvider,
  onDecision: OnDecision,
  options?: AIAgentOptions,
  overrideId?: string,
): AIAgent => {
  const agentId = overrideId ?? crypto.randomUUID()

  // Single unified history structure — all agent state in one place
  const agentHistory: AgentHistory = {
    rooms: new Map(),
    dms: new Map(),
    incoming: [],
    agentProfiles: new Map(),
  }

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
  const toolDefinitions = options?.toolDefinitions
  const getHousePrompt = options?.getHousePrompt
  const getResponseFormat = options?.getResponseFormat
  const getRoomTodos = options?.getRoomTodos

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
    return agentHistory.agentProfiles.get(senderId)?.name ?? senderId
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

  // --- Context deps ---

  const contextDeps = (): BuildContextDeps => ({
    agentId,
    systemPrompt: currentSystemPrompt,
    housePrompt: getHousePrompt?.(),
    responseFormat: getResponseFormat?.(),
    history: agentHistory,
    toolDescriptions,
    historyLimit,
    resolveName,
    getRoomTodos,
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
    evaluate(contextResult, evalConfig, llmProvider, toolExecutor, maxToolIterations, triggerRoomId, triggerPeerId, toolDefinitions)
      .then(({ decision, flushInfo }) => {
        // Discard results if generation was cancelled
        if (epochAtStart !== generationEpoch) return

        // Flush incoming always — on both respond and pass.
        // On pass, the agent has consciously evaluated these messages; they belong in history.
        flushIncoming(flushInfo, agentHistory, agentId)
        onDecision(decision)
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
  // History is no longer delivered via receive() — RoomContext is initialised
  // in join() before the first message arrives. Own messages go straight to
  // room history (not incoming) for re-evaluation continuity.

  const receive = (message: Message): void => {
    extractProfile(message, agentId, agentHistory.agentProfiles)

    if (message.roomId) {
      if (message.senderId === agentId) {
        // Own room messages go straight to history so they're visible as
        // assistant context during re-evaluations without triggering a new eval.
        const ctx = agentHistory.rooms.get(message.roomId)
        if (ctx) ctx.history = [...ctx.history, message]
      } else {
        agentHistory.incoming.push(message)
      }
    } else {
      agentHistory.incoming.push(message)
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
  // Initialises RoomContext (profile + empty history) BEFORE any messages are
  // delivered. Generates an LLM summary of recent room history for onboarding.

  const join = async (room: Room): Promise<void> => {
    // Initialise context — profile available here, before messages arrive
    agentHistory.rooms.set(room.profile.id, {
      profile: room.profile,
      history: [],
      lastActiveAt: undefined,
    })

    const recent = room.getRecent(historyLimit)
    if (recent.length === 0) return

    for (const msg of recent) {
      extractProfile(msg, agentId, agentHistory.agentProfiles)
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
      agentHistory.incoming.push(summaryMessage)
    } catch (err) {
      console.error(`[${config.name}] Failed to generate join summary for ${room.profile.name}:`, err)
    }
  }

  // --- Query — synchronous side-channel for tool-based inter-agent communication ---

  const QUERY_TIMEOUT_MS = 30_000
  let queryActive = false

  const query = async (question: string, askerId: string, askerName?: string): Promise<string> => {
    if (queryActive) throw new Error(`${config.name} is already processing a query`)
    queryActive = true

    try {
      const name = askerName ?? agentHistory.agentProfiles.get(askerId)?.name ?? askerId
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Query to ${config.name} timed out after ${QUERY_TIMEOUT_MS}ms`)), QUERY_TIMEOUT_MS),
      )
      const response = await Promise.race([
        llmProvider.chat({
          model: config.model,
          messages: [
            { role: 'system', content: currentSystemPrompt },
            { role: 'user', content: `[${name}] asks: ${question}` },
          ],
          temperature: config.temperature,
        }),
        timeout,
      ])
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
    leave: (roomId: string): void => {
      agentHistory.rooms.delete(roomId)
    },
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
