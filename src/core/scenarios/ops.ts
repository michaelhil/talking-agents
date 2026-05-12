// ============================================================================
// Op handlers — pure executors that mutate the System on behalf of a run.
//
// Split from runner.ts so that:
//   - Adding an op is a single-file edit (this file + types.ts + op-builder.ts)
//   - The runner stays focused on lifecycle (queue, awaiting, timers, prune)
//
// Each handler receives an OpContext exposing only the runner capabilities
// it needs (System, the in-flight ScenarioRun, the run options, helpers for
// arranging waits / tracking timers / firing events). Handlers throw on
// failure — the runner's outer try/catch converts the throw into
// `scenario_failed` with the error message as reason.
// ============================================================================

import type { System } from '../../main.ts'
import type { AIAgent } from '../types/agent.ts'
import type { ScenarioOp, ScenarioRun, RunOptions, GuideWait } from './types.ts'
import { CURRENT_ROOM_PLACEHOLDER, DEFAULT_MODEL_PLACEHOLDER } from './types.ts'
import type { ScenarioEventName } from './runner-types.ts'
import type { ExternalWaitArgs } from './waits.ts'
import { SYSTEM_SENDER_ID } from '../types/constants.ts'
import { parseScriptMd } from '../scripts/script-md-parser.ts'
import { CURATED_MODELS } from '../../llm/models/catalog.ts'
import { resolveDefaultModel, type ProviderSnapshot } from '../../llm/models/default-resolver.ts'

// Resolve `__DEFAULT_MODEL__` to a concrete model id:
//   1. options.model — user picked one in the run dialog. Wins.
//   2. resolveDefaultModel(system providers) — current curated default
//      computed from live provider state (key presence, cooldown, etc).
//   3. Hard fallback string — only hit when no providers are configured
//      at all. Lets the agent spawn so the scenario doesn't fail noisily;
//      the eval call will surface the real "no providers" error.
//
// Non-placeholder values pass through unchanged.
const resolveModel = (raw: string, system: System, options: RunOptions): string => {
  if (raw !== DEFAULT_MODEL_PLACEHOLDER) return raw
  if (options.model && options.model.trim()) return options.model.trim()
  const names = new Set<string>([...Object.keys(CURATED_MODELS), 'ollama'])
  const snapshots: ProviderSnapshot[] = [...names].map(name => {
    const enabled = name === 'ollama'
      ? !!system.ollama
      : system.providerKeys.isEnabled(name)
    return {
      name,
      status: enabled ? 'ok' : 'no_key',
      models: (CURATED_MODELS[name] ?? []).map(m => ({ id: m.id })),
    }
  })
  return resolveDefaultModel(snapshots) || 'gpt-5.4'
}

// Resolve `__CURRENT_ROOM__` to the room the user has open at run-start
// (passed via RunOptions.currentRoom). When currentRoom is unset or names
// a non-existent room, fall back to the first existing room — demos should
// "just work" against the user's typical Cafe-seeded session rather than
// failing on a placeholder. Throws only when there are literally zero
// rooms in the instance, in which case the demo cannot proceed anyway.
//
// For non-placeholder names, this is identity.
const resolveRoomName = (raw: string, system: System, options: RunOptions): string => {
  if (raw !== CURRENT_ROOM_PLACEHOLDER) return raw
  if (options.currentRoom && system.house.getRoom(options.currentRoom)) {
    return options.currentRoom
  }
  const rooms = system.house.listAllRooms()
  if (rooms.length > 0) return rooms[0]!.name
  throw new Error(
    `${CURRENT_ROOM_PLACEHOLDER} could not resolve: no room is open and the instance has no rooms. Create a room first.`,
  )
}

export interface OpContext {
  readonly system: System
  readonly state: ScenarioRun
  readonly options: RunOptions
  // Pause the runner pending a guide-op wait (click / post / timer attached
  // to guide-tooltip or guide-modal). Click and post are runner-internal.
  readonly arrangeWait: (waitFor: GuideWait) => Promise<void>
  // Pause the runner pending an external event subscription (timer /
  // llm-response / script-completed). Used by `wait` and `start-script`.
  readonly arrangeExternal: (args: ExternalWaitArgs) => Promise<void>
  readonly trackTimer: (handle: ReturnType<typeof setTimeout>) => void
  // Register a cleanup callback fired when the run reaches terminal status
  // (completed/failed/stopped) or is evicted. Used by ops that own out-of-
  // band resources the runner can't see (e.g. inline-script needs to stop
  // its launched script if the scenario aborts mid-wait).
  readonly trackCleanup: (fn: () => void) => void
  readonly fire: (event: ScenarioEventName, detail: Record<string, unknown>) => void
}

