// ============================================================================
// Tool Capability — Converts Tool[] to native ToolDefinition[] format.
//
// All modern Ollama models support native tool calling. The capability
// probing system was removed — tools are always sent as structured
// definitions in the ChatRequest.tools field.
// ============================================================================

import type { Tool, ToolDefinition } from '../core/types.ts'

// === Tool format conversion ===

export const toolsToDefinitions = (tools: ReadonlyArray<Tool>): ReadonlyArray<ToolDefinition> =>
  tools.map(t => {
    let description = t.description
    if (t.usage) description += `\nUsage: ${t.usage}`
    if (t.returns) description += `\nReturns: ${t.returns}`
    return {
      type: 'function' as const,
      function: { name: t.name, description, parameters: t.parameters },
    }
  })
