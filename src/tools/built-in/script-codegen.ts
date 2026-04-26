// ============================================================================
// write_script — Lets agents (or any caller) author a script as JSON.
//
// Always on (not gated by SAMSINN_ENABLE_CODEGEN). Scripts are pure data,
// not executable code — different threat model from write_skill / write_tool.
// Validation happens server-side in scriptStore.upsert.
// ============================================================================

import type { Tool } from '../../core/types/tool.ts'
import type { ScriptStore } from '../../core/script-store.ts'

export interface CatalogChangedEmitter {
  (): void
}

export const createWriteScriptTool = (
  store: ScriptStore,
  emitCatalogChanged: CatalogChangedEmitter,
): Tool => ({
  name: 'write_script',
  description: 'Creates or overwrites a script — a passive document that orchestrates a multi-agent collaborative conversation. Scripts spawn cast members as agents and walk them through ordered steps with per-step roles. See docs/scripts.md for the schema.',
  usage: 'Use to author or update a script. Scripts are pure data; no code is executed. Validation rejects malformed input. Cast must have exactly 2 members in v1, exactly one with starts: true. Each step must declare a role for every cast member.',
  returns: 'The parsed Script object.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Filesystem-safe script name (lowercase alphanumerics, dashes, underscores).',
      },
      title: { type: 'string', description: 'Human-readable title.' },
      prompt: { type: 'string', description: 'Optional starter hint shown next to the start button.' },
      cast: {
        type: 'array',
        description: 'Exactly 2 cast members in v1. Exactly one must have starts: true.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Display name; used as the spawned agent name.' },
            persona: { type: 'string', description: 'Persona text for the agent.' },
            model: { type: 'string', description: 'Model id (provider-prefixed for cloud, e.g. "gemini:gemini-2.5-flash").' },
            starts: { type: 'boolean', description: 'true for exactly one cast member.' },
            tools: { type: 'array', items: { type: 'string' }, description: 'Optional tool name list.' },
          },
          required: ['name', 'persona', 'model'],
        },
      },
      steps: {
        type: 'array',
        description: 'Ordered list of steps. Each step has a title and per-cast roles.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string', description: 'Optional one-line goal for the step.' },
            roles: {
              type: 'object',
              description: 'Map of cast name → free-text role for this step.',
              additionalProperties: { type: 'string' },
            },
          },
          required: ['title', 'roles'],
        },
      },
      contextOverrides: {
        type: 'object',
        description: 'Optional per-script context-injection overrides applied at cast spawn.',
        properties: {
          includePrompts: {
            type: 'object',
            properties: {
              persona: { type: 'boolean' },
              room: { type: 'boolean' },
              house: { type: 'boolean' },
              responseFormat: { type: 'boolean' },
              skills: { type: 'boolean' },
              script: { type: 'boolean' },
            },
          },
          includeContext: {
            type: 'object',
            properties: {
              participants: { type: 'boolean' },
              artifacts: { type: 'boolean' },
              activity: { type: 'boolean' },
              knownAgents: { type: 'boolean' },
            },
          },
          includeTools: { type: 'boolean' },
        },
      },
    },
    required: ['name', 'title', 'cast', 'steps'],
  },
  execute: async (params) => {
    try {
      const script = await store.upsert(params)
      emitCatalogChanged()
      return { success: true, data: { name: script.name, id: script.id, steps: script.steps.length } }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
})
