// ============================================================================
// Tool Capability — Converts Tool[] to native ToolDefinition[] format.
//
// Provider-neutral. Ollama and all supported OpenAI-compatible providers
// accept the same { type: 'function', function: { name, description,
// parameters } } shape for tool definitions. Tools are always sent as
// structured definitions in the ChatRequest.tools field; per-model
// capability probing is not performed.
//
// `parameters` is normalised to a valid JSON Schema (type: object) before
// emission. OpenAI rejects with HTTP 400 invalid_function_parameters when a
// tool's parameters omit `type` or set it to something other than 'object';
// Gemini and Anthropic don't currently enforce this but probably will.
// Sanitising here keeps tool authors free to write loose shapes without
// every adapter independently catching the discrepancy.
//
// === LLM-facing contract (post-2026-05 cost audit) ===
//
//   tool.description  → goes to the LLM. Single imperative clause; ≤ 200
//                       chars typical. Second sentence ONLY for a non-
//                       obvious constraint, side-effect, or cross-tool
//                       dependency that the LLM can't infer from the
//                       first call's actual result. No "Use to…",
//                       "This tool…" openers. If the return shape carries
//                       a contract the LLM must act on (e.g. paste a
//                       fence string verbatim), fold that sentence into
//                       description proper — `returns` is UI-only.
//
//   tool.usage        → UI hint, surfaced in the tool-detail modal for
//   tool.returns        humans inspecting a tool. NOT appended to the
//                       LLM-facing description.
//
//   tool.parameters   → JSON Schema. Use `default`, `enum`, `minimum`,
//                       `maximum`, `minLength`, `maxLength`, `pattern`
//                       fields instead of prose. All major providers
//                       honour them. Per-property `description` only when
//                       the property name doesn't self-document (e.g.
//                       format hints like "ISO-3166-1 alpha-2"; not
//                       "Name of the room").
//
//   Cross-tool conventions (e.g. `\`\`\`map` rendering, `[[AgentName]]`
//   addressing, geo cascade order) live in the relevant skill markdown,
//   NOT duplicated across every related tool's description.
//
//   Drift in the surface size is monitored by eyeballing — a single
//   maintainer can spot bloat in review. A previous attempt at a runtime
//   token cap (deleted in de6c0d1) and the alternative of a CI budget
//   test were both rejected: the cap silently dropped pack tools when
//   registration order changed, and the CI test creates friction against
//   every legitimate new tool without solving the real problem
//   (LLM-correctness regression, which a token count cannot detect).
//   LLM behaviour is verified by comparing /api/diagnostics/evals/recent
//   outcome-rates before/after a change.
// ============================================================================

import type { Tool, ToolDefinition } from '../core/types/tool.ts'

const EMPTY_OBJECT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {},
})

// Returns parameters as a valid JSON Schema. Three cases:
//   - already shaped as { type: 'object', ... }: pass through unchanged
//   - missing/null/non-object: emit empty object schema
//   - object with non-'object' type or missing type: wrap into a shell so
//     downstream validators accept the request. We do NOT try to coerce the
//     flat-shape (e.g. `{ path: 'string', head: '...' }`) into proper
//     sub-property schemas — too lossy. The tool gets a well-formed shell
//     and the LLM is told what fields to provide via the description.
const normaliseParameters = (
  toolName: string,
  raw: Tool['parameters'],
): Record<string, unknown> => {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_OBJECT_SCHEMA }
  const r = raw as Record<string, unknown>
  if (r['type'] === 'object') return r
  if (r['type'] !== undefined) {
    // type is set but isn't 'object' — invalid for a function-parameters
    // root schema. Replace with a shell. Warn so the tool can be fixed at
    // source.
    console.warn(`[tool-capability] tool "${toolName}" parameters root type=${JSON.stringify(r['type'])} (must be 'object') — replaced with empty shell`)
    return { ...EMPTY_OBJECT_SCHEMA }
  }
  // type missing entirely — common when authors write a flat shape. Wrap
  // it as `properties` only when each value looks like a sub-schema; else
  // emit empty shell. Heuristic: a sub-schema is an object with at least
  // a 'type' key.
  const looksLikeProperties = Object.values(r).every(
    (v) => v !== null && typeof v === 'object' && (v as Record<string, unknown>)['type'] !== undefined,
  )
  if (looksLikeProperties && Object.keys(r).length > 0) {
    return { type: 'object', properties: r }
  }
  // Flat description-style shape (`{ head: 'If provided...', path: 'string' }`)
  // — neither a proper schema nor proper sub-schemas. Emit empty shell so
  // the tool stays callable and the LLM relies on the description.
  return { ...EMPTY_OBJECT_SCHEMA }
}

// === Tool format conversion ===

export const toolsToDefinitions = (tools: ReadonlyArray<Tool>): ReadonlyArray<ToolDefinition> =>
  tools.map(t => ({
    type: 'function' as const,
    // description is the LLM-facing prose. tool.usage and tool.returns are
    // UI hints rendered in the tool-detail modal — they're NOT sent to the
    // LLM. (Pre-2026-05 they were appended; cost audit determined the
    // prose duplicated information the model gets from the first tool
    // result. For tools whose return shape carries a contract the LLM
    // must act on, that sentence goes into `description` proper.)
    function: { name: t.name, description: t.description, parameters: normaliseParameters(t.name, t.parameters) },
  }))