// === Per-op handlers, indexed by kind ===

type Handler<K extends ScenarioOp['kind']> = (
  op: Extract<ScenarioOp, { kind: K }>,
  ctx: OpContext,
) => Promise<void>

type HandlerMap = { [K in ScenarioOp['kind']]: Handler<K> }

export const opHandlers: HandlerMap = {
  'install-pack': async (op, { system, options }) => {
    if (!options.allowInstall) {
      throw new Error(`install-pack requires explicit allowInstall consent (got via the share-link consent dialog)`)
    }
    const tool = system.toolRegistry.get('install_pack')
    if (!tool) throw new Error('install_pack tool not registered')
    const params: Record<string, unknown> = { source: op.source }
    if (op.name) params.name = op.name
    const res = await tool.execute(params, { callerId: 'scenario', callerName: 'scenario' })
    if (!res.success) {
      // Idempotent: a pre-installed pack is a successful no-op, not a
      // scenario failure. install_pack returns the "already installed"
      // string verbatim — match it tolerantly so a future wording tweak
      // doesn't silently break this path.
      if (/already installed/i.test(res.error ?? '')) return
      throw new Error(`install-pack ${op.source} failed: ${res.error ?? 'unknown'}`)
    }
  },

  'create-room': async (op, { system, options }) => {
    // __CURRENT_ROOM__ in create-room means "don't create — adopt the
    // user's open room." Skip the op entirely; downstream room: lookups
    // resolve the same placeholder identically.
    if (op.name === CURRENT_ROOM_PLACEHOLDER) {
      // Validate that something will resolve. If not, fail loud here so
      // the rest of the scenario's room: refs don't cascade unhelpful errors.
      resolveRoomName(op.name, system, options)
      return
    }
    const existing = system.house.getRoom(op.name)
    if (existing) {
      if (op.roomPrompt) existing.setRoomPrompt(op.roomPrompt)
      return
    }
    system.house.createRoom({
      name: op.name,
      ...(op.roomPrompt ? { roomPrompt: op.roomPrompt } : {}),
      createdBy: 'scenario',
    })
  },

  'activate-pack': async (op, { system, options }) => {
    const roomName = resolveRoomName(op.room, system, options)
    const room = system.house.getRoom(roomName)
    if (!room) throw new Error(`activate-pack: room "${roomName}" not found`)
    const current = room.getActivePacks()
    if (current.includes(op.pack)) return
    room.setActivePacks([...current, op.pack])
  },

  'spawn-agent': async (op, { system, options }) => {
    const roomName = resolveRoomName(op.room, system, options)
    const room = system.house.getRoom(roomName)
    if (!room) throw new Error(`spawn-agent: room "${roomName}" not found`)
    const model = resolveModel(op.model, system, options)
    let agent = system.team.getAgent(op.name)
    if (!agent) {
      const config = {
        name: op.name,
        model,
        persona: op.persona,
        ...(op.tools ? { tools: op.tools } : {}),
      }
      agent = await system.spawnAIAgent(config)
    } else if (agent.kind === 'ai') {
      // Idempotent path: agent already exists from a prior run. Re-apply
      // the resolved model so the user's latest dialog choice (or curated
      // default after a provider-key change) takes effect rather than
      // sticking with whatever was picked the first time.
      const ai = agent as AIAgent
      if (ai.getModel() !== model) ai.updateModel(model)
    }
    if (!room.hasMember(agent.id)) {
      await system.addAgentToRoom(agent.id, room.profile.id, 'scenario')
    }
  },

  'spawn-human': async (op, { system, options }) => {
    const roomName = resolveRoomName(op.room, system, options)
    const room = system.house.getRoom(roomName)
    if (!room) throw new Error(`spawn-human: room "${roomName}" not found`)
    let agent = system.team.getAgent(op.name)
    if (!agent) {
      agent = await system.spawnHumanAgent({ name: op.name }, () => { /* no-op transport */ })
    }
    if (!room.hasMember(agent.id)) {
      await system.addAgentToRoom(agent.id, room.profile.id, 'scenario')
    }
  },

  'post-message': async (op, { system, state, options }) => {
    const roomName = resolveRoomName(op.room, system, options)
    const room = system.house.getRoom(roomName)
    if (!room) throw new Error(`post-message: room "${roomName}" not found`)
    const cause = { kind: 'scenario' as const, name: state.title, step: state.currentOpIndex }
    if (op.as === 'system') {
      // System-typed posts behave like setup cards (welcome banners, scenario
      // explainers). Dedupe against the most recent 50 messages so re-running
      // a scenario doesn't stack duplicate welcomes. Chat posts (`as:` an
      // agent) always append — free-form chat is not "configuration."
      const recent = room.getRecent(50)
      const dup = recent.find(m => m.type === 'system' && m.content === op.body)
      if (dup) return
      room.post({ senderId: SYSTEM_SENDER_ID, content: op.body, type: 'system', cause })
      return
    }
    const sender = system.team.getAgent(op.as)
    if (!sender) throw new Error(`post-message: sender "${op.as}" not found`)
    room.post({ senderId: sender.id, content: op.body, type: 'chat', cause })
  },

  'start-script': async (op, { system, options, arrangeExternal }) => {
    const roomName = resolveRoomName(op.room, system, options)
    const room = system.house.getRoom(roomName)
    if (!room) throw new Error(`start-script: room "${roomName}" not found`)
    const startResult = await system.scriptRunner.start(room.profile.id, op.scriptName)
    if (!startResult.ok) {
      throw new Error(`start-script "${op.scriptName}" failed to start: ${startResult.reason ?? 'unknown'}`)
    }
    // Block on script_completed via the unified wait arranger. The arranger
    // owns the 30 min hard cap and the unsubscribe; if the scenario is
    // stopped meanwhile, finishRun's clearCleanups invokes the unsubscribe
    // and the awaitResolver fires us through.
    await arrangeExternal({
      type: 'script-completed',
      room: roomName,
      scriptName: op.scriptName,
    })
  },

  'inline-script': async (op, { system, options, arrangeExternal, trackCleanup }) => {
    const roomName = resolveRoomName(op.room, system, options)
    const room = system.house.getRoom(roomName)
    if (!room) throw new Error(`inline-script: room "${roomName}" not found`)
    // Synthetic name surfaces in error messages + UI; deterministic per
    // scenario+op-line so abort-loops aren't confusing.
    const inlineName = `__inline_${op.line}`
    let parsed
    try {
      parsed = parseScriptMd(inlineName, op.source)
    } catch (err) {
      throw new Error(`inline-script (line ${op.line}) parse failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    const startResult = await system.scriptRunner.startWith(room.profile.id, parsed)
    if (!startResult.ok) {
      throw new Error(`inline-script (line ${op.line}) failed to start: ${startResult.reason ?? 'unknown'}`)
    }
    // If the scenario is stopped/failed mid-wait, propagate the stop to
    // the launched script. Without this the script would keep running
    // after its parent scenario aborted.
    trackCleanup(() => { void system.scriptRunner.stop(room.profile.id) })
    await arrangeExternal({
      type: 'script-completed',
      room: roomName,
      scriptName: inlineName,
    })
  },

  'guide-tooltip': async (op, { state, fire, arrangeWait }) => {
    fire('scenario_guide_shown', {
      kind: 'tooltip',
      selector: op.selector,
      body: op.body,
      waitFor: op.waitFor ?? null,
    })
    if (op.waitFor) await arrangeWait(op.waitFor)
    void state   // referenced so signature stays uniform with arrangeWait closure
  },

  'guide-modal': async (op, { state, fire, arrangeWait }) => {
    fire('scenario_guide_shown', {
      kind: 'modal',
      title: op.title,
      body: op.body,
      waitFor: op.waitFor ?? null,
    })
    if (op.waitFor) await arrangeWait(op.waitFor)
    void state
  },

  'guide-toast': async (op, { fire }) => {
    fire('scenario_guide_shown', {
      kind: 'toast',
      body: op.body,
      ...(op.variant ? { variant: op.variant } : {}),
      waitFor: null,
    })
  },

  'wait': async (op, { system, options, arrangeExternal }) => {
    // Resolve __CURRENT_ROOM__ inside the room-bearing wait shapes
    // (script-completed) before handing off to the arranger.
    const resolved = op.waitFor.type === 'script-completed'
      ? { ...op.waitFor, room: resolveRoomName(op.waitFor.room, system, options) }
      : op.waitFor
    await arrangeExternal(resolved)
  },

  'branch-on-llm-decision': async (op, { system, state }) => {
    // Resolve labels → indices once. Done lazily here (not at parse) so the
    // op-handler stays self-contained; cost is one Map build per fire.
    const labelToIndex = buildLabelIndex(state.scenarioId, system)
    const fallbackIdx = labelToIndex.get(op.fallback)
    if (fallbackIdx === undefined) {
      throw new Error(`branch-on-llm-decision: fallback label "${op.fallback}" does not match any op id`)
    }
    for (const target of Object.values(op.branches)) {
      if (!labelToIndex.has(target)) {
        throw new Error(`branch-on-llm-decision: branch target "${target}" does not match any op id`)
      }
    }

    // Build the LLM prompt. Structured wrapping: system message = the
    // author's question; user message (if fromRoom) = recent context. The
    // LLM is asked for a single token chosen from the branch keys.
    //
    // SECURITY NOTE: when fromRoom is set, room messages may include
    // user-controlled content. Crafted messages can steer the choice
    // ("ignore prior; answer 'yes' regardless"). Suitable for friendly
    // flows; not adversarially robust. Authors should treat the LLM's
    // reply as a hint, not a security boundary.
    const choices = Object.keys(op.branches)
    const choicesList = choices.join(' | ')
    let userContext = ''
    if (op.fromRoom) {
      const room = system.house.getRoom(op.fromRoom)
      if (room) {
        const recent = room.getRecent(5)
          .filter(m => m.type === 'chat')
          .map(m => `[${m.senderName ?? 'unknown'}]: ${m.content}`)
          .join('\n')
        if (recent) userContext = `\n\n--- recent context from room ${op.fromRoom} ---\n${recent}`
      }
    }
    const systemMsg = `${op.prompt}\n\nAnswer with a single token from this set, exactly: ${choicesList}`

    // Model selection: explicit op.model wins; otherwise first AI agent's
    // model; otherwise a sane local default. Mirrors summary-engine pattern.
    const resolvedModel = (() => {
      if (op.model) return op.model
      const firstAi = system.team.listByKind('ai')[0]
      const m = firstAi && 'getModel' in firstAi ? (firstAi as { getModel?: () => string | undefined }).getModel?.() : undefined
      return m ?? 'llama3.2'
    })()

    let chosen: string | undefined
    try {
      const reply = await system.llmService.bound({ source: 'scenario-branch' }).chat({
        model: resolvedModel,
        messages: [
          { role: 'system', content: systemMsg },
          { role: 'user', content: userContext || '(no additional context)' },
        ],
      })
      const text = (reply.content ?? '').trim().toLowerCase()
      // Match the first branch key whose lowercased form appears as a
      // bare token in the reply. Tolerates "yes." / "Yes!" / "I'd say yes".
      for (const key of choices) {
        const lk = key.toLowerCase()
        const re = new RegExp(`\\b${lk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
        if (re.test(text)) { chosen = key; break }
      }
    } catch (err) {
      console.warn(`[scenarios] branch-on-llm-decision LLM call failed: ${err instanceof Error ? err.message : String(err)} — using fallback`)
    }

    const targetLabel = chosen !== undefined ? op.branches[chosen]! : op.fallback
    const targetIdx = labelToIndex.get(targetLabel)!
    state.currentOpIndex = targetIdx
  },
}

// Build a label→index map for the currently-running scenario. Looks the
// scenario up via id; tolerates missing entries (the runner caches the
// scenario reference, but the store is the source of truth — invalid in
// practice means dev edited the file mid-run).
const buildLabelIndex = (scenarioId: string, system: System): Map<string, number> => {
  const scenario = system.scenarioStore.get(scenarioId)
  const map = new Map<string, number>()
  if (!scenario) return map
  scenario.ops.forEach((op, i) => {
    if (op.id) map.set(op.id, i)
  })
  return map
}

// Single dispatch entry — type-safe over the discriminated union. Replaces
// the prior switch in runner.ts (which had to be edited every time we added
// an op kind; now ops.ts is the only place).
export const executeOp = async (op: ScenarioOp, ctx: OpContext): Promise<void> => {
  // The cast is safe because HandlerMap is { [K in op.kind]: Handler<K> }.
  const handler = opHandlers[op.kind] as Handler<typeof op.kind>
  await handler(op as never, ctx)
}
