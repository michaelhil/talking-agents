// ============================================================================
// Script engine — driver loop, lifecycle, and room integration.
//
// Responsibilities:
//   - startScript:  spawn AI cast (per-room scoped), register run, distribute
//                   scene-1 setup, set room to manual, kick off first tick.
//   - tick:         two-phase turn loop. Phase-1 fans out forced update_beat
//                   calls in parallel; selection picks one speaker; phase-2
//                   activates the speaker (full eval, dialogue posts to room,
//                   speech_acts come back via update_beat). After phase-2 we
//                   re-evaluate signals, advance/fizzle the scene, and either
//                   schedule the next tick or end the script.
//   - stopScript:   despawn AI cast, clear registry, restore room mode.
//   - onMessagePosted hook: any new message in a script room (including a
//                   user interjection) re-triggers a tick.
//
// The engine is process-local. ScriptRun lifetime == room script lifetime.
// Re-entry is guarded by a per-room in-flight flag.
// ============================================================================

import type { System } from '../main.ts'
import type {
  ScriptRun,
  ScriptEventName,
  ScriptEventDetail,
  Scene,
  BeatRecord,
} from './types/script.ts'
import type { Message } from './types/messaging.ts'
import type { ChatRequest } from './types/llm.ts'
import type { Tool, ToolDefinition } from './types/tool.ts'
import type { ScriptRegistry } from './script-registry.ts'
import type { CastIdToNameMap } from '../tools/built-in/script-tools.ts'
import {
  createScriptRun,
  selectSpeaker,
  detectStall,
  isSceneResolved,
  evaluateSignals,
  applySelfStatus,
  advanceScene,
} from './script-runs.ts'
import { SYSTEM_SENDER_ID } from './types/constants.ts'
import { asAIAgent } from '../agents/shared.ts'
import { toolsToDefinitions } from '../llm/tool-capability.ts'

// === Tunables ===

const STALL_THRESHOLD = 4   // turns with no movement → fizzle
const PHASE1_TIMEOUT_MS = 30_000
const PHASE2_IDLE_TIMEOUT_MS = 60_000

// === Public types ===

export type ScriptEventEmitter = <E extends ScriptEventName>(
  roomId: string, event: E, detail: ScriptEventDetail<E>,
) => void

export interface ScriptEngine {
  readonly start: (roomId: string, scriptName: string) => Promise<{ ok: boolean; reason?: string }>
  readonly stop: (roomId: string) => Promise<{ ok: boolean; reason?: string }>
  readonly getRun: (roomId: string) => ScriptRun | undefined
  // Hook for room.onMessagePosted — kicks the engine when new traffic arrives.
  readonly onRoomMessage: (roomId: string, message: Message) => void
}

export interface ScriptEngineDeps {
  readonly system: System
  readonly registry: ScriptRegistry
  readonly castMap: MutableCastMap
  readonly updateBeatTool: Tool
  readonly emit?: ScriptEventEmitter
}

// === Cast id ↔ name map (mutable for engine; read-only for the tool) ===

export interface MutableCastMap extends CastIdToNameMap {
  readonly set: (roomId: string, agentId: string, castName: string) => void
  readonly clearRoom: (roomId: string) => void
}

export const createCastMap = (): MutableCastMap => {
  const m = new Map<string, Map<string, string>>()
  return {
    get: (roomId, agentId) => m.get(roomId)?.get(agentId),
    set: (roomId, agentId, castName) => {
      let inner = m.get(roomId)
      if (!inner) { inner = new Map(); m.set(roomId, inner) }
      inner.set(agentId, castName)
    },
    clearRoom: (roomId) => { m.delete(roomId) },
  }
}

// === Engine ===

