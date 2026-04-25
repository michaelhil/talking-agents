// ============================================================================
// Script tools — update_beat
//
// update_beat is the single bus through which every script-cast character
// reports its turn-state and (in phase-2) declares the speech-acts its
// dialogue performed. The tool is bound only to script-cast agents at
// script-start; non-cast agents in the same room never see it.
//
// Validation is at runtime: speech_acts are checked against the active
// script's glossary; unknown acts return a tool error so the model can
// self-correct on retry.
// ============================================================================

import type { ScriptRegistry } from '../../core/script-registry.ts'
import type { Tool, ToolContext, ToolResult } from '../../core/types/tool.ts'
import type { BeatRecord } from '../../core/types/script.ts'
import { recordBeat as recordBeatInRun } from '../../core/script-runs.ts'

// Allowed by mapping the cast member to the calling agent. The engine sets
// this map at script-start so the tool can resolve `callerId` → cast name.
// Process-local; not persisted.
export interface CastIdToNameMap {
  readonly get: (roomId: string, agentId: string) => string | undefined
}

export const createUpdateBeatTool = (
  registry: ScriptRegistry,
  castMap: CastIdToNameMap,
): Tool => ({
  name: 'update_beat',
  description: 'Report your turn-state to the script engine. Call once per turn. ' +
    'In phase-1 (react) declare only status / intent / addressed_to / mood. ' +
    'In phase-2 (your speaking turn) ALSO declare speech_acts naming which ' +
    'glossary acts your dialogue just performed. Unknown speech_acts are ' +
    'rejected — pick from the script\'s acts glossary.',
  usage: 'Mandatory tool for every turn while a script is active. Phase-1: ' +
    'tool-only (no message). Phase-2: declare speech_acts that match what ' +
    'you actually said.',
  returns: '{ ok, recorded } on success; error on validation failure.',
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['pursuing', 'met', 'abandoned'],
        description: 'Your stance toward your scene objective. ' +
          '"met" = you got what you wanted; "abandoned" = you have stopped pursuing.',
      },
      intent: {
        type: 'string',
        enum: ['speak', 'hold'],
        description: 'Whether you want the floor next turn. The engine picks one speaker.',
      },
      addressed_to: {
        type: 'string',
        description: 'Optional. Name of another character you are addressing. ' +
          'They get right-of-first-refusal next turn.',
      },
      mood: {
        type: 'string',
        description: 'Optional. One word. Visible to peers as a mood tag (e.g. "tense", "guarded", "warm").',
      },
      speech_acts: {
        type: 'array',
        items: { type: 'string' },
        description: 'Phase-2 only. Glossary act names declaring what your ' +
          'dialogue just performed. Must match the active script\'s acts.',
      },
    },
    required: ['status', 'intent'],
  },
  execute: async (params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => {
    if (!context.roomId) {
      return { success: false, error: 'update_beat requires a room context' }
    }
    const run = registry.get(context.roomId)
    if (!run) {
      return { success: false, error: 'No active script in this room' }
    }
    const character = castMap.get(context.roomId, context.callerId)
    if (!character) {
      return { success: false, error: 'Caller is not a member of this script\'s cast' }
    }

    const status = params.status as string
    if (status !== 'pursuing' && status !== 'met' && status !== 'abandoned') {
      return { success: false, error: `status must be pursuing|met|abandoned (got "${status}")` }
    }
    const intent = params.intent as string
    if (intent !== 'speak' && intent !== 'hold') {
      return { success: false, error: `intent must be speak|hold (got "${intent}")` }
    }

    const addressed_to = typeof params.addressed_to === 'string' && params.addressed_to.length > 0
      ? params.addressed_to
      : undefined
    if (addressed_to !== undefined) {
      const scene = run.script.scenes[run.sceneIndex]
      if (!scene || !scene.present.includes(addressed_to)) {
        return { success: false, error: `addressed_to "${addressed_to}" is not in the present cast` }
      }
    }

    const mood = typeof params.mood === 'string' && params.mood.length > 0 ? params.mood : undefined

    let speechActs: ReadonlyArray<string> | undefined
    const rawActs = params.speech_acts
    if (Array.isArray(rawActs) && rawActs.length > 0) {
      const validated: string[] = []
      const glossary = run.script.acts
      for (const act of rawActs) {
        if (typeof act !== 'string') {
          return { success: false, error: `speech_acts entries must be strings` }
        }
        if (!glossary[act]) {
          const known = Object.keys(glossary).join(', ')
          return { success: false, error: `Unknown speech-act "${act}". Glossary: ${known}` }
        }
        validated.push(act)
      }
      speechActs = validated
    }

    const beat: BeatRecord = {
      turn: run.turn,
      character,
      status,
      intent,
      ...(addressed_to ? { addressedTo: addressed_to } : {}),
      ...(mood ? { mood } : {}),
      ...(speechActs ? { speechActs } : {}),
    }
    recordBeatInRun(run, beat)

    return { success: true, data: { ok: true, recorded: beat } }
  },
})
