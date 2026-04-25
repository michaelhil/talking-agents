// ============================================================================
// Script registry — in-process map of roomId → ScriptRun.
//
// One entry per room with an active script. The script-engine populates and
// clears this; the update_beat tool reads from it to look up which run a
// caller's beat applies to. Process-local; not persisted.
// ============================================================================

import type { ScriptRun } from './types/script.ts'

export interface ScriptRegistry {
  readonly get: (roomId: string) => ScriptRun | undefined
  readonly set: (roomId: string, run: ScriptRun) => void
  readonly clear: (roomId: string) => boolean
  readonly list: () => ReadonlyArray<ScriptRun>
}

export const createScriptRegistry = (): ScriptRegistry => {
  const runs = new Map<string, ScriptRun>()
  return {
    get: (roomId) => runs.get(roomId),
    set: (roomId, run) => { runs.set(roomId, run) },
    clear: (roomId) => runs.delete(roomId),
    list: () => [...runs.values()],
  }
}
