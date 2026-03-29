// ============================================================================
// Tool Format — Text-protocol formatting utilities.
//
// formatToolDescriptions: builds the human-readable tool list injected into
//   system prompts for models that don't support native tool calling.
// TOOL_RESPONSE_FORMAT_SUFFIX: appended to the response format instructions
//   when text-protocol tools are active, teaching the LLM the ::TOOL:: syntax.
// ============================================================================

import type { Tool } from '../core/types.ts'

// Extract parameter signature from a JSON Schema object for display.
const formatParams = (parameters: Record<string, unknown>): string => {
  const schema = parameters as {
    properties?: Record<string, { type?: string }>
    required?: string[]
  }
  const props = schema.properties
  if (!props || Object.keys(props).length === 0) return ''
  const required: string[] = schema.required ?? []
  const parts = Object.entries(props).map(([key, val]) => {
    const type = val.type ?? 'any'
    const optional = required.includes(key) ? '' : '?'
    return `${key}${optional}: ${type}`
  })
  return ` ${parts.join(', ')}`
}

// Builds the tool list injected into the system prompt for text-protocol models.
// Each tool is formatted as a labeled block with optional usage and returns guidance.
export const formatToolDescriptions = (tools: ReadonlyArray<Tool>): string => {
  if (tools.length === 0) return ''
  const blocks = tools.map(t => {
    const params = formatParams(t.parameters)
    let block = `[${t.name}${params}]\n  ${t.description}`
    if (t.usage) block += `\n  Usage: ${t.usage}`
    if (t.returns) block += `\n  Returns: ${t.returns}`
    return block
  })
  return `Available tools:\n\n${blocks.join('\n\n')}`
}

// Appended to response format instructions when text-protocol tools are active.
export const TOOL_RESPONSE_FORMAT_SUFFIX = `\n- To use a tool, write ONLY ::TOOL:: followed by the tool name on its own line. Do not write anything else — just the tool call. Add JSON arguments after the name if needed.
  Example: ::TOOL:: get_time
  Example: ::TOOL:: query_agent {"agent": "Alice", "question": "status?"}
  You may call multiple tools, one ::TOOL:: per line. After tools run you will receive results and should then write a normal response.
- IMPORTANT: You do NOT have access to real-time information like the current time or date. When asked about these, you MUST use the appropriate tool. Never guess or make up values for information a tool can provide.`
