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
import { resolveModelFallback, FALLBACKABLE_CODES } from './model-fallback.ts'
import type { AgentHistory, Message } from '../core/types/messaging.ts'
import type { Artifact, ArtifactTypeDefinition } from '../core/types/artifact.ts'
import type { EvalEvent } from '../core/types/agent-eval.ts'
import type { LLMProvider } from '../core/types/llm.ts'
import type { Room } from '../core/types/room.ts'
import type { ToolDefinition, ToolExecutor } from '../core/types/tool.ts'
import { DEFAULTS, SYSTEM_SENDER_ID } from '../core/types/constants.ts'
import { extractAgentProfile as extractProfile } from './shared.ts'
import { buildContext, buildSystemSections, estimateTokens, flushIncoming, type BuildContextDeps, type ContextResult } from './context-builder.ts'
import { callLLM, evaluate, type EvalResult, type OnDecision } from './evaluation.ts'
import { createConcurrencyManager } from './concurrency.ts'
import { getContextWindowSync } from '../llm/models/context-window.ts'
import { parsePrefixedModel, isCloudProvider } from '../llm/models/parse-prefix.ts'

// Auto-budget reserves ~30% of a model's context window for tool definitions,
// generation output, and safety margin. Fits typical tool+output overhead
// without requiring users to hand-tune per model.
const AUTO_BUDGET_FRACTION = 0.7
const AUTO_BUDGET_FLOOR = 2000
const AUTO_BUDGET_FALLBACK = 8000

