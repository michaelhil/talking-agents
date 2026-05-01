// ============================================================================
// samsinn — System Factory + Entry Point
//
// createSystem() builds the full system. Can be imported without side effects.
// When run directly (bun run src/main.ts), starts up and prints diagnostics.
// ============================================================================

import type { Agent, AIAgent, AIAgentConfig, RouteMessage, Team } from './core/types/agent.ts'
import type { DeliverFn, ResolveAgentName, ResolveTagFn } from './core/types/messaging.ts'
import type {
  House, HouseCallbacks, OnBookmarksChanged, OnDeliveryModeChanged,
  OnMembershipChanged, OnMessagePosted, OnModeAutoSwitched,
  OnRoomCreated, OnRoomDeleted, OnSummaryConfigChanged, OnSummaryUpdated,
  OnTurnChanged,
} from './core/types/room.ts'
import type { SummaryScheduler, SummaryTarget } from './core/summaries/summary-scheduler.ts'
import { createSummaryEngine } from './core/summaries/summary-engine.ts'
import { createSummaryScheduler } from './core/summaries/summary-scheduler.ts'
import { createTriggerScheduler, type TriggerScheduler } from './core/triggers/scheduler.ts'
import type { OnArtifactChanged } from './core/types/artifact.ts'
import type { OnEvalEvent } from './core/types/agent-eval.ts'
import type { ToolRegistry } from './core/types/tool.ts'
import type { OnProviderBound, OnProviderAllFailed, OnProviderStreamFailed } from './core/types/llm.ts'
import type { ProviderRoutingEvent } from './llm/router.ts'
import { createHouse } from './core/house.ts'
import { asAIAgent } from './agents/shared.ts'
import { createTeam } from './agents/team.ts'
import { createMessageRouter } from './core/delivery.ts'
import type { LLMGateway } from './llm/gateway.ts'
import type { ProviderRouter } from './llm/router.ts'
import type { ProviderSetupResult } from './llm/providers-setup.ts'
import type { ProviderConfig } from './llm/providers-config.ts'
import type { ProviderKeys } from './llm/provider-keys.ts'
import { createSharedRuntime, type SharedRuntime } from './core/shared-runtime.ts'
import { buildWikisCatalog } from './wiki/catalog.ts'
import type { LimitMetrics } from './core/limit-metrics.ts'
import type { ProviderGateway } from './llm/provider-gateway.ts'
import { createOverlayToolRegistry } from './core/tool-registry.ts'
import { spawnAIAgent, spawnHumanAgent, buildToolSupport, type SpawnOptions } from './agents/spawn.ts'
import { resolveEffectiveModel as resolveEffectiveModelFn } from './agents/resolve-model.ts'
import { callLLM } from './agents/evaluation.ts'
import { createHumanAgent } from './agents/human-agent.ts'
import type { HumanAgentConfig, TransportSend } from './agents/human-agent.ts'
import type { HumanAgent } from './agents/human-agent.ts'
import { createRoomOperations } from './core/room-operations.ts'
import {
  // House-bound built-ins (registered into the per-instance overlay).
  // Process-wide built-ins (createPassTool, createGetTimeTool, createWebTools,
  // createTestToolTool, createListSkillsTool, createWriteSkillTool,
  // createWriteToolTool, createPackTools) live in shared.sharedToolRegistry —
  // see bootstrap.ts.
  createListRoomsTool,
  createCreateRoomTool, createDeleteRoomTool, createAddToRoomTool, createRemoveFromRoomTool,
  createListAgentsTool, createGetMyContextTool, createSetDeliveryModeTool,
  createPauseRoomTool, createMuteAgentTool, createSetRoomPromptTool,
  createPostToRoomTool, createGetRoomHistoryTool,
  createListArtifactTypesTool, createListArtifactsTool, createAddArtifactTool,
  createUpdateArtifactTool, createRemoveArtifactTool, createCastVoteTool,
  createWriteDocumentSectionTool,
} from './tools/built-in/index.ts'
import { createTaskListArtifactType } from './core/artifact-types/task-list.ts'
import { pollArtifactType } from './core/artifact-types/poll.ts'
import { documentArtifactType } from './core/artifact-types/document.ts'
import { mermaidArtifactType } from './core/artifact-types/mermaid.ts'
import { mapArtifactType } from './core/artifact-types/map.ts'
// Native-only tool calling — no capability probing needed
import { type SkillStore } from './skills/loader.ts'
import { createScriptStore, type ScriptStore } from './core/scripts/script-store.ts'
import { createScriptRunner, type ScriptRunner, type ScriptEventEmitter } from './core/scripts/script-runner.ts'
import { createWriteScriptTool } from './tools/built-in/script-codegen.ts'
import { sharedPaths } from './core/paths.ts'

import { createOllamaUrlRegistry, type OllamaUrlRegistry } from './core/ollama-urls.ts'
export type { OllamaUrlRegistry }

import type { LogConfig, LogConfigState, LogEvent, LogSink } from './logging/types.ts'
import { createJsonlFileSink } from './logging/jsonl-sink.ts'
import { matchesKindFilter, validateLogConfig, defaultLogDir, defaultSessionId } from './logging/config.ts'
import {
  mkArtifactChanged, mkDeliveryModeChanged, mkEvalEvent,
  mkMembershipChanged, mkMessagePosted, mkModeAutoSwitched,
  mkProviderAllFailed, mkProviderBound, mkProviderStreamFailed,
  mkRoomCreated, mkRoomDeleted, mkSessionEnd, mkSessionStart,
  mkSummaryConfigChanged, mkSummaryRunCompleted, mkSummaryRunFailed,
  mkSummaryRunStarted, mkSummaryUpdated,
} from './logging/event-mapping.ts'

