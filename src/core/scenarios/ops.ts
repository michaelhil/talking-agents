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
import type { ScenarioOp, ScenarioRun, RunOptions, GuideWait } from './types.ts'
import type { ScenarioEventName } from './runner-types.ts'
import type { ExternalWaitArgs } from './waits.ts'
import { SYSTEM_SENDER_ID } from '../types/constants.ts'
import { parseScriptMd } from '../scripts/script-md-parser.ts'

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
    if (!res.success) throw new Error(`install-pack ${op.source} failed: ${res.error ?? 'unknown'}`)
  },

  'create-room': async (op, { system }) => {
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

  'activate-pack': async (op, { system }) => {
    const room = system.house.getRoom(op.room)
    if (!room) throw new Error(`activate-pack: room "${op.room}" not found`)
    const current = room.getActivePacks()
    if (current.includes(op.pack)) return
    room.setActivePacks([...current, op.pack])
  },

  'spawn-agent': async (op, { system }) => {
    const room = system.house.getRoom(op.room)
    if (!room) throw new Error(`spawn-agent: room "${op.room}" not found`)
    let agent = system.team.getAgent(op.name)
    if (!agent) {
      const config = {
        name: op.name,
        model: op.model,
        persona: op.persona,
        ...(op.tools ? { tools: op.tools } : {}),
      }
      agent = await system.spawnAIAgent(config)
    }
    if (!room.hasMember(agent.id)) {
      await system.addAgentToRoom(agent.id, room.profile.id, 'scenario')
    }
  },

  'spawn-human': async (op, { system }) => {
    const room = system.house.getRoom(op.room)
    if (!room) throw new Error(`spawn-human: room "${op.room}" not found`)
    let agent = system.team.getAgent(op.name)
    if (!agent) {
      agent = await system.spawnHumanAgent({ name: op.name }, () => { /* no-op transport */ })
    }
    if (!room.hasMember(agent.id)) {
      await system.addAgentToRoom(agent.id, room.profile.id, 'scenario')
    }
  },

  'post-message': async (op, { system, state }) => {
    const room = system.house.getRoom(op.room)
    if (!room) throw new Error(`post-message: room "${op.room}" not found`)
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

  'start-script': async (op, { system, arrangeExternal }) => {
    const room = system.house.getRoom(op.room)
    if (!room) throw new Error(`start-script: room "${op.room}" not found`)
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
      room: op.room,
      scriptName: op.scriptName,
    })
  },

  'inline-script': async (op, { system, arrangeExternal, trackCleanup }) => {
    const room = system.house.getRoom(op.room)
    if (!room) throw new Error(`inline-script: room "${op.room}" not found`)
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
      room: op.room,
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

  'wait': async (op, { arrangeExternal }) => {
    await arrangeExternal(op.waitFor)
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