// Resolve a fully-qualified model string for context-window lookup. Cloud-
// prefixed models (e.g. "groq:llama-3.3") look up via the curated table;
// unknown / unprefixed models fall through as Ollama (which queries the
// running Ollama instance for context length).
//
// Uses the shared parser in src/llm/models/parse-prefix.ts so adding a new
// cloud provider in providers-config.ts automatically updates this resolver.
const resolveModelForContext = (fullModel: string): { provider: string; model: string } => {
  const { provider, modelId } = parsePrefixedModel(fullModel)
  // Cloud-prefixed and known → table lookup with the bare modelId.
  if (provider && isCloudProvider(provider)) return { provider, model: modelId }
  // Anything else (no prefix, or prefix not a known cloud provider like
  // "qwen:14b") → Ollama, which queries the running daemon for context length.
  return { provider: 'ollama', model: fullModel }
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
  // Per-call effective-model resolution. When provided, the agent calls this
  // before each LLM request to derive the actual model from the user's
  // preference. Returns the resolved model + whether a fallback was used.
  // Sync to keep the eval hot-path simple; the callback should rely on cached
  // provider state (router.models() snapshot, etc.).
  readonly resolveEffectiveModel?: (preferred: string) => {
    readonly model: string
    readonly fallback: boolean
    readonly reason: string
  }
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
  let currentTriggers: ReadonlyArray<import('../core/triggers/types.ts').Trigger> = config.triggers ?? []
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
    const { provider, model } = resolveModelForContext(currentModel)
    const info = getContextWindowSync(provider, model)
    if (info.contextMax > 0) {
      return Math.max(AUTO_BUDGET_FLOOR, Math.floor(info.contextMax * AUTO_BUDGET_FRACTION))
    }
    return AUTO_BUDGET_FALLBACK
  }

  const resolveModelMax = (): number => {
    const { provider, model } = resolveModelForContext(currentModel)
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
  const resolveEffective = options?.resolveEffectiveModel

  // One-shot notice tracking for model fallback. Key = effective-model id we
  // last fell back to; cleared the moment the agent successfully resolves to
  // its preferred model again, so a subsequent outage re-emits the notice.
  let lastFallbackTarget: string | null = null

  // Per-agent model-fallback resolution + fallbackable error codes live in
  // model-fallback.ts so they can be unit-tested without spinning up the
  // full agent factory.
  // (resolveModelFallback / FALLBACKABLE_CODES imported at top of file)

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

  // Shared eval-with-fallback path used by both the receive-driven run() and
  // the trigger-driven fireTriggerExecute. Encapsulates: build evalConfig
  // from current settings, run evaluate(), and on a fallbackable error retry
  // ONCE with the configured fallback model. Without this helper, both
  // callers had ~30 LOC of identical fallback-retry — a bug-fix surface
  // that two paths could drift on.
  const evaluateWithFallback = async (
    contextResult: ContextResult,
    effectiveModel: string,
    triggerRoomId: string,
    signal: AbortSignal,
    inReplyTo?: ReadonlyArray<string>,
  ): Promise<EvalResult> => {
    const evalConfig = {
      ...config,
      model: effectiveModel,
      persona: currentPersona,
      temperature: currentTemperature,
      thinking: currentThinking,
      historyLimit,
      maxToolResultChars: maxToolResultCharsCfg ?? config.maxToolResultChars,
      maxToolIterations: maxToolIterationsCfg,
    }
    const evalToolExec = includeTools ? toolExecutor : undefined
    const evalToolDefs = includeTools ? toolDefinitions : undefined
    const evalEventCb = onEvalEvent
      ? (event: EvalEvent) => onEvalEvent(config.name, event)
      : undefined
    const evalOpts = {
      ...(evalToolDefs ? { toolDefinitions: evalToolDefs } : {}),
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(evalEventCb ? { onEvent: evalEventCb } : {}),
      signal,
    }

    const first = await evaluate(
      contextResult, evalConfig, llmProvider, evalToolExec,
      maxToolIterationsCfg, triggerRoomId, evalOpts,
    )
    if (first.decision.response.action !== 'error') return first
    if (!FALLBACKABLE_CODES.has(first.decision.response.code)) return first

    const fallback = resolveModelFallback(effectiveModel, config.modelFallback)
    if (!fallback) return first

    if (onEvalEvent) {
      onEvalEvent(config.name, {
        kind: 'model_fallback',
        preferred: effectiveModel,
        effective: fallback,
        reason: 'preferred_unavailable',
      })
    }
    return evaluate(
      contextResult, { ...evalConfig, model: fallback }, llmProvider, evalToolExec,
      maxToolIterationsCfg, triggerRoomId, evalOpts,
    )
  }

  const tryEvaluate = (triggerRoomId: string): void => {
    if (cm.isBusy()) {
      cm.addPending(triggerRoomId)
      return
    }

    cm.startGeneration(triggerRoomId)
    cm.notifyState('generating', triggerRoomId)

    const contextResult = buildContext(contextDeps(), triggerRoomId)
    const epoch = cm.epochAtStart()

    // Resolve effective model per call. `currentModel` is the user's intent
    // (preferred); the resolver decides whether to fall through to a default
    // when the preferred provider isn't currently usable. Identity if no
    // resolver was wired (tests, MCP-only mode).
    const resolved = resolveEffective
      ? resolveEffective(currentModel)
      : { model: currentModel, fallback: false, reason: 'preferred_available' }
    const effectiveModel = resolved.model
    if (resolved.fallback && effectiveModel !== currentModel) {
      // One-shot per fallback target — re-emit only when the target changes
      // (which it does when the preferred model recovers and then breaks again).
      if (lastFallbackTarget !== effectiveModel && onEvalEvent) {
        onEvalEvent(config.name, {
          kind: 'model_fallback',
          preferred: currentModel,
          effective: effectiveModel,
          reason: resolved.reason,
        })
      }
      lastFallbackTarget = effectiveModel
    } else if (!resolved.fallback) {
      lastFallbackTarget = null
    }

    const inReplyTo = contextResult.flushInfo.ids.size > 0 ? [...contextResult.flushInfo.ids] : undefined
    const abortController = new AbortController()
    activeAbortController = abortController

    const effectiveToolDefs = includeTools ? toolDefinitions : undefined

    // Emit context_ready + any context builder warnings before LLM call
    if (onEvalEvent) {
      onEvalEvent(config.name, {
        kind: 'context_ready',
        messages: contextResult.messages,
        model: effectiveModel,
        temperature: currentTemperature,
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
        const { decision, flushInfo } = await evaluateWithFallback(
          contextResult, effectiveModel, triggerRoomId, abortController.signal, inReplyTo,
        )
        if (!cm.isEpochCurrent(epoch)) return  // cancelled — discard stale result

        wasRespond = decision.response.action === 'respond'

        // Flush incoming always — on both respond and pass.
        // On pass, the agent has consciously evaluated these messages; they belong in history.
        flushIncoming(flushInfo, agentHistory)
        onDecision(decision)
      } catch (err) {
        if (!cm.isEpochCurrent(epoch)) return  // cancelled, ignore error
        // Unexpected throw — evaluate() catches LLM-layer errors and converts
        // them to action='error' decisions, so this branch is rare (programmer
        // error, OOM, etc.). Without a synthetic decision, the agent silently
        // goes idle: thinking indicator vanishes, no message, no toast.
        // Surface it as an error decision so the user sees something.
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[${config.name}] Evaluation error:`, err)
        try {
          onDecision({
            response: {
              action: 'error',
              code: 'unknown',
              message: `Unexpected evaluation error: ${message}`,
            },
            generationMs: 0,
            triggerRoomId,
          })
        } catch (decisionErr) {
          console.error(`[${config.name}] onDecision threw while reporting eval error:`, decisionErr)
        }
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

    if (message.type === 'system' || message.type === 'join' || message.type === 'leave' || message.type === 'pass' || message.type === 'error') return

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
    // Resolve effective model — the user's preferred model may be on a dead
    // provider, in which case the resolver picks an available fallback.
    // Without this, joins to busy rooms produced no summary and no UI signal
    // when the preferred provider was down.
    const resolved = resolveEffective
      ? resolveEffective(currentModel)
      : { model: currentModel, fallback: false, reason: 'preferred_available' as const }
    return callLLM(llmProvider, {
      model: resolved.model,
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
      ...(currentTriggers.length > 0 ? { triggers: [...currentTriggers] } : {}),
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
    // --- Triggers ---
    getTriggers: () => currentTriggers,
    addTrigger: (t) => { currentTriggers = [...currentTriggers, t] },
    updateTrigger: (id, patch) => {
      const idx = currentTriggers.findIndex(x => x.id === id)
      if (idx < 0) return false
      const next = [...currentTriggers]
      next[idx] = { ...next[idx]!, ...patch, id }
      currentTriggers = next
      return true
    },
    deleteTrigger: (id) => {
      const before = currentTriggers.length
      currentTriggers = currentTriggers.filter(x => x.id !== id)
      return currentTriggers.length < before
    },
    markTriggerFired: (id, when) => {
      const idx = currentTriggers.findIndex(x => x.id === id)
      if (idx < 0) return
      const next = [...currentTriggers]
      next[idx] = { ...next[idx]!, lastFiredAt: when }
      currentTriggers = next
    },
    // Trigger execute-mode dispatch. Runs the prompt as a transient trailing
    // user message in a normal eval. Pending incoming user messages are held
    // aside (NOT consumed by the trigger) and re-queued after the trigger
    // eval completes — so a user post mid-trigger still gets processed.
    // The trigger prompt is never persisted: not in incoming, not in room
    // history. action='pass' suppresses posting (handles "report only changes").
    fireTriggerExecute: async (prompt: string, roomId: string): Promise<void> => {
      if (cm.isBusy()) return  // defensive; scheduler should have skipped

      const heldIncoming = agentHistory.incoming.splice(0, agentHistory.incoming.length)
      cm.startGeneration(roomId)
      cm.notifyState('generating', roomId)

      const epoch = cm.epochAtStart()
      const abortController = new AbortController()
      activeAbortController = abortController

      try {
        // Resolve effective model (mirrors tryEvaluate).
        const resolved = resolveEffective
          ? resolveEffective(currentModel)
          : { model: currentModel, fallback: false, reason: 'preferred_available' as const }
        const effectiveModel = resolved.model

        const baseCtx = buildContext(contextDeps(), roomId)
        // Append the trigger prompt as a transient trailing user message.
        // Not in incoming, so flushIncoming has nothing to do; the prompt
        // never lands in room history.
        const messages = [
          ...baseCtx.messages,
          { role: 'user' as const, content: prompt },
        ]
        const contextResult = {
          ...baseCtx,
          messages,
          flushInfo: { ids: new Set<string>(), triggerRoomId: roomId },
        }

        const { decision } = await evaluateWithFallback(
          contextResult, effectiveModel, roomId, abortController.signal,
        )
        if (!cm.isEpochCurrent(epoch)) return  // cancelled
        onDecision(decision)
      } catch (err) {
        if (cm.isEpochCurrent(epoch)) {
          console.error(`[${config.name}] trigger execute failed:`, err)
        }
      } finally {
        // Restore held incoming at the front; new arrivals during eval are
        // already at the back. Order preserved: held first, then new.
        if (heldIncoming.length > 0) {
          agentHistory.incoming.unshift(...heldIncoming)
        }
        if (cm.isEpochCurrent(epoch)) {
          cm.endGeneration(roomId)
          // Resume normal eval if anything is queued.
          if (agentHistory.incoming.length > 0) {
            tryEvaluate(agentHistory.incoming[0]!.roomId)
          }
        }
      }
    },
  }
}