export interface System {
  readonly house: House
  readonly team: Team
  readonly routeMessage: RouteMessage
  // Provider-neutral LLM access. All agents and callSystemLLM go through here.
  readonly llm: ProviderRouter
  // Direct Ollama gateway (present iff Ollama is a configured provider).
  // Used by the Ollama dashboard UI for ps/loadModel; not for routing.
  readonly ollama: LLMGateway | undefined
  readonly providerConfig: ProviderConfig
  // Mutable registry of current API keys, read by gateways at request time.
  // Used by the providers admin endpoints to apply key changes without restart.
  readonly providerKeys: ProviderKeys
  // Per-provider gateways — exposed so admin endpoints can refresh model
  // caches when keys change.
  readonly gateways: Record<string, ProviderGateway>
  // Per-provider monitors — single source of truth for routing eligibility
  // and the recent-failures log surfaced in the providers admin UI.
  readonly monitors: Record<string, import('./llm/provider-monitor.ts').ProviderMonitor>
  // Refresh the cached available-models snapshot used by per-call effective-
  // model resolution. Called at boot and after any provider config change so
  // agents picking up a fallback get the latest list. Mirrors the wiki
  // resolveActiveWikis "derive on read" pattern (no boot-time freeze).
  readonly refreshAvailableModels: () => Promise<void>
  readonly toolRegistry: ToolRegistry
  // Refresh every AI agent's ToolExecutor / ToolDefinitions to reflect the
  // current registry. Called by the tool-rescan endpoint and by write_tool.
  readonly refreshAllAgentTools: () => Promise<void>
  readonly skillStore: SkillStore
  readonly skillsDir: string
  readonly scriptStore: ScriptStore
  readonly scriptsDir: string
  readonly scriptRunner: ScriptRunner
  readonly setOnScriptEvent: (cb: ScriptEventEmitter) => void
  readonly packsDir: string
  readonly knowledgeDir: string
  readonly providersStorePath: string
  readonly wikisStorePath: string
  // Shared wiki registry — read by tools and the wiki admin endpoints.
  readonly wikiRegistry: import('./wiki/registry.ts').WikiRegistry
  // Trigger scheduler — REST handlers call invalidate() after mutating an
  // agent's trigger list so the cached "any triggers exist" flag stays
  // accurate and the timer starts/stops correctly. See lever 2 in
  // src/core/triggers/scheduler.ts.
  readonly triggerScheduler: import('./core/triggers/scheduler.ts').TriggerScheduler
  // OllamaUrls editor — no-op when Ollama isn't configured.
  readonly ollamaUrls: OllamaUrlRegistry
  readonly removeAgent: (id: string) => boolean
  readonly removeRoom: (roomId: string) => boolean
  // Clear every room, agent, and artifact from the running instance. Used by
  // the `reset_system` MCP tool in the experiment runner's persistent-process
  // mode so a single subprocess can serve many independent runs. Leaves the
  // tool registry, skill store, provider router, and snapshot wiring alone —
  // only the per-conversation state is reset. In-flight AI generations get a
  // bounded `whenIdle(5000)` + `cancelGeneration()` before the agent is
  // removed so results from cancelled runs don't post into the next run.
  readonly resetState: () => Promise<{ readonly rooms: number; readonly agents: number; readonly artifacts: number }>
  readonly addAgentToRoom: (agentId: string, roomId: string, invitedBy?: string) => Promise<void>
  readonly removeAgentFromRoom: (agentId: string, roomId: string, removedBy?: string) => void
  readonly spawnAIAgent: (config: AIAgentConfig, options?: SpawnOptions) => Promise<Agent>
  readonly spawnHumanAgent: (config: HumanAgentConfig, send: TransportSend, options?: { overrideId?: string }) => Promise<HumanAgent>
  // Manual-mode activation: catch the agent up and force one eval.
  readonly activateAgentInRoom: (agentId: string, roomId: string) => { ok: boolean; queued: boolean; reason?: string }
  readonly setOnMessagePosted: (callback: OnMessagePosted) => void
  readonly setOnTurnChanged: (callback: OnTurnChanged) => void
  readonly setOnDeliveryModeChanged: (callback: OnDeliveryModeChanged) => void
  readonly setOnModeAutoSwitched: (callback: OnModeAutoSwitched) => void
  readonly setOnArtifactChanged: (callback: OnArtifactChanged) => void
  readonly setOnRoomCreated: (callback: OnRoomCreated) => void
  readonly setOnRoomDeleted: (callback: OnRoomDeleted) => void
  readonly setOnMembershipChanged: (callback: OnMembershipChanged) => void
  readonly setOnBookmarksChanged: (callback: OnBookmarksChanged) => void
  readonly setOnEvalEvent: (callback: OnEvalEvent) => void
  readonly setOnProviderBound: (callback: OnProviderBound) => void
  readonly setOnProviderAllFailed: (callback: OnProviderAllFailed) => void
  readonly setOnProviderStreamFailed: (callback: OnProviderStreamFailed) => void
  // Dispatch entry point for the provider router (wired in Phase 4 via
  // router.onRoutingEvent(system.dispatchProviderEvent)).
  readonly dispatchProviderEvent: (event: ProviderRoutingEvent) => void
  // Summary + compression scheduler (per-room). Exposed so REST/WS can call
  // triggerNow() for manual regenerate.
  readonly summaryScheduler: SummaryScheduler
  readonly setOnSummaryRunStarted: (cb: (roomId: string, target: SummaryTarget) => void) => void
  readonly setOnSummaryRunDelta: (cb: (roomId: string, target: SummaryTarget, delta: string) => void) => void
  readonly setOnSummaryRunCompleted: (cb: (roomId: string, target: SummaryTarget, text: string) => void) => void
  readonly setOnSummaryRunFailed: (cb: (roomId: string, target: SummaryTarget, reason: string) => void) => void
  readonly setOnSummaryConfigChanged: (cb: OnSummaryConfigChanged) => void

