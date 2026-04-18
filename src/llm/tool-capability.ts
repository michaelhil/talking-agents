// ============================================================================
// Tool Capability — Converts Tool[] to native ToolDefinition[] format.
//
// Provider-neutral. Ollama and all supported OpenAI-compatible providers
// accept the same { type: 'function', function: { name, description,
// parameters } } shape for tool definitions. Tools are always sent as
// structured definitions in the ChatRequest.tools field; per-model
// capability probing is not performed.
// ============================================================================

import type { Tool, ToolDefinition } from '../core/types/tool.ts'

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
