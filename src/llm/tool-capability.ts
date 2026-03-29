// ============================================================================
// Tool Capability — Per-model detection of native tool-calling support.
//
// Ollama models that have been fine-tuned for function calling report this
// via /api/show. When native tools are available, agents send the tool list
// directly in the ChatRequest rather than injecting text descriptions into
// the system prompt.
//
// Detection strategy:
//   1. Ollama ≥0.3.x: check capabilities[] array for "tools"
//   2. Fallback: scan the model template for known tool-call markers
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

// === Capability detection ===

const SHOW_TIMEOUT_MS = 10_000

// Template markers that indicate a model supports native function calling
const TOOL_TEMPLATE_MARKERS = [
  '<tool_call>',
  '<|python_tag|>',
  '[TOOL_CALLS]',
  '<|start_header_id|>tool',
]

interface OllamaShowResponse {
  readonly capabilities?: ReadonlyArray<string>
  readonly template?: string
}

const probeNativeToolSupport = async (model: string, baseUrl: string): Promise<boolean> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SHOW_TIMEOUT_MS)
  try {
    const response = await fetch(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: controller.signal,
    })
    if (!response.ok) return false

    const data = await response.json() as OllamaShowResponse

    // Ollama ≥0.3.x exposes a capabilities array
    if (Array.isArray(data.capabilities)) {
      return data.capabilities.includes('tools')
    }

    // Fallback: scan the model template for known tool-call markers
    const template = data.template ?? ''
    return TOOL_TEMPLATE_MARKERS.some(marker => template.includes(marker))
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

// === Cache ===

export interface ToolCapabilityCache {
  readonly probe: (model: string) => Promise<boolean>
}

export const createToolCapabilityCache = (baseUrl: string): ToolCapabilityCache => {
  const cache = new Map<string, boolean>()

  return {
    probe: async (model: string): Promise<boolean> => {
      const cached = cache.get(model)
      if (cached !== undefined) return cached
      const result = await probeNativeToolSupport(model, baseUrl)
      cache.set(model, result)
      return result
    },
  }
}