  // --- Observational logging (opt-in; off by default) ---
  // Subscribe an observer to every event kind supported by src/logging.
  // Returns an unsubscribe function. Used by the file-sink wiring in
  // bootstrap and by the runtime-reconfigure path (system.logging).
  readonly addEventObserver: (observer: LogEventObserver) => () => void
  readonly logging: LoggingHandle

  // --- Process-global limit/cap counters (held on SharedRuntime) ---
  // Same instance across every System in this process; surfaced via
  // GET /api/system/limits.
  readonly limitMetrics: LimitMetrics
}

// --- Logging handle — runtime on/off + location/session/kind control ---

export type LogEventObserver = (event: LogEvent) => void

export interface LoggingHandle {
  readonly get: () => LogConfigState
  // Swap the active sink. Drains + closes the previous sink, optionally
  // opens a new one (if enabled). Emits session.end on the old sink and
  // session.start on the new one for bracketing. Rejects on invalid config.
  readonly configure: (partial: Partial<LogConfig>) => Promise<void>
}

export interface CreateSystemOptions {
  // Pre-built shared runtime. When passed, createSystem skips internal
  // provider construction and uses these. Phase D's HouseRegistry passes
  // one shared runtime to many createSystem calls — that's the whole point.
  readonly shared?: SharedRuntime
  // Legacy: when shared is absent, build from these (preserves test API).
  readonly providerConfig?: ProviderConfig
  readonly providerSetup?: ProviderSetupResult
  // Diagnostic label used in unsubscribed-callback warnings (lateBinding).
  // Threaded by the registry; tests/headless paths can omit (becomes "?").
  readonly instanceLabel?: string
}

