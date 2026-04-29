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

import type { AIAgent, AIAgentConfig, IncludeContext, IncludePrompts, PromptSection, ContextSection } from '../core/types/agent.ts'
import type { AgentHistory, Message } from '../core/types/messaging.ts'
import type { Artifact, ArtifactTypeDefinition } from '../core/types/artifact.ts'
import type { EvalEvent } from '../core/types/agent-eval.ts'
import type { LLMProvider } from '../core/types/llm.ts'
import type { Room } from '../core/types/room.ts'
import type { ToolDefinition, ToolExecutor } from '../core/types/tool.ts'
import { DEFAULTS, SYSTEM_SENDER_ID } from '../core/types/constants.ts'
import { extractAgentProfile as extractProfile } from './shared.ts'
import { buildContext, buildSystemSections, estimateTokens, flushIncoming, type BuildContextDeps } from './context-builder.ts'
import { callLLM, evaluate, type OnDecision } from './evaluation.ts'
import { createConcurrencyManager } from './concurrency.ts'
import { getContextWindowSync } from '../llm/model-context.ts'

// Auto-budget reserves ~30% of a model's context window for tool definitions,
// generation output, and safety margin. Fits typical tool+output overhead
// without requiring users to hand-tune per model.
const AUTO_BUDGET_FRACTION = 0.7
const AUTO_BUDGET_FLOOR = 2000
const AUTO_BUDGET_FALLBACK = 8000

