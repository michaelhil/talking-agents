// ============================================================================
// Script runner — reactive listener (no engine loop).
//
// One handler per room hooked into onMessagePosted. When a cast member posts:
// classify whisper → record dialogue + whisper into the current step's
// stepLog → bump readyStreak → if all ready, advance step; otherwise
// activate the other cast member.
// When a non-cast user posts: append to current step's log, reset readiness
// AND readyStreak (new info means pressure clock restarts), activate the
// cast member who didn't speak last (or the starts-true agent if first turn).
//
// State per room is a ScriptRun in an internal Map. Per-room serialization
// queue (Promise<void> chain) prevents whisper races.
// ============================================================================

import type { System } from '../main.ts'
import type { Script, ScriptRun, WhisperRecord, StepLog, DialogueEntry, CastMember } from './types/script.ts'
import type { Message, DeliveryMode } from './types/messaging.ts'
import type { AIAgentConfig } from './types/agent.ts'
import { classifyWhisper } from './script-whisper.ts'
import { renderLivingScript } from './script-render.ts'
import { SYSTEM_SENDER_ID } from './types/constants.ts'

// === Public surface ===

export interface ScriptRunner {
  readonly start: (roomId: string, scriptName: string) => Promise<{ ok: boolean; reason?: string }>
  readonly stop: (roomId: string) => Promise<{ ok: boolean; reason?: string }>
  readonly forceAdvance: (roomId: string) => Promise<{ ok: boolean; reason?: string }>
  readonly getRun: (roomId: string) => ScriptRun | undefined
  readonly listRuns: () => ReadonlyArray<ScriptRun>
  readonly onRoomMessage: (roomId: string, message: Message) => void
  readonly getScriptDocumentForAgent: (roomId: string, agentName: string) => string | undefined
  readonly getScriptContextForAgent: (roomId: string, agentName: string) =>
    | { systemDoc: string; dialogue: ReadonlyArray<{ speaker: string; content: string }> }
    | undefined
}

export type ScriptEventName =
  | 'script_started'
  | 'script_step_advanced'
  | 'script_readiness_changed'
  | 'script_dialogue_appended'
  | 'script_completed'

export type ScriptEventEmitter = (
  roomId: string,
  event: ScriptEventName,
  detail: Record<string, unknown>,
) => void

export interface ScriptRunnerDeps {
  readonly getSystem: () => System
  readonly emit?: ScriptEventEmitter
}

// === Implementation ===

// After this many consecutive whisper-classification fallbacks the runner
// auto-stops. Prevents an unending stuck-script loop when the LLM is degraded
// (rate-limited, timing out, or the prompt is somehow broken). Hard-coded —
// this is a safety net, not a tuning knob.
const MAX_CONSECUTIVE_WHISPER_FAILURES = 5

