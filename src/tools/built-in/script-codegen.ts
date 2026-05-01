// ============================================================================
// write_script — Lets agents (or any caller) author a script as markdown.
//
// Always on (not gated by SAMSINN_ENABLE_CODEGEN). Scripts are pure data,
// not executable code — different threat model from write_skill / write_tool.
// Validation happens server-side in scriptStore.upsert (markdown parsed
// strictly; bad input rejected with line context).
// ============================================================================

import type { Tool } from '../../core/types/tool.ts'
import { type ScriptStore, MAX_SCRIPT_SOURCE_BYTES } from '../../core/scripts/script-store.ts'

export interface CatalogChangedEmitter {
  (): void
}

export const createWriteScriptTool = (
  store: ScriptStore,
  emitCatalogChanged: CatalogChangedEmitter,
): Tool => ({
  name: 'write_script',
  description: 'Creates or overwrites a script (markdown). Scripts orchestrate multi-agent conversations through ordered steps with per-step roles. See docs/scripts.md.',
  usage: 'Provide `name` (lowercase + dash/underscore) and full markdown `source`. Pure data — no code execution. Malformed input is rejected with a line number.',
  returns: 'On success: { name, title }. On failure: { error }.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Filesystem-safe script name (lowercase alphanumerics, dashes, underscores).',
      },
      source: {
        type: 'string',
        description: 'Full markdown source. Must start with "# SCRIPT: <title>". See docs/scripts.md for the grammar.',
      },
    },
    required: ['name', 'source'],
  },
  execute: async (params) => {
    const name = typeof params.name === 'string' ? params.name : ''
    const source = typeof params.source === 'string' ? params.source : ''
    if (!name || !source) {
      return { success: false, error: 'name and source are required strings' }
    }
    if (source.length > MAX_SCRIPT_SOURCE_BYTES) {
      return { success: false, error: `source too large: ${source.length} bytes (max ${MAX_SCRIPT_SOURCE_BYTES})` }
    }
    try {
      const script = await store.upsert(name, source)
      emitCatalogChanged()
      return { success: true, data: { name: script.name, title: script.title } }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
})