// Split "provider:model" on the FIRST colon only — OpenRouter slugs can
// contain additional colons (e.g. "openrouter:anthropic/claude-3.5:beta").
const splitProviderModel = (fullModel: string): { provider: string; model: string } => {
  const idx = fullModel.indexOf(':')
  if (idx < 0) return { provider: 'ollama', model: fullModel }
  const provider = fullModel.slice(0, idx)
  const model = fullModel.slice(idx + 1)
  // Known cloud prefixes; everything else is treated as Ollama (e.g. "qwen:14b")
  const cloudPrefixes = new Set(['groq', 'cerebras', 'openrouter', 'mistral', 'sambanova', 'anthropic', 'gemini'])
  return cloudPrefixes.has(provider) ? { provider, model } : { provider: 'ollama', model: fullModel }
}

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
  // Current room membership, resolved to profiles. Used by the Participants
  // context section so an agent sees every peer in its room — not only those
  // whose messages it has already observed.
  readonly getRoomMembers?: (roomId: string) => ReadonlyArray<import('../core/types/messaging.ts').AgentProfile>
  readonly getSkills?: (roomName: string) => string
  // Returns the per-room wikis catalog text (index.md + scope.md per bound
  // wiki, deduped across room and per-agent bindings). '' when nothing is bound.
  readonly getWikisCatalog?: (roomId: string, agentId: string) => string
  readonly getScriptContext?: (roomId: string, agentName: string) =>
    | { systemDoc: string; dialogue: ReadonlyArray<{ speaker: string; content: string }> }
    | undefined
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

  let currentPersona: string = config.persona
  let currentModel: string = config.model
  let currentTemperature: number | undefined = config.temperature
  let currentThinking: boolean = config.thinking ?? false
  let historyLimit = config.historyLimit ?? DEFAULTS.historyLimit
  let toolExecutor = options?.toolExecutor
  let toolDefinitions = options?.toolDefinitions
  let currentTools: ReadonlyArray<string> | undefined = config.tools
  let currentTags: ReadonlyArray<string> = config.tags ?? []
  let currentWikiBindings: ReadonlyArray<string> = config.wikiBindings ?? []
  // Context & Prompts toggles — resolve defaults to preserve current behavior
  const includePromptsState: Required<IncludePrompts> = {
    persona: config.includePrompts?.persona ?? true,
    room: config.includePrompts?.room ?? true,
    house: config.includePrompts?.house ?? true,
    responseFormat: config.includePrompts?.responseFormat ?? true,
    skills: config.includePrompts?.skills ?? true,
    wikis: config.includePrompts?.wikis ?? true,
  }
  const includeContextState: Required<IncludeContext> = {
    participants: config.includeContext?.participants ?? true,
    artifacts: config.includeContext?.artifacts ?? true,
    activity: config.includeContext?.activity ?? true,
    knownAgents: config.includeContext?.knownAgents ?? true,
  }
  let includeTools: boolean = config.includeTools ?? true
  let promptsEnabled: boolean = config.promptsEnabled ?? true
  let contextEnabled: boolean = config.contextEnabled ?? true
  let maxToolResultCharsCfg: number | undefined = config.maxToolResultChars
  let maxToolIterationsCfg: number = config.maxToolIterations ?? 5

  // Resolve the system+history token budget from the current model's context
  // window (70% of modelMax, with a fallback constant when the window is unknown).
  const resolveContextTokenBudget = (): number => {
    const { provider, model } = splitProviderModel(currentModel)
    const info = getContextWindowSync(provider, model)
    if (info.contextMax > 0) {
      return Math.max(AUTO_BUDGET_FLOOR, Math.floor(info.contextMax * AUTO_BUDGET_FRACTION))
    }
    return AUTO_BUDGET_FALLBACK
  }

  const resolveModelMax = (): number => {
    const { provider, model } = splitProviderModel(currentModel)
    return getContextWindowSync(provider, model).contextMax
  }
  const getHousePrompt = options?.getHousePrompt
  const getResponseFormat = options?.getResponseFormat
  const getArtifactsForScope = options?.getArtifactsForScope
  const getArtifactTypeDef = options?.getArtifactTypeDef
  const getCompressedIds = options?.getCompressedIds
  const getRoomMembers = options?.getRoomMembers
  const getSkills = options?.getSkills
  const getWikisCatalogOpt = options?.getWikisCatalog
  const getScriptContext = options?.getScriptContext
  const onEvalEvent = options?.onEvalEvent

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
    persona: currentPersona,
    housePrompt: getHousePrompt?.(),
    responseFormat: getResponseFormat?.(),
    history: agentHistory,
    historyLimit,
    resolveName,
    getArtifactsForScope,
    getArtifactTypeDef,
    getSkills,
    getWikisCatalog: getWikisCatalogOpt ? (roomId: string) => getWikisCatalogOpt(roomId, agentId) : undefined,
    getScriptContext,
    includePrompts: includePromptsState,
    includeContext: includeContextState,
    promptsEnabled,
    contextEnabled,
    contextTokenBudget: resolveContextTokenBudget(),
    getCompressedIds: (roomId: string) => getCompressedIds?.(roomId) ?? new Set<string>(),
    getRoomMembers,
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

    const evalConfig = {
      ...config,
      model: currentModel,
      persona: currentPersona,
      temperature: currentTemperature,
      thinking: currentThinking,
      historyLimit,
      maxToolResultChars: maxToolResultCharsCfg ?? config.maxToolResultChars,
      maxToolIterations: maxToolIterationsCfg,
    }
    const inReplyTo = contextResult.flushInfo.ids.size > 0 ? [...contextResult.flushInfo.ids] : undefined
    const abortController = new AbortController()
    activeAbortController = abortController
    const evalEventCb = onEvalEvent
      ? (event: EvalEvent) => onEvalEvent(config.name, event)
      : undefined

    const effectiveToolDefs = includeTools ? toolDefinitions : undefined

    // Emit context_ready + any context builder warnings before LLM call
    if (onEvalEvent) {
      onEvalEvent(config.name, {
        kind: 'context_ready',
        messages: contextResult.messages,
        model: evalConfig.model,
        temperature: evalConfig.temperature,
        toolCount: effectiveToolDefs?.length ?? 0,
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
          contextResult, evalConfig, llmProvider, includeTools ? toolExecutor : undefined, maxToolIterationsCfg,
          triggerRoomId, {
            toolDefinitions: effectiveToolDefs,
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

    if (message.type === 'system' || message.type === 'join' || message.type === 'leave' || message.type === 'pass') return

    tryEvaluate(message.roomId)
  }

  // --- LLM summarisation helper ---
  // Used by join() to produce an onboarding summary for a new room member.

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

  // --- Join ---
  // Initialises RoomContext (profile + empty history) BEFORE any messages are
  // delivered. Generates an LLM summary of recent room history for onboarding.

  const JOIN_SUMMARY_PROMPT = `Summarize the following room discussion concisely. When referring to participants, always use the format [participantName]. Include: 1) Main topics discussed 2) Key positions held by each participant 3) Any decisions or open questions. Be brief — this summary helps a new participant catch up.`

  const join = async (room: Room): Promise<void> => {
    // Initialise context — profile available here, before messages arrive.
    // Use a getter so the stored profile tracks the Room live (room name and
    // roomPrompt can change after the agent joins; stale snapshots broke the
    // Context panel's room-prompt preview).
    agentHistory.rooms.set(room.profile.id, {
      get profile() { return room.profile },
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

  // Live metadata — mutated by updateTags so team.listByTag sees current
  // values without needing to rebuild the agent.
  const liveMetadata: Record<string, unknown> = { model: currentModel, tags: currentTags }

  return {
    id: agentId,
    name: config.name,
    kind: 'ai',
    metadata: liveMetadata,
    state: cm.state,
    receive,
    join,
    leave: (roomId: string): void => {
      agentHistory.rooms.delete(roomId)
    },
    whenIdle: cm.whenIdle,
    getTags: () => currentTags,
    updateTags: (tags: ReadonlyArray<string>) => {
      currentTags = tags
      liveMetadata.tags = tags
    },
    updatePersona: (persona: string) => { currentPersona = persona },
    getPersona: () => currentPersona,
    updateModel: (model: string) => { currentModel = model },
    getModel: () => currentModel,
    getTemperature: () => currentTemperature,
    updateTemperature: (t: number | undefined) => { currentTemperature = t },
    getHistoryLimit: () => historyLimit,
    updateHistoryLimit: (n: number) => { historyLimit = n },
    getThinking: () => currentThinking,
    updateThinking: (enabled: boolean) => { currentThinking = enabled },
    getTools: () => currentTools,
    updateTools: (tools: ReadonlyArray<string>) => { currentTools = tools },
    getIncludePrompts: () => ({ ...includePromptsState }),
    updateIncludePrompts: (partial: IncludePrompts) => {
      for (const key of Object.keys(partial) as PromptSection[]) {
        const v = partial[key]
        if (typeof v === 'boolean') includePromptsState[key] = v
      }
    },
    getIncludeContext: () => ({ ...includeContextState }),
    updateIncludeContext: (partial: IncludeContext) => {
      for (const key of Object.keys(partial) as ContextSection[]) {
        const v = partial[key]
        if (typeof v === 'boolean') includeContextState[key] = v
      }
    },
    getIncludeTools: () => includeTools,
    updateIncludeTools: (enabled: boolean) => { includeTools = enabled },
    getPromptsEnabled: () => promptsEnabled,
    updatePromptsEnabled: (enabled: boolean) => { promptsEnabled = enabled },
    getContextEnabled: () => contextEnabled,
    updateContextEnabled: (enabled: boolean) => { contextEnabled = enabled },
    getMaxToolResultChars: () => maxToolResultCharsCfg,
    updateMaxToolResultChars: (n: number | undefined) => {
      maxToolResultCharsCfg = (typeof n === 'number' && n > 0) ? n : undefined
    },
    getMaxToolIterations: () => maxToolIterationsCfg,
    updateMaxToolIterations: (n: number | undefined) => {
      maxToolIterationsCfg = (typeof n === 'number' && n > 0) ? n : 5
    },
    getWikiBindings: () => currentWikiBindings,
    updateWikiBindings: (ids: ReadonlyArray<string>) => {
      const seen = new Set<string>()
      const out: string[] = []
      for (const id of ids) { if (!seen.has(id)) { seen.add(id); out.push(id) } }
      currentWikiBindings = out
    },
    getContextPreview: (roomId: string) => {
      const deps = contextDeps()
      const sections = buildSystemSections(deps, roomId)
      const roomCtx = agentHistory.rooms.get(roomId)
      const previewSections = sections.map(s => ({
        key: s.key,
        label: s.label,
        text: s.text,
        tokens: estimateTokens(s.text),
        enabled: s.enabled,
        optional: s.optional,
      }))
      // History estimate: rough char count over the post-trim window.
      const history = roomCtx?.history ?? []
      const windowed = history.length > historyLimit ? history.slice(-historyLimit) : history
      const historyChars = windowed.reduce((sum, m) => sum + m.content.length, 0)
      return {
        roomId,
        roomName: roomCtx?.profile.name ?? '',
        sections: previewSections,
        modelMax: resolveModelMax(),
        historyEstimate: { messages: windowed.length, chars: historyChars },
      }
    },
    getConfig: () => ({
      ...config,
      model: currentModel,
      persona: currentPersona,
      temperature: currentTemperature,
      historyLimit,
      tools: currentTools,
      tags: currentTags,
      includePrompts: { ...includePromptsState },
      includeContext: { ...includeContextState },
      includeTools,
      promptsEnabled,
      contextEnabled,
      maxToolResultChars: maxToolResultCharsCfg,
      maxToolIterations: maxToolIterationsCfg,
      ...(currentWikiBindings.length > 0 ? { wikiBindings: [...currentWikiBindings] } : {}),
    }),
    cancelGeneration: () => { activeAbortController?.abort(); activeAbortController = null; cm.cancelAll() },
    refreshTools: (support) => {
      if (support.toolExecutor !== undefined) toolExecutor = support.toolExecutor
      if (support.toolDefinitions !== undefined) toolDefinitions = support.toolDefinitions
    },
    // Manual-mode primitive: append unseen messages to the room's history
    // without triggering eval or compression. `extractProfile` still runs so
    // peer profile awareness stays current. No-op for rooms the agent isn't
    // in — relies on a prior `join()`.
    ingestHistory: (roomId: string, messages: ReadonlyArray<Message>): void => {
      const ctx = agentHistory.rooms.get(roomId)
      if (!ctx) return
      const seen = new Set(ctx.history.map(m => m.id))
      for (const msg of messages) {
        if (seen.has(msg.id)) continue
        extractProfile(msg, agentId, agentHistory.agentProfiles)
        ctx.history = [...ctx.history, msg]
        seen.add(msg.id)
      }
    },
    // Manual-mode primitive: force one evaluation for the given room, bypassing
    // the room's delivery-mode check. If the agent is busy elsewhere, the
    // concurrency manager queues this via its own pending list.
    forceEvaluate: (roomId: string): void => {
      tryEvaluate(roomId)
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
    forgetAgent: (removedAgentId: string) => {
      // Drop the cached profile so this agent no longer lists the removed
      // participant under "Known agents". Messages that referenced the ID
      // remain in history (with the sender name now resolving to raw id),
      // but that's acceptable — history is immutable record.
      agentHistory.agentProfiles.delete(removedAgentId)
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