export const createSystem = (options: CreateSystemOptions = {}): System => {
  // Either reuse a shared runtime (multi-instance) or build one inline
  // (legacy single-tenant + tests). The result is the same shape either way.
  const sharedWasGiven = options.shared !== undefined
  const shared: SharedRuntime = options.shared ?? createSharedRuntime({
    ...(options.providerConfig ? { providerConfig: options.providerConfig } : {}),
    ...(options.providerSetup ? { providerSetup: options.providerSetup } : {}),
  })
  const { providerConfig, providerKeys, providerSetup } = shared
  const { router: llm, ollama, ollamaRaw, gateways, monitors } = providerSetup
  const team = createTeam()

  const deliver: DeliverFn = (agentId, message) => {
    team.getAgent(agentId)?.receive(message)
  }

  // `set` preserves the existing primary-consumer semantics (one typed
  // subscriber — WS broadcast or MCP notifications). `add` is the multi-
  // subscriber escape hatch added for observational logging (v1 second
  // consumer). The proxy dispatches to the primary first, then observers;
  // each observer is wrapped in try/catch so one failing observer doesn't
  // stop the others. Observers iterate over a snapshot so unsubscribe
  // during dispatch is safe.
  //
  // Warn-once on missing subscriber: when `proxy(...)` fires before
  // `set(...)` has been called AND no observers are registered, log one
  // console.warn the first time per (slot name, instanceLabel) pair so a
  // wiring miss is visible immediately. Subsequent dropped events stay
  // silent. The bug fixed in 5d73a8e was invisible for three days because
  // there was no signal at all when the wiring was skipped.
  const instanceLabel = options.instanceLabel ?? '?'
  const lateBinding = <T extends (...args: never[]) => void>(slotName: string): {
    proxy: T
    set: (cb: T) => void
    add: (cb: T) => () => void
  } => {
    let real: T | undefined
    const observers: T[] = []
    let warnedNoSubscriber = false
    const proxy = ((...args: Parameters<T>) => {
      if (real) {
        try { real(...args) } catch (err) {
          console.error(`[lateBinding] primary callback threw: ${err instanceof Error ? err.message : String(err)}`)
        }
      } else if (observers.length === 0 && !warnedNoSubscriber) {
        warnedNoSubscriber = true
        console.warn(`[lateBinding] ${slotName} has no subscriber for instance ${instanceLabel} — first event dropped, subsequent dropped silently`)
      }
      const snapshot = [...observers]
      for (const cb of snapshot) {
        try { cb(...args) } catch (err) {
          console.error(`[lateBinding] observer threw: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }) as T
    return {
      proxy,
      set: (cb: T) => { real = cb },
      add: (cb: T) => {
        observers.push(cb)
        return () => {
          const i = observers.indexOf(cb)
          if (i >= 0) observers.splice(i, 1)
        }
      },
    }
  }

  const messagePosted = lateBinding<OnMessagePosted>('messagePosted')
  const turnChanged = lateBinding<OnTurnChanged>('turnChanged')
  const deliveryModeChanged = lateBinding<OnDeliveryModeChanged>('deliveryModeChanged')
  const artifactChanged = lateBinding<OnArtifactChanged>('artifactChanged')
  const roomCreated = lateBinding<OnRoomCreated>('roomCreated')
  const roomDeleted = lateBinding<OnRoomDeleted>('roomDeleted')
  const membershipChanged = lateBinding<OnMembershipChanged>('membershipChanged')
  const bookmarksChanged = lateBinding<OnBookmarksChanged>('bookmarksChanged')
  const modeAutoSwitched = lateBinding<OnModeAutoSwitched>('modeAutoSwitched')
  const evalEvent = lateBinding<OnEvalEvent>('evalEvent')
  const providerBound = lateBinding<OnProviderBound>('providerBound')
  const providerAllFailed = lateBinding<OnProviderAllFailed>('providerAllFailed')
  const providerStreamFailed = lateBinding<OnProviderStreamFailed>('providerStreamFailed')
  const summaryConfigChanged = lateBinding<OnSummaryConfigChanged>('summaryConfigChanged')
  const summaryUpdated = lateBinding<OnSummaryUpdated>('summaryUpdated')
  const summaryRunStarted = lateBinding<(roomId: string, target: SummaryTarget) => void>('summaryRunStarted')
  const summaryRunDelta = lateBinding<(roomId: string, target: SummaryTarget, delta: string) => void>('summaryRunDelta')
  const summaryRunCompleted = lateBinding<(roomId: string, target: SummaryTarget, text: string) => void>('summaryRunCompleted')
  const summaryRunFailed = lateBinding<(roomId: string, target: SummaryTarget, reason: string) => void>('summaryRunFailed')
  const scriptHook = lateBinding<(roomId: string, message: import('./core/types/messaging.ts').Message) => void>('scriptHook')
  const scriptEvent = lateBinding<ScriptEventEmitter>('scriptEvent')

  const resolveAgentName: ResolveAgentName = (name) => team.getAgent(name)?.id
  const resolveTag: ResolveTagFn = (tag) => team.listByTag(tag).map(a => a.id)
  const resolveKind = (id: string): 'ai' | 'human' | undefined => team.getAgent(id)?.kind

  const ollamaUrls: OllamaUrlRegistry = createOllamaUrlRegistry(ollamaRaw, ollama)

  // Forward-declared: the summary scheduler is built after `house`, but the
  // house's onMessagePosted callback needs to feed into it. We bridge with a
  // mutable slot that's set after construction.
  let schedulerRef: SummaryScheduler | undefined

  const houseCallbacks: HouseCallbacks = {
    deliver,
    resolveAgentName,
    resolveTag,
    resolveKind,
    onMessagePosted: (roomId, message) => {
      messagePosted.proxy(roomId, message)
      schedulerRef?.onMessagePosted(roomId, message)
      scriptHook.proxy(roomId, message)
    },
    onTurnChanged: turnChanged.proxy,
    onDeliveryModeChanged: deliveryModeChanged.proxy,
    onArtifactChanged: artifactChanged.proxy,
    onRoomCreated: roomCreated.proxy,
    onRoomDeleted: (roomId, roomName) => {
      roomDeleted.proxy(roomId, roomName)
      schedulerRef?.onRoomRemoved(roomId)
    },
    onBookmarksChanged: bookmarksChanged.proxy,
    onManualModeEntered: (roomId: string) => { cancelGenerationsInRoom(roomId) },
    onModeAutoSwitched: modeAutoSwitched.proxy,
    onSummaryConfigChanged: (roomId, config) => {
      summaryConfigChanged.proxy(roomId, config)
      schedulerRef?.onConfigChanged(roomId)
    },
    onSummaryUpdated: summaryUpdated.proxy,
    callSystemLLM: (options) => callLLM(llm, options),
  }
  const house = createHouse(houseCallbacks)
  const routeMessage = createMessageRouter({ house })
  // Per-instance overlay over the process-shared tool registry. Pack tools,
  // skill-bundled tools, external tools, MCP tools and the codegen suite
  // live in shared (registered once at boot). Only house-bound built-ins
  // (room ops, artifacts, post_to_room, write_document_section, write_script)
  // register into the overlay below.
  const toolRegistry = createOverlayToolRegistry(shared.sharedToolRegistry)

  // Summary engine + scheduler — default model is the first AI agent's model,
  // or a fallback when none exists yet.
  const defaultSummaryModel = (): string => {
    const firstAi = team.listByKind('ai')[0]
    const model = firstAi ? (firstAi as AIAgent).getModel?.() : undefined
    return model ?? 'llama3.2'
  }
  const summaryEngine = createSummaryEngine({ llm, defaultModel: defaultSummaryModel })
  const summaryScheduler = createSummaryScheduler({
    engine: summaryEngine,
    getRoom: (id) => house.getRoom(id),
    onRunStarted: (roomId, target) => summaryRunStarted.proxy(roomId, target),
    onRunDelta: (roomId, target, delta) => summaryRunDelta.proxy(roomId, target, delta),
    onRunCompleted: (roomId, target, text) => summaryRunCompleted.proxy(roomId, target, text),
    onRunFailed: (roomId, target, reason) => summaryRunFailed.proxy(roomId, target, reason),
  })
  schedulerRef = summaryScheduler

  // Trigger scheduler — per-agent scheduled prompts. Idle when no triggers
  // exist (lever 1+2 in createTriggerScheduler); restarts on first add.
  const triggerScheduler: TriggerScheduler = createTriggerScheduler({
    team,
    house,
  })

  // Register built-in artifact types — task_list needs store reference for checkAutoResolve
  house.artifactTypes.register(createTaskListArtifactType(house.artifacts))
  house.artifactTypes.register(pollArtifactType)
  house.artifactTypes.register(documentArtifactType)
  house.artifactTypes.register(mermaidArtifactType)
  house.artifactTypes.register(mapArtifactType)


  // System-level membership operations — extracted to core/room-operations.ts.
  const roomOps = createRoomOperations({
    team,
    house,
    routeMessage,
    onMembershipChanged: (...args) => membershipChanged.proxy(...args),
    triggerScheduler,
  })
  const systemAddAgentToRoom = roomOps.addAgentToRoom
  const systemRemoveAgentFromRoom = roomOps.removeAgentFromRoom
  const systemRemoveRoom = roomOps.removeRoom
  const cancelGenerationsInRoom = roomOps.cancelGenerationsInRoom

  // Explicit one-turn activation for manual mode. Catches the agent up on
  // messages it hasn't seen, then forces a single evaluation. If the agent
  // is busy generating elsewhere, `tryEvaluate` queues internally — callers
  // surface the `queued: true` result as a UI toast.
  const activateAgentInRoom = (
    agentId: string,
    roomId: string,
  ): { ok: boolean; queued: boolean; reason?: string } => {
    const room = house.getRoom(roomId)
    if (!room) return { ok: false, queued: false, reason: 'room not found' }
    if (room.deliveryMode !== 'manual') {
      return { ok: false, queued: false, reason: 'room is not in manual mode' }
    }
    const agent = team.getAgent(agentId)
    if (!agent || agent.kind !== 'ai') {
      return { ok: false, queued: false, reason: 'agent is not an AI agent in this room' }
    }
    if (!room.hasMember(agentId)) {
      return { ok: false, queued: false, reason: 'agent is not a member of this room' }
    }
    if (room.isMuted(agentId)) {
      return { ok: false, queued: false, reason: 'agent is muted' }
    }
    const ai = asAIAgent(agent)
    if (!ai || !ai.ingestHistory || !ai.forceEvaluate) {
      return { ok: false, queued: false, reason: 'agent does not support manual activation' }
    }
    const recent = room.getRecent((ai.getHistoryLimit() ?? 20) * 2)
    ai.ingestHistory(roomId, recent)
    const queued = agent.state.get() === 'generating' && agent.state.getContext() !== roomId
    ai.forceEvaluate(roomId)
    return { ok: true, queued }
  }

  // Reset all per-conversation state. See interface doc for what's preserved.
  // For each AI agent: bounded whenIdle(5000) + cancelGeneration so in-flight
  // tool loops or streams don't later post into a freshly-reset room. Human
  // agents have no generation loop so they're removed directly.
  const resetState = async (): Promise<{ rooms: number; agents: number; artifacts: number }> => {
    const agents = team.listAgents()
    let agentCount = 0
    for (const agent of agents) {
      const ai = asAIAgent(agent)
      if (ai) {
        try {
          await ai.whenIdle(5000)
        } catch {
          // whenIdle rejects on timeout — proceed with a forced cancel.
        }
        try { ai.cancelGeneration() } catch { /* best-effort */ }
      }
      if (removeAgent(agent.id)) agentCount++
    }
    const rooms = house.listAllRooms()
    let roomCount = 0
    for (const profile of rooms) {
      if (systemRemoveRoom(profile.id)) roomCount++
    }
    const artifactCount = house.artifacts.list().length
    house.artifacts.clear()
    return { rooms: roomCount, agents: agentCount, artifacts: artifactCount }
  }

  const removeAgent = (id: string): boolean => {
    const agent = team.getAgent(id)
    if (!agent) return false
    for (const profile of house.listAllRooms()) {
      const room = house.getRoom(profile.id)
      if (room?.hasMember(id)) {
        systemRemoveAgentFromRoom(id, profile.id)
      }
    }
    const removed = team.removeAgent(id)
    // Prune this ID from every surviving AI agent's "known agents" cache so
    // it doesn't linger as a phantom entry after deletion.
    if (removed) {
      for (const other of team.listByKind('ai')) {
        const ai = asAIAgent(other)
        ai?.forgetAgent?.(id)
      }
      // Triggers live on the agent — they go with it. The scheduler's
      // anyTriggers cache might be stale; refresh it.
      triggerScheduler.invalidate()
    }
    return removed
  }

  // Register HOUSE-BOUND built-in tools into the per-instance overlay.
  // Process-wide tools (pass, get_time, web *, test_tool, list_skills,
  // write_skill / write_tool, install_pack et al, MCP tools, external tools,
  // skill-bundled tools, pack-bundled tools) live in shared.sharedToolRegistry
  // and are registered once at boot — see bootstrap.ts.
  toolRegistry.registerAll([
    // Room management — bound to per-instance house
    createListRoomsTool(house),
    createCreateRoomTool(house, systemAddAgentToRoom),
    createDeleteRoomTool(systemRemoveRoom, house),
    createSetRoomPromptTool(house),
    createPauseRoomTool(house),
    createSetDeliveryModeTool(house),
    createAddToRoomTool(team, house, systemAddAgentToRoom),
    createRemoveFromRoomTool(team, house, systemRemoveAgentFromRoom),
    // Agent tools — bound to per-instance team / house
    createListAgentsTool(team),
    createMuteAgentTool(team, house),
    createGetMyContextTool(team, house),
    // Artifact tools
    createListArtifactTypesTool(house),
    createListArtifactsTool(house),
    createAddArtifactTool(house),
    createUpdateArtifactTool(house),
    createRemoveArtifactTool(house),
    createCastVoteTool(house),
    // Utility tools — bound to per-instance house
    createGetRoomHistoryTool(house),
    createPostToRoomTool(house),
  ])
  // Document tool — collaborative structured writing into per-room artifacts.
  toolRegistry.register(createWriteDocumentSectionTool(house.artifacts))

  // Skill system — file-based behavioral templates with bundled tools.
  // skillStore is process-shared (populated by bootstrap). scriptStore is
  // still per-instance (file-backed under SAMSINN_HOME/scripts; will move
  // to shared in a follow-up — same migration as we just did for skills).
  const skillsDir = sharedPaths.skills()
  const scriptsDir = sharedPaths.scripts()
  const packsDir = sharedPaths.packs()
  const skillStore = shared.sharedSkillStore
  const scriptStore = createScriptStore(scriptsDir)
  // Fire-and-forget initial load — store is empty until this completes,
  // matching the skills loader pattern (which runs from bootstrap.ts).
  void scriptStore.reload().catch(err => console.error('[scripts] reload failed:', err))

  const getSkillsForRoom = (roomName: string): string => {
    const skills = skillStore.forScope(roomName)
    if (skills.length === 0) return ''
    return skills.map(s => `[${s.name}] ${s.description}\n${s.body}`).join('\n\n---\n\n')
  }

  // Per-room allowed-tools whitelist. Resolves from skillStore at every
  // tool call (executor invokes it with the room ID) — agents that span
  // multiple rooms see different whitelists per room.
  //
  // Semantics: union of `allowed-tools` across skills in scope. If NO skill
  // in scope declares a non-empty `allowed-tools`, returns null (no
  // restriction — today's behavior preserved). The room ID parameter
  // matches roomId; we resolve to room name for skillStore.forScope.
  const getAllowedToolsForRoom = (roomId: string): ReadonlySet<string> | null => {
    const room = house.getRoom(roomId)
    if (!room) return null
    const skills = skillStore.forScope(room.profile.name)
    const declaring = skills.filter(s => s.allowedToolNames.length > 0)
    if (declaring.length === 0) return null
    return new Set(declaring.flatMap(s => [...s.allowedToolNames]))
  }

  const refreshAllAgentTools = async (): Promise<void> => {
    for (const agent of team.listByKind('ai')) {
      const ai = agent as AIAgent
      if (!ai.refreshTools) continue
      const toolNames = ai.getTools() ?? toolRegistry.list().map(t => t.name)
      const support = await buildToolSupport(
        toolNames, toolRegistry,
        { id: ai.id, name: ai.name, currentModel: () => ai.getModel() },
        llm,
      )
      ai.refreshTools(support)
    }
  }

  // write_script — pure data (writes JSON files under SAMSINN_HOME/scripts).
  // Stays per-instance because scriptStore is per-instance for now (file-
  // backed; same migration as skillStore is a future PR).
  toolRegistry.register(createWriteScriptTool(scriptStore, () => { /* onChange already broadcasts */ }))

  // Forward-ref so the runner can call System.* without a build-order cycle.
  const systemRef: { current: System | undefined } = { current: undefined }
  const scriptRunner = createScriptRunner({
    getSystem: () => systemRef.current as System,
    emit: (roomId, event, detail) => scriptEvent.proxy(roomId, event, detail),
  })
  scriptHook.set((roomId, message) => scriptRunner.onRoomMessage(roomId, message))

  const buildWikisCatalogForAgent = (roomId: string, agentId: string): string => {
    const room = house.getRoom(roomId)
    if (!room) return ''
    const agent = team.getAgent(agentId)
    const ai = agent ? asAIAgent(agent) : undefined
    const agentBindings = ai?.getWikiBindings() ?? []
    const ids = [...new Set([...room.getWikiBindings(), ...agentBindings])]
    if (ids.length === 0) return ''
    // Local import avoids a cycle: catalog imports registry, which we already have.
    return buildWikisCatalog(shared.wikiRegistry, ids).text
  }

  // --- Effective-model cache (Phase 4: derive-on-read) ---
  // Cache of currently-available models from llm.models(), refreshed in the
  // background. Used by every agent's per-call effective-model resolver so the
  // hot path stays sync. Misses (cache empty / preferred unavailable) fall
  // through to the first available model in router order — Phase 1 surfaces
  // the failure as a typed error if even that is unreachable.
  let availableModelsCache: ReadonlyArray<string> = []
  const refreshAvailableModels = async (): Promise<void> => {
    try {
      const fromRouter = await llm.models()
      const fromOllama = ollama?.getHealth().availableModels ?? []
      // Router returns prefixed (`name:model`); Ollama health returns unprefixed.
      // Keep both so an agent's `model: 'qwen2.5-coder'` (legacy unprefixed)
      // resolves alongside `groq:llama-3.3-70b-versatile`.
      availableModelsCache = [...fromRouter, ...fromOllama]
    } catch { /* keep prior cache on transient failure */ }
  }
  // Match preferred against the cache and return the canonical form to send
  // to the router. The router's resolveCandidates filters providers by
  // exact-match against each gateway's `availableModels`, which for some
  // providers (Anthropic) contains dated full IDs (`claude-haiku-4-5-20251001`)
  // not friendly aliases (`claude-haiku-4-5`). A bare alias passed to the
  // router would find zero eligible providers and fail with "All providers
  // failed" even though the provider is healthy.
  //
  // Three resolutions in priority order:
  //   1. Direct hit — preferred is verbatim in the cache; use as-is.
  //   2. Suffix match — bare `claude-haiku-4-5` ↔ `anthropic:claude-haiku-4-5`
  //      (provider reports the alias verbatim).
  //   3. Versioned variant — bare `claude-haiku-4-5` ↔
  //      `anthropic:claude-haiku-4-5-20251001` (provider reports dated ID).
  //      Return the cached prefixed form; router pins to the provider and
  //      sends the dated ID, which the gateway recognises in availableModels.
  const findInCache = (preferred: string): string | undefined => {
    if (availableModelsCache.includes(preferred)) return preferred
    if (preferred.includes(':')) return undefined
    const suffixHit = availableModelsCache.find(c => c.endsWith(`:${preferred}`))
    if (suffixHit) return suffixHit
    return availableModelsCache.find(c => c.includes(`:${preferred}-`))
  }
  const resolveEffectiveModel: SpawnOptions['resolveEffectiveModel'] = (preferred) => {
    const match = findInCache(preferred)
    if (match) {
      return {
        model: match,
        fallback: match !== preferred,  // versioned-variant counts as fallback for telemetry
        reason: 'preferred_available',
      }
    }
    const fallback = availableModelsCache[0] ?? ''
    return resolveEffectiveModelFn(preferred, () => false, fallback)
  }

  const boundSpawnAIAgent = (config: AIAgentConfig, options?: SpawnOptions) =>
    spawnAIAgent(config, llm, house, team, routeMessage, toolRegistry, {
      ...options,
      getSkills: getSkillsForRoom,
      getWikisCatalog: buildWikisCatalogForAgent,
      getScriptContext: (roomId, agentName) => scriptRunner.getScriptContextForAgent(roomId, agentName),
      getAllowedToolsForRoom,
      onEvalEvent: evalEvent.proxy,
      resolveEffectiveModel,
    })

  // Provider-routing-event listener lives on the shared router (see
  // createSharedRuntime). The dispatcher is normally set by SystemRegistry
  // (multi-instance) — but when this System is built standalone (tests
  // and the headless legacy path), we set the dispatcher to forward
  // events to *this* System's late-bound subscribers. Multi-instance
  // boot overrides this when registry sets its own dispatcher.

  const boundSpawnHumanAgent = async (
    config: HumanAgentConfig,
    send: TransportSend,
    options?: { overrideId?: string },
  ): Promise<HumanAgent> => {
    const agent = createHumanAgent(config, send, options?.overrideId)
    await spawnHumanAgent(agent, house, team, routeMessage)
    return agent
  }

  // === Event observer wiring ===
  // `addEventObserver` subscribes a single callback to every late-bound slot
  // the logging system cares about. Each native-callback signature is
  // translated into a unified LogEvent envelope via src/logging/event-mapping.
  // Returns an aggregate unsubscribe.
  const addEventObserver = (
    observer: (event: LogEvent) => void,
    sessionIdRef: { readonly current: string },
  ): (() => void) => {
    const sid = () => sessionIdRef.current
    const safe = (makeEvent: () => LogEvent) => {
      try { observer(makeEvent()) } catch { /* observer errors already caught in proxy */ }
    }
    const unsubs: Array<() => void> = [
      messagePosted.add((roomId, message) => safe(() => mkMessagePosted(sid(), roomId, message))),
      deliveryModeChanged.add((roomId, mode) => safe(() => mkDeliveryModeChanged(sid(), roomId, mode))),
      modeAutoSwitched.add((roomId, toMode, reason) => safe(() => mkModeAutoSwitched(sid(), roomId, toMode, reason))),
      artifactChanged.add((action, artifact) => safe(() => mkArtifactChanged(sid(), action, artifact))),
      roomCreated.add((profile) => safe(() => mkRoomCreated(sid(), profile))),
      roomDeleted.add((roomId, roomName) => safe(() => mkRoomDeleted(sid(), roomId, roomName))),
      membershipChanged.add((roomId, roomName, agentId, agentName, action) =>
        safe(() => mkMembershipChanged(sid(), roomId, roomName, agentId, agentName, action))),
      evalEvent.add((agentName, event) => safe(() => mkEvalEvent(sid(), agentName, event))),
      providerBound.add((agentId, model, oldProvider, newProvider) =>
        safe(() => mkProviderBound(sid(), agentId, model, oldProvider, newProvider))),
      providerAllFailed.add((agentId, model, attempts, summary) =>
        safe(() => mkProviderAllFailed(sid(), agentId, model, attempts, summary))),
      providerStreamFailed.add((agentId, model, provider, reason) =>
        safe(() => mkProviderStreamFailed(sid(), agentId, model, provider, reason))),
      summaryConfigChanged.add((roomId, config) => safe(() => mkSummaryConfigChanged(sid(), roomId, config))),
      summaryUpdated.add((roomId, target) => safe(() => mkSummaryUpdated(sid(), roomId, target))),
      summaryRunStarted.add((roomId, target) => safe(() => mkSummaryRunStarted(sid(), roomId, target))),
      summaryRunCompleted.add((roomId, target, text) => safe(() => mkSummaryRunCompleted(sid(), roomId, target, text))),
      summaryRunFailed.add((roomId, target, reason) => safe(() => mkSummaryRunFailed(sid(), roomId, target, reason))),
    ]
    return () => { for (const u of unsubs) u() }
  }

  // === Logging handle — runtime on/off + relocate + resession ===
  // One active sink + one active kind filter at any time. `configure` is
  // the single mutator; it drains the old sink, reopens as needed, and
  // refreshes the filter atomically. Env-var boot seeds initial state.
  const loggingState: { config: LogConfig; sink: LogSink | null; unsub: (() => void) | null; sessionRef: { current: string } } = {
    config: { enabled: false, dir: defaultLogDir(), sessionId: defaultSessionId(), kinds: ['*'] },
    sink: null,
    unsub: null,
    sessionRef: { current: '' },
  }

  const logging: LoggingHandle = {
    get: (): LogConfigState => ({
      ...loggingState.config,
      currentFile: loggingState.sink?.stats().currentFile ?? null,
      stats: loggingState.sink?.stats() ?? { eventCount: 0, droppedCount: 0, queuedCount: 0, currentFile: null, currentFileBytes: 0 },
    }),
    configure: async (partial: Partial<LogConfig>): Promise<void> => {
      validateLogConfig(partial)
      const next: LogConfig = {
        enabled: partial.enabled ?? loggingState.config.enabled,
        dir: partial.dir ?? loggingState.config.dir,
        sessionId: partial.sessionId ?? loggingState.config.sessionId,
        kinds: partial.kinds ?? loggingState.config.kinds,
      }

      // Tear down current sink (if any). session.end bracket before flush.
      if (loggingState.sink) {
        try { loggingState.sink.write(mkSessionEnd(loggingState.config.sessionId, 'reconfigure')) } catch { /* best-effort */ }
        try { await loggingState.sink.close() } catch { /* sink already errored */ }
        loggingState.sink = null
      }
      if (loggingState.unsub) {
        loggingState.unsub()
        loggingState.unsub = null
      }

      loggingState.config = next
      loggingState.sessionRef.current = next.sessionId

      if (!next.enabled) return

      // Open new sink. Failure bubbles up; caller (REST/MCP) returns 400.
      const sink = createJsonlFileSink({ dir: next.dir, sessionId: next.sessionId })
      const filtered = (event: LogEvent) => {
        if (matchesKindFilter(event.kind, next.kinds)) sink.write(event)
      }
      loggingState.unsub = addEventObserver(filtered, loggingState.sessionRef)
      sink.write(mkSessionStart(next.sessionId, { dir: next.dir, kinds: next.kinds }))
      loggingState.sink = sink
    },
  }

  // Standalone path (test + legacy): forward provider routing events to
  // *this* System. Multi-instance boot replaces this dispatcher via
  // SystemRegistry → shared.setProviderEventDispatcher.
  if (!sharedWasGiven) {
    shared.setProviderEventDispatcher((event) => {
      if (event.type === 'provider_bound') {
        providerBound.proxy(event.agentId, event.model, event.oldProvider, event.newProvider)
      } else if (event.type === 'provider_all_failed') {
        providerAllFailed.proxy(event.agentId, event.model, event.attempts, { primaryCode: event.primaryCode, primaryReason: event.primaryReason, remediation: event.remediation })
      } else {
        providerStreamFailed.proxy(event.agentId, event.model, event.provider, event.reason)
      }
    })
  }

  const system: System = {
    house, team, routeMessage,
    llm, ollama, providerConfig, providerKeys, gateways, monitors,
    refreshAvailableModels,
    toolRegistry, refreshAllAgentTools, skillStore, skillsDir,
    scriptStore, scriptsDir,
    scriptRunner,
    setOnScriptEvent: scriptEvent.set,
    packsDir,
    knowledgeDir: sharedPaths.knowledge(),
    providersStorePath: sharedPaths.providers(),
    wikisStorePath: sharedPaths.wikis(),
    wikiRegistry: shared.wikiRegistry,
    triggerScheduler,
    ollamaUrls,
    removeAgent,
    removeRoom: systemRemoveRoom,
    resetState,
    addAgentToRoom: systemAddAgentToRoom,
    removeAgentFromRoom: systemRemoveAgentFromRoom,
    spawnAIAgent: boundSpawnAIAgent,
    spawnHumanAgent: boundSpawnHumanAgent,
    activateAgentInRoom,
    setOnMessagePosted: messagePosted.set,
    setOnTurnChanged: turnChanged.set,
    setOnDeliveryModeChanged: deliveryModeChanged.set,
    setOnModeAutoSwitched: modeAutoSwitched.set,
    setOnArtifactChanged: artifactChanged.set,
    setOnRoomCreated: roomCreated.set,
    setOnRoomDeleted: roomDeleted.set,
    setOnMembershipChanged: membershipChanged.set,
    setOnBookmarksChanged: bookmarksChanged.set,
    setOnEvalEvent: evalEvent.set,
    setOnProviderBound: providerBound.set,
    setOnProviderAllFailed: providerAllFailed.set,
    setOnProviderStreamFailed: providerStreamFailed.set,
    dispatchProviderEvent: (event) => {
      if (event.type === 'provider_bound') {
        providerBound.proxy(event.agentId, event.model, event.oldProvider, event.newProvider)
      } else if (event.type === 'provider_all_failed') {
        providerAllFailed.proxy(event.agentId, event.model, event.attempts, { primaryCode: event.primaryCode, primaryReason: event.primaryReason, remediation: event.remediation })
      } else {
        providerStreamFailed.proxy(event.agentId, event.model, event.provider, event.reason)
      }
    },
    summaryScheduler,
    setOnSummaryRunStarted: summaryRunStarted.set,
    setOnSummaryRunDelta: summaryRunDelta.set,
    setOnSummaryRunCompleted: summaryRunCompleted.set,
    setOnSummaryRunFailed: summaryRunFailed.set,
    setOnSummaryConfigChanged: summaryConfigChanged.set,
    addEventObserver: (observer) => addEventObserver(observer, loggingState.sessionRef),
    logging,
    limitMetrics: shared.limitMetrics,
  }
  systemRef.current = system
  // Kick off the cache refresh. Race with the very first eval is benign —
  // an empty cache returns `{ model: preferred, ... }` and the router can
  // route bare cloud names by trying each provider in order. The cache
  // accelerates subsequent calls and enables proper fallback when a
  // provider goes down mid-session.
  void refreshAvailableModels()
  return system
}

// --- Startup (only when run directly) ---

if (import.meta.main) {
  const { bootstrap } = await import('./bootstrap.ts')
  await bootstrap()
}
