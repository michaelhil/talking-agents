// ============================================================================
// Script runner — reactive listener (no engine loop).
//
// One handler per room hooked into onMessagePosted. When a cast member
// posts:  classify whisper → update readiness → if all ready, advance step;
//         otherwise activate the other cast member.
// When a non-cast user posts:  reset readiness, activate the cast member who
//         didn't speak last (or the starts-true agent if first turn).
//
// State per room is a ScriptRun in an internal Map. Per-room serialization
// queue (Promise<void> chain) prevents whisper races and out-of-order
// state mutations.
// ============================================================================

import type { System } from '../main.ts'
import type { Script, ScriptRun, Whisper, ContextOverrides } from './types/script.ts'
import type { Message, DeliveryMode } from './types/messaging.ts'
import type { AIAgentConfig, IncludePrompts, IncludeContext } from './types/agent.ts'
import { classifyWhisper } from './script-whisper.ts'
import { SYSTEM_SENDER_ID } from './types/constants.ts'

// === Public surface ===

export interface ScriptRunner {
  readonly start: (roomId: string, scriptName: string) => Promise<{ ok: boolean; reason?: string }>
  readonly stop: (roomId: string) => Promise<{ ok: boolean; reason?: string }>
  readonly forceAdvance: (roomId: string) => Promise<{ ok: boolean; reason?: string }>
  readonly getRun: (roomId: string) => ScriptRun | undefined
  readonly listRuns: () => ReadonlyArray<ScriptRun>
  readonly onRoomMessage: (roomId: string, message: Message) => void
  readonly getScriptContextForAgent: (roomId: string, agentName: string) => string | undefined
}

