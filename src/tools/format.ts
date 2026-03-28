// ============================================================================
// Tool Format — Text-protocol formatting utilities.
//
// formatToolDescriptions: builds the human-readable tool list injected into
//   system prompts for models that don't support native tool calling.
// TOOL_RESPONSE_FORMAT_SUFFIX: appended to the response format instructions
//   when text-protocol tools are active, teaching the LLM the ::TOOL:: syntax.
// ============================================================================

import type { Tool } from '../core/types.ts'

// Builds the tool list injected into the system prompt for text-protocol models.
export const formatToolDescriptions = (tools: ReadonlyArray<Tool>): string => {
  if (tools.length === 0) return ''
  const lines = tools.map(t => {
    const params = Object.keys(t.parameters).length > 0
      ? ` Parameters: ${JSON.stringify(t.parameters)}`
      : ' No parameters.'
    return `- ${t.name}: ${t.description}${params}`
  })
  return `Available tools:\n${lines.join('\n')}`
}

// Appended to response format instructions when text-protocol tools are active.
export const TOOL_RESPONSE_FORMAT_SUFFIX = `\n- To use a tool, write ONLY ::TOOL:: followed by the tool name on its own line. Do not write anything else — just the tool call. Add JSON arguments after the name if needed.
  Example: ::TOOL:: get_time
  Example: ::TOOL:: query_agent {"target": "Alice", "question": "status?"}
  You may call multiple tools, one ::TOOL:: per line. After tools run you will receive results and should then write a normal response.
- IMPORTANT: You do NOT have access to real-time information like the current time or date. When asked about these, you MUST use the appropriate tool. Never guess or make up values for information a tool can provide.`