export const createScriptEngine = (deps: ScriptEngineDeps): ScriptEngine => {
  const { system, registry, castMap, updateBeatTool, emit } = deps

  // Per-room cast id list and original delivery mode (restored on stop).
  const spawnedCast = new Map<string, string[]>()         // roomId → agent ids spawned by us
  const priorMode = new Map<string, 'broadcast' | 'manual'>()
  // Re-entry guard so tick doesn't fan out concurrently with itself per room.
  const inFlight = new Set<string>()
  // Tracks the previous turn's elected speaker for next-turn addressee logic.
  const lastSpeaker = new Map<string, string>()
  // Last turn each cast member spoke in the current scene; used by selectSpeaker.
  const lastSpokeTurn = new Map<string, Map<string, number>>()

  // --- Lifecycle ---

  const start = async (roomId: string, scriptName: string): Promise<{ ok: boolean; reason?: string }> => {
    if (registry.get(roomId)) return { ok: false, reason: 'a script is already running in this room' }

    const room = system.house.getRoom(roomId)
    if (!room) return { ok: false, reason: 'room not found' }

    const script = system.scriptStore.get(scriptName)
    if (!script) return { ok: false, reason: `script "${scriptName}" not found` }

    // Spawn AI cast under scoped names.
    const spawned: string[] = []
    for (const member of script.cast) {
      if (member.kind !== 'ai') continue
      if (!member.agentConfig) continue
      const scopedName = scopedAgentName(roomId, member.name)
      try {
        const agent = await system.spawnAIAgent({
          ...member.agentConfig,
          name: scopedName,
          tools: ensureUpdateBeatInTools(member.agentConfig.tools, updateBeatTool.name),
        })
        spawned.push(agent.id)
        castMap.set(roomId, agent.id, member.name)
        await system.addAgentToRoom(agent.id, roomId, 'script-engine')
      } catch (err) {
        // Roll back any spawned cast members from this attempt.
        for (const id of spawned) {
          try { system.removeAgent(id) } catch { /* best-effort */ }
        }
        castMap.clearRoom(roomId)
        return { ok: false, reason: `cast spawn failed: ${err instanceof Error ? err.message : String(err)}` }
      }
    }
    spawnedCast.set(roomId, spawned)

    // Resolve human cast: each must already be a member of the room. Map them.
    for (const member of script.cast) {
      if (member.kind !== 'human') continue
      const wantedName = member.humanAgentName
      const candidates = wantedName
        ? [system.team.getAgent(wantedName)].filter((a): a is NonNullable<typeof a> => !!a && a.kind === 'human' && room.hasMember(a.id))
        : system.team.listByKind('human').filter(a => room.hasMember(a.id))
      const human = candidates[0]
      if (!human) {
        await teardown(roomId, spawned)
        return { ok: false, reason: `human cast "${member.name}" not present in room (need a human member${wantedName ? ` named "${wantedName}"` : ''})` }
      }
      castMap.set(roomId, human.id, member.name)
    }

    // Switch room to manual so AI peers don't auto-fire on the setup post.
    priorMode.set(roomId, room.deliveryMode)
    if (room.deliveryMode !== 'manual') room.setDeliveryMode('manual')

    const run = createScriptRun(script, roomId)
    registry.set(roomId, run)
    lastSpokeTurn.set(roomId, new Map())
    lastSpeaker.delete(roomId)

    // Distribute scene-1 setup as a system message in the room (and let agents
    // pick it up via their normal context).
    deliverSceneSetup(roomId, run, run.script.scenes[0]!)

    emit?.(roomId, 'script_started', { scriptId: script.id, scriptName: script.name })

    // Kick off the first tick.
    void tick(roomId)

    return { ok: true }
  }

  const stop = async (roomId: string): Promise<{ ok: boolean; reason?: string }> => {
    const run = registry.get(roomId)
    if (!run) return { ok: false, reason: 'no active script in this room' }
    const spawned = spawnedCast.get(roomId) ?? []
    await teardown(roomId, spawned)
    emit?.(roomId, 'script_completed', {
      scriptId: run.script.id,
      outcomes: run.lastOutcome ? [run.lastOutcome] : [],
    })
    return { ok: true }
  }

  const teardown = async (roomId: string, spawned: ReadonlyArray<string>): Promise<void> => {
    registry.clear(roomId)
    castMap.clearRoom(roomId)
    spawnedCast.delete(roomId)
    lastSpeaker.delete(roomId)
    lastSpokeTurn.delete(roomId)
    inFlight.delete(roomId)
    for (const id of spawned) {
      try { system.removeAgent(id) } catch { /* best-effort */ }
    }
    const room = system.house.getRoom(roomId)
    const prior = priorMode.get(roomId)
    if (room && prior && room.deliveryMode !== prior) room.setDeliveryMode(prior)
    priorMode.delete(roomId)
  }

  // --- Turn driver ---

  const tick = async (roomId: string): Promise<void> => {
    if (inFlight.has(roomId)) return
    const run = registry.get(roomId)
    if (!run || run.ended) return
    inFlight.add(roomId)
    try {
      await runOneTurn(roomId, run)
    } finally {
      inFlight.delete(roomId)
    }
    // If the script ended during this turn, emit + teardown.
    if (run.ended) {
      const spawned = spawnedCast.get(roomId) ?? []
      await teardown(roomId, spawned)
      emit?.(roomId, 'script_completed', { scriptId: run.script.id, outcomes: collectOutcomes(run) })
    }
  }

  const runOneTurn = async (roomId: string, run: ScriptRun): Promise<void> => {
    const scene = run.script.scenes[run.sceneIndex]!
    run.turn += 1

    // === Phase 1: fan-out forced update_beat across present AI characters ===
    const aiPresent = presentAICast(run, scene)
    const phase1Results = await Promise.all(
      aiPresent.map(({ castName, agentId }) => runPhase1(roomId, run, scene, castName, agentId)),
    )

    // Apply phase-1 beats (status self-marks happen here; speech_acts only in phase-2).
    const intentions: Record<string, 'speak' | 'hold'> = {}
    let lastAddressee: string | undefined
    for (const r of phase1Results) {
      if (!r) continue
      applySelfStatus(run, r.beat)
      intentions[r.beat.character] = r.beat.intent
      if (r.beat.addressedTo) lastAddressee = r.beat.addressedTo
      emit?.(roomId, 'script_beat', { scriptId: run.script.id, beat: r.beat })
    }
    // Humans don't run phase-1; default-hold them.
    for (const name of scene.present) {
      if (intentions[name] === undefined) intentions[name] = 'hold'
    }
    // The previous turn's speaker may have addressed someone — that wins.
    const addressed = lastSpeaker.get(roomId) ? takeLastAddressee(run, lastSpeaker.get(roomId)!) : lastAddressee

    // === Selection ===
    const lastTurnMap = Object.fromEntries(lastSpokeTurn.get(roomId)?.entries() ?? [])
    const speaker = selectSpeaker({
      present: scene.present,
      intentions,
      ...(addressed ? { addressedFromLastTurn: addressed } : {}),
      lastSpokeTurn: lastTurnMap,
    })

    if (!speaker) {
      // Silence beat — record nothing structural; just check stall.
      const fizzled = checkStallAndAdvance(roomId, run)
      if (!fizzled && !run.ended) scheduleTick(roomId)
      return
    }

    // === Phase 2: forced one-turn evaluation of the speaker ===
    await runPhase2(roomId, run, speaker)
    lastSpeaker.set(roomId, speaker)
    lastSpokeTurn.get(roomId)?.set(speaker, run.turn)

    // Evaluate signals → promote pursuing → met for any matched objectives.
    const promoted = evaluateSignals(run)
    for (const name of promoted) {
      const beat: BeatRecord = { turn: run.turn, character: name, status: 'met', intent: 'hold' }
      emit?.(roomId, 'script_beat', { scriptId: run.script.id, beat })
    }

    // Resolution / stall check.
    if (isSceneResolved(scene.present, run.statuses)) {
      const next = advanceScene(run, 'resolved')
      if (next === undefined) return   // script ended
      const nextScene = run.script.scenes[next]!
      lastSpokeTurn.set(roomId, new Map())
      lastSpeaker.delete(roomId)
      deliverSceneSetup(roomId, run, nextScene)
      emit?.(roomId, 'script_scene_advanced', { scriptId: run.script.id, sceneIndex: next, setup: nextScene.setup })
      scheduleTick(roomId)
      return
    }

    const fizzled = checkStallAndAdvance(roomId, run)
    if (!fizzled && !run.ended) scheduleTick(roomId)
  }

  const checkStallAndAdvance = (roomId: string, run: ScriptRun): boolean => {
    const stall = detectStall({
      statusTransitionTurns: run.beats.filter(b => b.status !== 'pursuing').map(b => b.turn),
      speechActTurns: run.beats.filter(b => b.speechActs && b.speechActs.length > 0).map(b => b.turn),
      currentTurn: run.turn,
    }, STALL_THRESHOLD)
    if (!stall) {
      run.stallStreak = 0
      return false
    }
    run.stallStreak += 1
    if (run.stallStreak < 2) return false
    // Two consecutive stall measurements → fizzle.
    const next = advanceScene(run, 'fizzled')
    if (next === undefined) return true
    const scene = run.script.scenes[next]!
    lastSpokeTurn.set(roomId, new Map())
    lastSpeaker.delete(roomId)
    deliverSceneSetup(roomId, run, scene)
    emit?.(roomId, 'script_scene_advanced', { scriptId: run.script.id, sceneIndex: next, setup: scene.setup })
    scheduleTick(roomId)
    return true
  }

  // --- Phase 1: forced tool-only LLM call ---

  const runPhase1 = async (
    roomId: string,
    run: ScriptRun,
    scene: Scene,
    castName: string,
    agentId: string,
  ): Promise<{ beat: BeatRecord } | undefined> => {
    // Skip if this character is already met/abandoned — they're reactive only.
    if (run.statuses[castName] !== 'pursuing') return undefined
    const agent = system.team.getAgent(agentId)
    const ai = agent ? asAIAgent(agent) : undefined
    if (!ai) return undefined

    const room = system.house.getRoom(roomId)
    if (!room) return undefined

    const objective = scene.objectives[castName]!
    const recent = room.getRecent(8)
    const peerMoods = collectPeerMoods(run, castName)
    const transcript = recent
      .filter(m => m.type === 'chat' || m.type === 'system')
      .map(m => `[${m.senderName ?? m.senderId}]: ${m.content}`)
      .join('\n')

    const systemPrompt =
      `You are ${castName} in scene ${run.sceneIndex + 1} of "${run.script.name}".\n` +
      `Setting: ${scene.setup}\n` +
      `Your objective: ${objective.want}\n` +
      `Peer moods: ${peerMoods || '(none yet)'}\n\n` +
      `This is phase-1 (react). Decide whether you want to speak next turn. ` +
      `Call the update_beat tool exactly once with status (pursuing | met | abandoned), ` +
      `intent (speak | hold), optional addressed_to (a present cast name), and optional ` +
      `mood (one word). Do NOT include speech_acts and do NOT produce any dialogue — ` +
      `phase-1 is tool-only.`

    const tools: ReadonlyArray<ToolDefinition> = toolsToDefinitions([updateBeatTool])
    const request: ChatRequest = {
      model: ai.getModel(),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: transcript || '(scene just opened)' },
      ],
      tools,
      toolChoice: { name: updateBeatTool.name },
      ...(ai.getTemperature() !== undefined ? { temperature: ai.getTemperature()! } : {}),
    }

    let response
    try {
      response = await withTimeout(system.llm.chat(request), PHASE1_TIMEOUT_MS, `phase-1 ${castName}`)
    } catch (err) {
      console.warn(`[script:${roomId}] phase-1 ${castName} failed: ${err instanceof Error ? err.message : err}`)
      return undefined
    }

    const call = response.toolCalls?.find(tc => tc.function.name === updateBeatTool.name)
    if (!call) return undefined
    const args = parseToolArgs(call.function.arguments)
    if (!args) return undefined

    // Strip any speech_acts that may have leaked in from phase-1.
    const { speech_acts: _ignore, ...rest } = args as Record<string, unknown>
    void _ignore
    const exec = await updateBeatTool.execute(rest, { callerId: agentId, callerName: castName, roomId })
    if (!exec.success) return undefined
    const beat = (exec.data as { recorded: BeatRecord }).recorded
    return { beat }
  }

  // --- Phase 2: full agent eval driving dialogue + update_beat ---

  const runPhase2 = async (roomId: string, run: ScriptRun, speaker: string): Promise<void> => {
    // Find the speaker's agent id.
    const agentId = findAgentIdForCast(roomId, speaker)
    if (!agentId) return
    const agent = system.team.getAgent(agentId)
    const ai = agent ? asAIAgent(agent) : undefined
    if (!ai) return

    // Activate the agent for one turn. They'll catch up on history, run a
    // full eval, post their dialogue to the room, and call update_beat.
    const result = system.activateAgentInRoom(agentId, roomId)
    if (!result.ok) {
      console.warn(`[script:${roomId}] phase-2 activate ${speaker} failed: ${result.reason}`)
      return
    }
    try {
      await ai.whenIdle(PHASE2_IDLE_TIMEOUT_MS)
    } catch {
      // Timed out — proceed with whatever beats were recorded.
      console.warn(`[script:${roomId}] phase-2 ${speaker} timed out`)
    }
    void run   // eslint
  }

  // --- Helpers ---

  const presentAICast = (
    run: ScriptRun,
    scene: Scene,
  ): ReadonlyArray<{ castName: string; agentId: string }> => {
    const out: { castName: string; agentId: string }[] = []
    for (const name of scene.present) {
      const member = run.script.cast.find(c => c.name === name)
      if (!member || member.kind !== 'ai') continue
      const agentId = findAgentIdForCast(run.roomId, name)
      if (agentId) out.push({ castName: name, agentId })
    }
    return out
  }

  const findAgentIdForCast = (roomId: string, castName: string): string | undefined => {
    // Reverse lookup via castMap.
    const member = registry.get(roomId)?.script.cast.find(c => c.name === castName)
    if (!member) return undefined
    if (member.kind === 'ai') {
      const scopedName = scopedAgentName(roomId, castName)
      return system.team.getAgent(scopedName)?.id
    }
    if (member.kind === 'human') {
      // Find the human cast's agent id by walking the castMap.
      // Cheap: linear scan via team.listByKind('human') and asking castMap.get.
      for (const human of system.team.listByKind('human')) {
        if (castMap.get(roomId, human.id) === castName) return human.id
      }
    }
    return undefined
  }

  const collectPeerMoods = (run: ScriptRun, self: string): string => {
    const scene = run.script.scenes[run.sceneIndex]!
    const latest = new Map<string, string>()
    for (const b of run.beats) {
      if (b.character === self || !b.mood) continue
      if (scene.present.includes(b.character)) latest.set(b.character, b.mood)
    }
    return [...latest.entries()].map(([n, m]) => `${n}: ${m}`).join(', ')
  }

  // The selectSpeaker addressee comes from the speaker who just finished
  // their phase-2 (i.e. the previous turn's speaker). Look up their last beat
  // for an addressedTo. Only used at the start of the next tick.
  const takeLastAddressee = (run: ScriptRun, prevSpeakerCastName: string): string | undefined => {
    for (let i = run.beats.length - 1; i >= 0; i--) {
      const b = run.beats[i]!
      if (b.character === prevSpeakerCastName && b.addressedTo) return b.addressedTo
    }
    return undefined
  }

  const deliverSceneSetup = (roomId: string, run: ScriptRun, scene: Scene): void => {
    const room = system.house.getRoom(roomId)
    if (!room) return
    const cast = scene.present.join(', ')
    room.post({
      senderId: SYSTEM_SENDER_ID,
      content: `Scene ${run.sceneIndex + 1} — ${scene.setup}\nPresent: ${cast}`,
      type: 'system',
    })
  }

  const scheduleTick = (roomId: string): void => {
    // Defer to the next microtask so we don't blow the stack.
    queueMicrotask(() => { void tick(roomId) })
  }

  // --- Public hook for room.onMessagePosted ---

  const onRoomMessage = (roomId: string, message: Message): void => {
    if (!registry.get(roomId)) return
    if (message.type !== 'chat') return
    if (inFlight.has(roomId)) return
    // Schedule a tick — a user (or human cast) just posted, drive the next turn.
    scheduleTick(roomId)
  }

  return { start, stop, getRun: registry.get, onRoomMessage }
}

// === Helpers ===

const scopedAgentName = (roomId: string, castName: string): string =>
  `script-${roomId.slice(0, 8)}-${castName}`

const ensureUpdateBeatInTools = (
  tools: ReadonlyArray<string> | undefined,
  updateBeatName: string,
): ReadonlyArray<string> => {
  if (!tools) return [updateBeatName]
  return tools.includes(updateBeatName) ? tools : [...tools, updateBeatName]
}

const parseToolArgs = (raw: string | Record<string, unknown>): Record<string, unknown> | undefined => {
  if (typeof raw === 'object' && raw !== null) return raw
  if (typeof raw !== 'string') return undefined
  try { return JSON.parse(raw) as Record<string, unknown> } catch { return undefined }
}

const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ])

const collectOutcomes = (run: ScriptRun): ReadonlyArray<'resolved' | 'fizzled'> =>
  run.lastOutcome ? [run.lastOutcome] : []