export const createScriptRunner = (deps: ScriptRunnerDeps): ScriptRunner => {
  const { getSystem, emit } = deps
  const runs = new Map<string, ScriptRun>()
  const queues = new Map<string, Promise<void>>()
  const lastSpeaker = new Map<string, string>()   // roomId → cast name who spoke last

  // --- Queue: one Promise<void> per room serializes all state mutations ---

  const enqueue = (roomId: string, fn: () => Promise<void>): void => {
    const prev = queues.get(roomId) ?? Promise.resolve()
    const next = prev.then(fn).catch(err => {
      console.error(`[script-runner] task failed for room ${roomId}:`, err)
    })
    queues.set(roomId, next)
  }

  // --- Helpers ---

  const otherCast = (run: ScriptRun, name: string): string | undefined =>
    run.script.cast.find(c => c.name !== name)?.name

  const startsCastName = (script: Script): string =>
    script.cast.find(c => c.starts)?.name ?? script.cast[0]!.name

  const isCastMember = (run: ScriptRun, senderName: string | undefined): boolean =>
    senderName !== undefined && run.script.cast.some(c => c.name === senderName)

  const buildAgentConfig = (member: CastMember): AIAgentConfig => {
    const config: { -readonly [K in keyof AIAgentConfig]: AIAgentConfig[K] } = {
      name: member.name,
      model: member.model,
      persona: member.persona,
    }
    if (member.tools) (config as { tools?: ReadonlyArray<string> }).tools = member.tools
    return config
  }

  const postStageCard = (roomId: string, content: string): void => {
    const room = getSystem().house.getRoom(roomId)
    if (!room) return
    room.post({
      senderId: SYSTEM_SENDER_ID,
      senderName: 'Stage',
      content,
      type: 'chat',
    })
  }

  const initialStepLogs = (script: Script): StepLog[] =>
    script.steps.map(() => ({ entries: [] }))

  const appendDialogue = (run: ScriptRun, entry: DialogueEntry): void => {
    const log = run.stepLogs[run.currentStep]
    if (!log) return
    const next: StepLog = {
      ...log,
      entries: [...log.entries, entry],
    }
    run.stepLogs[run.currentStep] = next
  }

  // Returns the name of any cast member that's no longer in system.team, or
  // undefined if all are present. Cast can be removed mid-run (manual delete,
  // panic shutdown) — silently no-op'ing on missing agents would stall the
  // script forever; aborting with a stage card keeps the room sane.
  const findMissingCast = (run: ScriptRun): string | undefined => {
    const system = getSystem()
    for (const member of run.script.cast) {
      if (!system.team.getAgent(member.name)) return member.name
    }
    return undefined
  }

  // Stop the script with a visible stage card explaining why. Uses the
  // queued stop() so it cleans up properly even if called mid-handler.
  const abortRun = (run: ScriptRun, reason: string): void => {
    if (run.ended) return
    run.ended = true
    postStageCard(run.roomId, `[Script "${run.script.title}"] Aborted: ${reason}`)
    setTimeout(() => { void stop(run.roomId) }, 50)
  }

  // --- Lifecycle ---

  const start = async (roomId: string, scriptName: string): Promise<{ ok: boolean; reason?: string }> => {
    if (runs.has(roomId)) return { ok: false, reason: 'a script is already running in this room' }
    const system = getSystem()
    const room = system.house.getRoom(roomId)
    if (!room) return { ok: false, reason: 'room not found' }
    const script = system.scriptStore.get(scriptName)
    if (!script) return { ok: false, reason: `script "${scriptName}" not found` }

    for (const member of script.cast) {
      if (system.team.getAgent(member.name)) {
        return { ok: false, reason: `agent name "${member.name}" already taken; pick a unique cast` }
      }
    }

    room.setPaused(true)
    const spawned: string[] = []
    const castInfo: Array<{ id: string; name: string; model: string; kind: 'ai' }> = []
    try {
      for (const member of script.cast) {
        const agent = await system.spawnAIAgent(buildAgentConfig(member))
        spawned.push(agent.id)
        castInfo.push({ id: agent.id, name: member.name, model: member.model, kind: 'ai' })
        await system.addAgentToRoom(agent.id, roomId, 'script-runner')
      }
    } catch (err) {
      for (const id of spawned) {
        try { system.removeAgent(id) } catch { /* best-effort */ }
      }
      room.setPaused(false)
      return { ok: false, reason: `cast spawn failed: ${err instanceof Error ? err.message : String(err)}` }
    }

    const priorMode = room.deliveryMode
    if (priorMode !== 'manual') room.setDeliveryMode('manual')
    room.setPaused(false)

    const run: ScriptRun = {
      script,
      roomId,
      currentStep: 0,
      turn: 0,
      readiness: Object.fromEntries(script.cast.map(c => [c.name, false])),
      readyStreak: Object.fromEntries(script.cast.map(c => [c.name, 0])),
      roleOverrides: {},
      stepLogs: initialStepLogs(script),
      whisperFailures: 0,
      priorMode,
      ended: false,
    }
    runs.set(roomId, run)
    lastSpeaker.delete(roomId)

    const step = script.steps[0]!
    postStageCard(roomId, `[Script "${script.title}"] Starting. Step 1/${script.steps.length}: ${step.title}`)

    // Send cast + step structure with the started event so the UI store
    // can render the full living document even after the run ends and
    // the runner discards its state.
    const castFull = castInfo.map(ci => {
      const member = script.cast.find(c => c.name === ci.name)!
      return { ...ci, persona: member.persona, starts: !!member.starts }
    })
    const stepsForUi = script.steps.map(s => ({
      title: s.title,
      ...(s.goal ? { goal: s.goal } : {}),
      roles: s.roles,
    }))

    emit?.(roomId, 'script_started', {
      scriptId: script.id,
      scriptName: script.name,
      title: script.title,
      ...(script.premise ? { premise: script.premise } : {}),
      totalSteps: script.steps.length,
      stepTitle: step.title,
      cast: castFull,
      steps: stepsForUi,
    })

    const firstName = startsCastName(script)
    const firstAgent = system.team.getAgent(firstName)
    if (firstAgent) system.activateAgentInRoom(firstAgent.id, roomId)

    return { ok: true }
  }

  const stop = async (roomId: string): Promise<{ ok: boolean; reason?: string }> => {
    const run = runs.get(roomId)
    if (!run) return { ok: false, reason: 'no active script in this room' }

    const pending = queues.get(roomId)
    if (pending) await pending

    const system = getSystem()
    const room = system.house.getRoom(roomId)

    for (const member of run.script.cast) {
      const agent = system.team.getAgent(member.name)
      if (!agent) continue
      const ai = agent.kind === 'ai' && 'whenIdle' in agent ? agent as unknown as { whenIdle: (ms: number) => Promise<void> } : undefined
      if (ai) {
        try { await ai.whenIdle(5000) } catch { /* timed out — proceed */ }
      }
      try { system.removeAgent(agent.id) } catch { /* best-effort */ }
    }

    if (room && run.priorMode && room.deliveryMode !== run.priorMode) {
      room.setDeliveryMode(run.priorMode as DeliveryMode)
    }

    runs.delete(roomId)
    queues.delete(roomId)
    lastSpeaker.delete(roomId)

    emit?.(roomId, 'script_completed', { scriptId: run.script.id })
    return { ok: true }
  }

  const forceAdvance = async (roomId: string): Promise<{ ok: boolean; reason?: string }> => {
    const run = runs.get(roomId)
    if (!run) return { ok: false, reason: 'no active script in this room' }
    enqueue(roomId, async () => { await advance(run, true) })
    return { ok: true }
  }

  // --- Reactive handler (subscribed to room.onMessagePosted) ---

  const onRoomMessage = (roomId: string, message: Message): void => {
    const run = runs.get(roomId)
    if (!run || run.ended) return
    if (message.type !== 'chat') return
    if (message.senderId === SYSTEM_SENDER_ID) return

    enqueue(roomId, async () => {
      const liveRun = runs.get(roomId)
      if (!liveRun || liveRun.ended) return

      const missing = findMissingCast(liveRun)
      if (missing) {
        abortRun(liveRun, `cast member "${missing}" is no longer in the room`)
        return
      }

      if (isCastMember(liveRun, message.senderName)) {
        await onCastPost(liveRun, message)
      } else {
        await onUserPost(liveRun, message)
      }
    })
  }

  const onCastPost = async (run: ScriptRun, message: Message): Promise<void> => {
    const castName = message.senderName!
    run.turn += 1
    lastSpeaker.set(run.roomId, castName)

    const system = getSystem()
    const result = await classifyWhisper({
      llm: system.llm,
      model: run.script.cast.find(c => c.name === castName)!.model,
      message: message.content,
      scriptContext: renderLivingScript(run, castName),
      presentCast: run.script.cast.map(c => c.name),
    })

    const record: WhisperRecord = {
      turn: run.turn,
      whisper: result.whisper,
      usedFallback: result.usedFallback,
      ...(result.rawResponse !== undefined ? { rawResponse: result.rawResponse } : {}),
      ...(result.errorReason !== undefined ? { errorReason: result.errorReason } : {}),
    }

    // Apply whisper effects: readiness, streak, role override.
    const wasReady = run.readiness[castName] === true
    run.readiness[castName] = record.whisper.ready_to_advance
    if (record.whisper.ready_to_advance) {
      run.readyStreak[castName] = (run.readyStreak[castName] ?? 0) + 1
    } else {
      run.readyStreak[castName] = 0
    }
    if (record.whisper.role_update) run.roleOverrides[castName] = record.whisper.role_update
    if (result.usedFallback) run.whisperFailures += 1
    else run.whisperFailures = 0

    if (run.whisperFailures >= MAX_CONSECUTIVE_WHISPER_FAILURES) {
      abortRun(run, `whisper classification failed ${MAX_CONSECUTIVE_WHISPER_FAILURES} consecutive turns. Check LLM health and restart.`)
      return
    }

    // Record dialogue + whisper into current step log.
    const entry: DialogueEntry = {
      speaker: castName,
      content: message.content,
      messageId: message.id,
      whispersByCast: { [castName]: record },
    }
    appendDialogue(run, entry)

    emit?.(run.roomId, 'script_dialogue_appended', {
      scriptId: run.script.id,
      stepIndex: run.currentStep,
      entry,
    })
    emit?.(run.roomId, 'script_readiness_changed', {
      scriptId: run.script.id,
      readiness: { ...run.readiness },
      readyStreak: { ...run.readyStreak },
      whisperFailures: run.whisperFailures,
      lastWhisper: collectLastWhispers(run),
    })
    void wasReady

    const allReady = run.script.cast.every(c => run.readiness[c.name] === true)
    if (allReady) {
      await advance(run, false)
      return
    }

    const next = otherCast(run, castName)
    if (next) {
      const agent = system.team.getAgent(next)
      if (agent) system.activateAgentInRoom(agent.id, run.roomId)
    }
  }

  const onUserPost = async (run: ScriptRun, message: Message): Promise<void> => {
    // Reset readiness AND readyStreak — user introduced new info, pressure restarts.
    for (const c of run.script.cast) {
      run.readiness[c.name] = false
      run.readyStreak[c.name] = 0
    }
    const entry: DialogueEntry = {
      speaker: message.senderName ?? 'Director',
      content: message.content,
      messageId: message.id,
      whispersByCast: {},
    }
    appendDialogue(run, entry)
    emit?.(run.roomId, 'script_dialogue_appended', {
      scriptId: run.script.id,
      stepIndex: run.currentStep,
      entry,
    })
    emit?.(run.roomId, 'script_readiness_changed', {
      scriptId: run.script.id,
      readiness: { ...run.readiness },
      readyStreak: { ...run.readyStreak },
      whisperFailures: run.whisperFailures,
      lastWhisper: collectLastWhispers(run),
    })

    const last = lastSpeaker.get(run.roomId)
    const nextName = last ? otherCast(run, last) : startsCastName(run.script)
    if (nextName) {
      const system = getSystem()
      const agent = system.team.getAgent(nextName)
      if (agent) system.activateAgentInRoom(agent.id, run.roomId)
    }
  }

  const advance = async (run: ScriptRun, forced: boolean): Promise<void> => {
    // Mark current step as advanced.
    const cur = run.stepLogs[run.currentStep]
    if (cur) {
      run.stepLogs[run.currentStep] = { ...cur, advancedAt: run.turn }
    }
    run.currentStep += 1
    run.turn = 0
    for (const c of run.script.cast) {
      run.readiness[c.name] = false
      run.readyStreak[c.name] = 0
    }
    run.roleOverrides = {}

    if (run.currentStep >= run.script.steps.length) {
      run.ended = true
      postStageCard(run.roomId, `[Script "${run.script.title}"] Complete.`)
      emit?.(run.roomId, 'script_step_advanced', {
        scriptId: run.script.id,
        stepIndex: run.script.steps.length,
        totalSteps: run.script.steps.length,
        title: '(complete)',
        forced,
      })
      setTimeout(() => {
        void stop(run.roomId)
      }, 50)
      return
    }

    const step = run.script.steps[run.currentStep]!
    postStageCard(run.roomId, `[Step ${run.currentStep + 1}/${run.script.steps.length}] ${step.title}`)
    emit?.(run.roomId, 'script_step_advanced', {
      scriptId: run.script.id,
      stepIndex: run.currentStep,
      totalSteps: run.script.steps.length,
      title: step.title,
      forced,
    })

    const last = lastSpeaker.get(run.roomId)
    const nextName = last ? otherCast(run, last) : startsCastName(run.script)
    if (nextName) {
      const system = getSystem()
      const agent = system.team.getAgent(nextName)
      if (agent) system.activateAgentInRoom(agent.id, run.roomId)
    }
  }

  // --- Document accessor consumed by context-builder bypass ---
  //
  // Returns both the structural document (suitable for system prompt — no
  // dialogue inline) AND the current step's dialogue as proper user/
  // assistant messages keyed by speaker. The context-builder bypass uses
  // these together: system = structural, messages = dialogue + final
  // "speak your next line" instruction.
  //
  // Splitting into role-tagged messages stops the model from treating the
  // most-recent dialogue line as a continuation prompt — a real bug we
  // saw where Sam parroted Alex's prior turn verbatim.
  const getScriptContextForAgent = (
    roomId: string,
    agentName: string,
  ): { systemDoc: string; dialogue: ReadonlyArray<{ speaker: string; content: string }> } | undefined => {
    const run = runs.get(roomId)
    if (!run || run.ended) return undefined
    if (!run.script.cast.some(c => c.name === agentName)) return undefined
    const systemDoc = renderLivingScript(run, agentName, { includeDialogue: false })
    const log = run.stepLogs[run.currentStep]
    const dialogue = (log?.entries ?? []).map(e => ({ speaker: e.speaker, content: e.content }))
    return { systemDoc, dialogue }
  }

  // For UI panel + per-agent inspection — the full unified document with
  // dialogue inline.
  const getScriptDocumentForAgent = (roomId: string, agentName: string): string | undefined => {
    const run = runs.get(roomId)
    if (!run || run.ended) return undefined
    if (!run.script.cast.some(c => c.name === agentName)) return undefined
    return renderLivingScript(run, agentName)
  }

  return {
    start,
    stop,
    forceAdvance,
    getRun: (roomId) => runs.get(roomId),
    listRuns: () => [...runs.values()],
    onRoomMessage,
    getScriptDocumentForAgent,
    getScriptContextForAgent,
  }
}

// Collect each cast member's most recent WhisperRecord across the current
// step's entries — surfaced via the WS readiness event so the per-message
// whisper badge can render without keeping its own derivation state.
const collectLastWhispers = (run: ScriptRun): Record<string, WhisperRecord> => {
  const out: Record<string, WhisperRecord> = {}
  const log = run.stepLogs[run.currentStep]
  if (!log) return out
  for (const entry of log.entries) {
    for (const [castName, record] of Object.entries(entry.whispersByCast)) {
      out[castName] = record
    }
  }
  return out
}
