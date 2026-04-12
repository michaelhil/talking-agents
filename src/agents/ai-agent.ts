// ============================================================================
// AI Agent — Self-contained agent that uses an LLM to decide responses.
//
// Orchestrates context building (context-builder.ts) and LLM evaluation
// (evaluation.ts) with message buffering and concurrency control.
//
// History architecture: a single AgentHistory struct owns all per-agent state.
//   - rooms: per-room processed history + room profile + last-active timestamp
//   - incoming: shared buffer of unprocessed messages across all rooms
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
  AIAgentConfig,
  Artifact,
  ArtifactTypeDefinition,
  EvalEvent,
  LLMProvider,
  Message,
  Room,
  ToolDefinition,
  ToolExecutor,
} from '../core/types.ts'
import { DEFAULTS, SYSTEM_SENDER_ID } from '../core/types.ts'
import { extractAgentProfile as extractProfile } from './shared.ts'
import { buildContext, flushIncoming, type BuildContextDeps } from './context-builder.ts'
import { callLLM, evaluate, type OnDecision } from './evaluation.ts'
import { createConcurrencyManager } from './concurrency.ts'

// Re-export Decision/OnDecision for consumers
export type { Decision, OnDecision } from './evaluation.ts'

// === Factory Options ===

export interface AIAgentOptions {
  readonly toolExecutor?: ToolExecutor
  readonly toolDefinitions?: ReadonlyArray<ToolDefinition>
  readonly getHousePrompt?: () => string
  readonly getResponseFormat?: () => string
  readonly getArtifactsForScope?: (roomId: string) => ReadonlyArray<Artifact>
  readonly getArtifactTypeDef?: (type: string) => ArtifactTypeDefinition | undefined
  readonly getCompressedIds?: (roomId: string) => ReadonlySet<string>
  readonly getSkills?: (roomName: string) => string
  readonly onEvalEvent?: (agentName: string, event: EvalEvent) => void
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
    incoming: [],
    agentProfiles: new Map(),
  }

  const cm = createConcurrencyManager(agentId)

  let currentSystemPrompt: string = config.systemPrompt
  let currentModel: string = config.model
  let currentTemperature: number | undefined = config.temperature
  let currentThinking: boolean = config.thinking ?? false
  let historyLimit = config.historyLimit ?? DEFAULTS.historyLimit
  const maxToolIterations = config.maxToolIterations ?? 5
  let toolExecutor = options?.toolExecutor
  let toolDefinitions = options?.toolDefinitions
  const getHousePrompt = options?.getHousePrompt
  const getResponseFormat = options?.getResponseFormat
  const getArtifactsForScope = options?.getArtifactsForScope
  const getArtifactTypeDef = options?.getArtifactTypeDef
  const getCompressedIds = options?.getCompressedIds
  const getSkills = options?.getSkills
  const onEvalEvent = options?.onEvalEvent

  // Agent-level compressed IDs — tracks messages replaced by LLM summaries.
  // Separate from room-level compressedIds (which tracks messages pruned by messageLimit).
  const localCompressedIds = new Set<string>()
  // Guard: rooms currently undergoing async compression — prevents double-compression.
  const compressingRooms = new Set<string>()
  // Active abort controller for stream cancellation
  let activeAbortController: AbortController | null = null

  // --- Name resolution ---

  const resolveName = (senderId: string): string => {
    if (senderId === SYSTEM_SENDER_ID) return 'System'
    if (senderId === agentId) return config.name
    return agentHistory.agentProfiles.get(senderId)?.name ?? senderId
  }

  // --- Context deps ---

  const contextDeps = (): BuildContextDeps => ({
    agentId,
    systemPrompt: currentSystemPrompt,
    housePrompt: getHousePrompt?.(),
    responseFormat: getResponseFormat?.(),
    history: agentHistory,
    historyLimit,
    resolveName,
    getArtifactsForScope,
    getArtifactTypeDef,
    getSkills,
    // Merge room-level pruned IDs with agent-level compression IDs
    getCompressedIds: (roomId: string) => {
      const roomIds = getCompressedIds?.(roomId)
      if (!roomIds || roomIds.size === 0) return localCompressedIds
      if (localCompressedIds.size === 0) return roomIds
      return new Set([...roomIds, ...localCompressedIds])
    },
  })

  // --- Evaluation loop: per-room generation with pending queue ---

  // After an agent responds (not pass), delay pending re-evaluation by this amount.
  // This lets other agents' responses coalesce into a single re-evaluation rather than
  // triggering N separate evals. Major reduction in LLM calls for broadcast rooms.
  const EVAL_COOLDOWN_MS = 500

  const tryEvaluate = (triggerRoomId: string): void => {
    if (cm.isBusy()) {
      cm.addPending(triggerRoomId)
      return
    }

    cm.startGeneration(triggerRoomId)
    cm.notifyState('generating', triggerRoomId)

    const contextResult = buildContext(contextDeps(), triggerRoomId)
    const epoch = cm.epochAtStart()

    const evalConfig = { ...config, model: currentModel, systemPrompt: currentSystemPrompt, temperature: currentTemperature, thinking: currentThinking, historyLimit }
    const inReplyTo = contextResult.flushInfo.ids.size > 0 ? [...contextResult.flushInfo.ids] : undefined
    const abortController = new AbortController()
    activeAbortController = abortController
    const evalEventCb = onEvalEvent
      ? (event: EvalEvent) => onEvalEvent(config.name, event)
      : undefined

    // Emit context_ready + any context builder warnings before LLM call
    if (onEvalEvent) {
      onEvalEvent(config.name, {
        kind: 'context_ready',
        messages: contextResult.messages,
        model: evalConfig.model,
        temperature: evalConfig.temperature,
        toolCount: toolDefinitions?.length ?? 0,
      })
      for (const w of contextResult.warnings) {
        onEvalEvent(config.name, { kind: 'warning', message: w })
      }
    }
    // epoch guards: each cancelGeneration() increments generationEpoch so stale
    // in-flight results from a prior generation cycle are silently discarded.
    const run = async (): Promise<void> => {
      let wasRespond = false
      try {
        const { decision, flushInfo } = await evaluate(
          contextResult, evalConfig, llmProvider, toolExecutor, maxToolIterations,
          triggerRoomId, {
            toolDefinitions,
            inReplyTo,
            onEvent: evalEventCb,
            signal: abortController.signal,
          },
        )
        if (!cm.isEpochCurrent(epoch)) return  // cancelled — discard stale result

        wasRespond = decision.response.action === 'respond'

        // Flush incoming always — on both respond and pass.
        // On pass, the agent has consciously evaluated these messages; they belong in history.
        flushIncoming(flushInfo, agentHistory)
        onDecision(decision)
      } catch (err) {
        if (!cm.isEpochCurrent(epoch)) return  // cancelled, ignore error
        console.error(`[${config.name}] Evaluation error:`, err)
      } finally {
        if (cm.isEpochCurrent(epoch)) {
          cm.endGeneration(triggerRoomId)
          // Check for pending work: same room first, then any other room
          const nextRoom = cm.consumePending(triggerRoomId)
            ? triggerRoomId
            : cm.nextPending() ?? undefined
          if (nextRoom) {
            if (nextRoom !== triggerRoomId) cm.consumePending(nextRoom)
            // After a respond, delay re-evaluation to let other agents' messages coalesce
            if (wasRespond) {
              setTimeout(() => {
                if (cm.isEpochCurrent(epoch)) tryEvaluate(nextRoom)
              }, EVAL_COOLDOWN_MS)
            } else {
              tryEvaluate(nextRoom)
            }
          }
        }
      }
    }
    void run()
  }

  // --- Receive ---
  // All messages have a roomId. Own messages go straight to room history for
  // re-evaluation continuity without triggering a new eval.

  const receive = (message: Message): void => {
    extractProfile(message, agentId, agentHistory.agentProfiles)

    if (message.senderId === agentId) {
      const ctx = agentHistory.rooms.get(message.roomId)
      if (ctx) ctx.history = [...ctx.history, message]
      return
    }

    agentHistory.incoming.push(message)

    if (message.type === 'system' || message.type === 'leave' || message.type === 'pass') return

    // Trigger async compression if processed history exceeds threshold (fire-and-forget)
    const threshold = config.compressionThreshold ?? historyLimit * 3
    const ctx = agentHistory.rooms.get(message.roomId)
    if (ctx && ctx.history.length > threshold && !compressingRooms.has(message.roomId)) {
      void compressRoomHistory(message.roomId)
    }

    tryEvaluate(message.roomId)
  }

  // --- LLM summarisation helper ---
  // Shared by join() (onboarding) and compressRoomHistory() (compression).
  // Formats messages using senderName for readability, then calls callLLM.

  const summariseMessages = async (
    msgs: ReadonlyArray<Message>,
    systemPrompt: string,
    userPrefix?: string,
  ): Promise<string> => {
    const text = msgs
      .filter(m => m.type === 'chat' || m.type === 'room_summary')
      .map(m => `[${m.senderName ?? resolveName(m.senderId)}]: ${m.content}`)
      .join('\n')
    if (!text) return ''
    const userContent = userPrefix ? `${userPrefix}\n\n${text}` : text
    return callLLM(llmProvider, {
      model: currentModel,
      systemPrompt,
      messages: [{ role: 'user', content: userContent }],
      temperature: 0.3,
    })
  }

  // --- History compression ---
  // Replaces messages older than the historyLimit window with an LLM summary.
  // Runs asynchronously — evaluation is never blocked. Guard prevents concurrent runs.

  const COMPRESSION_PROMPT = `Compress the following conversation history into a compact summary paragraph.
Preserve: key decisions, important facts, who said what (use [name] format), unresolved questions.
Respond with only the summary — no preamble or explanation.`

  const compressRoomHistory = async (roomId: string): Promise<void> => {
    compressingRooms.add(roomId)
    try {
      const ctx = agentHistory.rooms.get(roomId)
      if (!ctx) return
      const threshold = config.compressionThreshold ?? historyLimit * 3
      if (ctx.history.length <= threshold) return

      const cutoff = ctx.history.length - historyLimit
      const toCompress = ctx.history.slice(0, cutoff)
      const toKeep = ctx.history.slice(cutoff)

      const summary = await summariseMessages(toCompress, COMPRESSION_PROMPT)
      if (!summary) return

      const summaryMessage: Message = {
        id: crypto.randomUUID(),
        roomId,
        senderId: SYSTEM_SENDER_ID,
        senderName: 'System',
        content: summary,
        timestamp: toCompress.at(-1)?.timestamp ?? Date.now(),
        type: 'room_summary',
      }
      ctx.history = [summaryMessage, ...toKeep]
      for (const m of toCompress) localCompressedIds.add(m.id)
    } catch (err) {
      console.error(`[${config.name}] History compression failed:`, err)
    } finally {
      compressingRooms.delete(roomId)
    }
  }

  // --- Join ---
  // Initialises RoomContext (profile + empty history) BEFORE any messages are
  // delivered. Generates an LLM summary of recent room history for onboarding.

  const JOIN_SUMMARY_PROMPT = `Summarize the following room discussion concisely. When referring to participants, always use the format [participantName]. Include: 1) Main topics discussed 2) Key positions held by each participant 3) Any decisions or open questions. Be brief — this summary helps a new participant catch up.`

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

    try {
      const summary = await summariseMessages(
        recent,
        JOIN_SUMMARY_PROMPT,
        `Room: "${room.profile.name}"\n\nRecent discussion:`,
      )
      if (!summary) return

      const summaryMessage: Message = {
        id: crypto.randomUUID(),
        roomId: room.profile.id,
        senderId: SYSTEM_SENDER_ID,
        senderName: 'System',
        content: summary,
        timestamp: Date.now(),
        type: 'room_summary',
      }
      agentHistory.incoming.push(summaryMessage)
    } catch (err) {
      console.error(`[${config.name}] Failed to generate join summary for ${room.profile.name}:`, err)
    }
  }

  return {
    id: agentId,
    name: config.name,
    kind: 'ai',
    metadata: { model: currentModel, ...(config.tags ? { tags: config.tags } : {}) },
    state: cm.state,
    receive,
    join,
    leave: (roomId: string): void => {
      agentHistory.rooms.delete(roomId)
    },
    whenIdle: cm.whenIdle,
    updateSystemPrompt: (prompt: string) => { currentSystemPrompt = prompt },
    getSystemPrompt: () => currentSystemPrompt,
    updateModel: (model: string) => { currentModel = model },
    getModel: () => currentModel,
    getTemperature: () => currentTemperature,
    updateTemperature: (t: number | undefined) => { currentTemperature = t },
    getHistoryLimit: () => historyLimit,
    updateHistoryLimit: (n: number) => { historyLimit = n },
    getThinking: () => currentThinking,
    updateThinking: (enabled: boolean) => { currentThinking = enabled },
    getTools: () => config.tools,
    getConfig: () => ({ ...config, model: currentModel, systemPrompt: currentSystemPrompt, temperature: currentTemperature, historyLimit }),
    cancelGeneration: () => { activeAbortController?.abort(); activeAbortController = null; cm.cancelAll() },
    refreshTools: (support) => {
      if (support.toolExecutor !== undefined) toolExecutor = support.toolExecutor
      if (support.toolDefinitions !== undefined) toolDefinitions = support.toolDefinitions
    },
    getHistory: (roomId: string) => [...(agentHistory.rooms.get(roomId)?.history ?? [])],
    getIncoming: () => [...agentHistory.incoming],
    getMemoryStats: () => ({
      rooms: [...agentHistory.rooms.entries()].map(([roomId, ctx]) => ({
        roomId,
        roomName: ctx.profile.name,
        messageCount: ctx.history.length,
        lastActiveAt: ctx.lastActiveAt,
      })),
      incomingCount: agentHistory.incoming.length,
      knownAgents: [...new Set([...agentHistory.agentProfiles.values()].map(p => p.name))],
    }),
    clearHistory: (roomId?: string) => {
      if (roomId) {
        const ctx = agentHistory.rooms.get(roomId)
        if (ctx) ctx.history = []
        const remaining = agentHistory.incoming.filter(m => m.roomId !== roomId)
        agentHistory.incoming.length = 0
        agentHistory.incoming.push(...remaining)
      } else {
        for (const ctx of agentHistory.rooms.values()) ctx.history = []
        agentHistory.incoming.length = 0
      }
    },
    deleteHistoryMessage: (roomId: string, messageId: string) => {
      const ctx = agentHistory.rooms.get(roomId)
      if (!ctx) return false
      const idx = ctx.history.findIndex(m => m.id === messageId)
      if (idx === -1) return false
      ctx.history = [...ctx.history.slice(0, idx), ...ctx.history.slice(idx + 1)]
      return true
    },
  }
}