export type ScriptEventName =
  | 'script_started'
  | 'script_step_advanced'
  | 'script_readiness_changed'
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

  const buildAgentConfig = (
    member: Script['cast'][number],
    overrides: ContextOverrides | undefined,
  ): AIAgentConfig => {
    const config: { -readonly [K in keyof AIAgentConfig]: AIAgentConfig[K] } = {
      name: member.name,
      model: member.model,
      persona: member.persona,
    }
    if (member.tools) (config as { tools?: ReadonlyArray<string> }).tools = member.tools
    if (overrides?.includePrompts) {
      (config as { includePrompts?: IncludePrompts }).includePrompts = overrides.includePrompts as IncludePrompts
    }
    if (overrides?.includeContext) {
      (config as { includeContext?: IncludeContext }).includeContext = overrides.includeContext as IncludeContext
    }
    if (overrides?.includeTools !== undefined) {
      (config as { includeTools?: boolean }).includeTools = overrides.includeTools
    }
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

  // --- Lifecycle ---

  const start = async (roomId: string, scriptName: string): Promise<{ ok: boolean; reason?: string }> => {
    if (runs.has(roomId)) return { ok: false, reason: 'a script is already running in this room' }
    const system = getSystem()
    const room = system.house.getRoom(roomId)
    if (!room) return { ok: false, reason: 'room not found' }
    const script = system.scriptStore.get(scriptName)
    if (!script) return { ok: false, reason: `script "${scriptName}" not found` }

    // Cast name collision check
    for (const member of script.cast) {
      if (system.team.getAgent(member.name)) {
        return { ok: false, reason: `agent name "${member.name}" already taken; pick a unique cast` }
      }
    }

    // Sequence: pause → spawn → add → restore-pause → switch-to-manual → Stage card → activate.
    room.setPaused(true)
    const spawned: string[] = []
    try {
      for (const member of script.cast) {
        const agent = await system.spawnAIAgent(buildAgentConfig(member, script.contextOverrides))
        spawned.push(agent.id)
        await system.addAgentToRoom(agent.id, roomId, 'script-runner')
      }
    } catch (err) {
      // Roll back any partial spawn
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
      roleOverrides: {},
      lastWhisper: {},
      whisperFailures: 0,
      priorMode,
      ended: false,
    }
    runs.set(roomId, run)
    lastSpeaker.delete(roomId)

    const step = script.steps[0]!
    postStageCard(roomId, `[Script "${script.title}"] Starting. Step 1/${script.steps.length}: ${step.title}`)

    emit?.(roomId, 'script_started', {
      scriptId: script.id,
      scriptName: script.name,
      title: script.title,
    })

    // Activate the starts:true cast member.
    const firstName = startsCastName(script)
    const firstAgent = system.team.getAgent(firstName)
    if (firstAgent) system.activateAgentInRoom(firstAgent.id, roomId)

    return { ok: true }
  }

  const stop = async (roomId: string): Promise<{ ok: boolean; reason?: string }> => {
    const run = runs.get(roomId)
    if (!run) return { ok: false, reason: 'no active script in this room' }

    // Drain the queue — wait for any in-flight whisper / advance to finish.
    const pending = queues.get(roomId)
    if (pending) await pending

    const system = getSystem()
    const room = system.house.getRoom(roomId)

    // Wait for cast to be idle, then despawn.
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
    if (message.senderId === SYSTEM_SENDER_ID) return   // ignore Stage cards / system posts

    enqueue(roomId, async () => {
      const liveRun = runs.get(roomId)
      if (!liveRun || liveRun.ended) return

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
      scriptContext: buildScriptContextString(run, castName),
      presentCast: run.script.cast.map(c => c.name),
    })

    applyWhisper(run, castName, result.whisper)
    if (result.usedFallback) run.whisperFailures += 1
    else run.whisperFailures = 0

    emit?.(run.roomId, 'script_readiness_changed', {
      scriptId: run.script.id,
      readiness: { ...run.readiness },
      whisperFailures: run.whisperFailures,
    })

    const allReady = run.script.cast.every(c => run.readiness[c.name] === true)
    if (allReady) {
      await advance(run, false)
      return
    }

    // Activate the OTHER cast member.
    const next = otherCast(run, castName)
    if (next) {
      const agent = system.team.getAgent(next)
      if (agent) system.activateAgentInRoom(agent.id, run.roomId)
    }
  }

  const onUserPost = async (run: ScriptRun, _message: Message): Promise<void> => {
    // Reset readiness — user introduced new info.
    for (const c of run.script.cast) run.readiness[c.name] = false
    emit?.(run.roomId, 'script_readiness_changed', {
      scriptId: run.script.id,
      readiness: { ...run.readiness },
      whisperFailures: run.whisperFailures,
    })

    // Activate the cast member who didn't speak last (or the starts agent).
    const last = lastSpeaker.get(run.roomId)
    const nextName = last ? otherCast(run, last) : startsCastName(run.script)
    if (nextName) {
      const system = getSystem()
      const agent = system.team.getAgent(nextName)
      if (agent) system.activateAgentInRoom(agent.id, run.roomId)
    }
  }

  const applyWhisper = (run: ScriptRun, castName: string, whisper: Whisper): void => {
    run.readiness[castName] = whisper.ready_to_advance
    if (whisper.role_update) run.roleOverrides[castName] = whisper.role_update
    run.lastWhisper[castName] = whisper
  }

  const advance = async (run: ScriptRun, forced: boolean): Promise<void> => {
    run.currentStep += 1
    run.turn = 0
    for (const c of run.script.cast) run.readiness[c.name] = false
    run.roleOverrides = {}

    if (run.currentStep >= run.script.steps.length) {
      // End of script.
      run.ended = true
      postStageCard(run.roomId, `[Script "${run.script.title}"] Complete.`)
      emit?.(run.roomId, 'script_step_advanced', {
        scriptId: run.script.id,
        stepIndex: run.script.steps.length,
        totalSteps: run.script.steps.length,
        title: '(complete)',
        forced,
      })
      // Defer despawn to a follow-up tick so the Stage card lands first.
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

    // Activate whoever didn't speak last in the previous step.
    const last = lastSpeaker.get(run.roomId)
    const nextName = last ? otherCast(run, last) : startsCastName(run.script)
    if (nextName) {
      const system = getSystem()
      const agent = system.team.getAgent(nextName)
      if (agent) system.activateAgentInRoom(agent.id, run.roomId)
    }
  }

  // --- Context injection (consumed by context-builder.ts via getScript) ---

  const getScriptContextForAgent = (roomId: string, agentName: string): string | undefined => {
    const run = runs.get(roomId)
    if (!run || run.ended) return undefined
    if (!run.script.cast.some(c => c.name === agentName)) return undefined
    return buildScriptContextString(run, agentName)
  }

  return {
    start,
    stop,
    forceAdvance,
    getRun: (roomId) => runs.get(roomId),
    listRuns: () => [...runs.values()],
    onRoomMessage,
    getScriptContextForAgent,
  }
}

// === Pure: script context block string ===

const buildScriptContextString = (run: ScriptRun, castName: string): string => {
  const step = run.script.steps[run.currentStep]!
  const role = run.roleOverrides[castName] ?? step.roles[castName]
  const peers = run.script.cast
    .filter(c => c.name !== castName)
    .map(c => {
      const ready = run.readiness[c.name] === true
      return `${c.name} — ${ready ? 'ready' : 'not ready'}`
    })
    .join(', ')

  const own = run.lastWhisper[castName]
  const lastNotes = own?.notes ? `Your last whisper notes: ${own.notes}` : ''

  const lines = [
    `Script: "${run.script.title}"`,
    `Step ${run.currentStep + 1} of ${run.script.steps.length}: "${step.title}"`,
    step.description ? `Goal: ${step.description}` : '',
    `Your role: ${role}`,
    `Peer readiness: ${peers}`,
    lastNotes,
    `Turn ${run.turn} in this step.`,
  ]
  return lines.filter(s => s.length > 0).join('\n')
}

export const __test = { buildScriptContextString }
