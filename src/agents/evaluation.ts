// ============================================================================
// Evaluation — LLM interaction engine with tool loop (ReAct pattern).
//
// evaluate() builds context, calls the LLM, handles tool calls in a loop,
// and returns a Decision. tryEvaluate() wraps it with per-context concurrency
// control (one active eval per room/peer, pending queue for coalescing).
//
// Protocol: LLM responds in plain text. Special prefixes:
//   ::PASS:: reason     → agent stays silent
//   ::TOOL:: name {args} → tool call (one per line, can have multiple)
//   Everything else      → natural language message
// ============================================================================

import type {
  AgentResponse,
  AIAgentConfig,
  LLMProvider,
  NativeToolCall,
  ToolCall,
  ToolDefinition,
  ToolExecutor,
  ToolResult,
} from '../core/types.ts'
import type { ContextResult, FlushInfo } from './context-builder.ts'

// === Decision — what the agent wants to do after evaluation ===

export interface Decision {
  readonly response: AgentResponse
  readonly generationMs: number
  readonly triggerRoomId?: string
  readonly triggerPeerId?: string
}

export type OnDecision = (decision: Decision) => void

// === Internal response type — includes tool_call (never leaves evaluate) ===

type InternalResponse =
  | AgentResponse
  | { readonly action: 'tool_call'; readonly toolCalls: ReadonlyArray<ToolCall> }

// === Plain text response parsing ===

const PASS_PREFIX = '::PASS::'
const TOOL_LINE_RE = /^::TOOL::\s+(\S+)\s*(.*)/

export const parseResponse = (raw: string): InternalResponse => {
  const trimmed = raw.trim()

  // ::PASS:: — agent declines to respond
  if (trimmed.startsWith(PASS_PREFIX)) {
    const reason = trimmed.slice(PASS_PREFIX.length).trim() || undefined
    return { action: 'pass', reason }
  }

  // Scan for ::TOOL:: lines — collect tool calls, keep remaining text as content
  const lines = trimmed.split('\n')
  const toolCalls: ToolCall[] = []
  const contentLines: string[] = []

  for (const line of lines) {
    const match = TOOL_LINE_RE.exec(line)
    if (match) {
      const toolName = match[1]!
      let args: Record<string, unknown> = {}
      if (match[2]?.trim()) {
        try {
          args = JSON.parse(match[2]) as Record<string, unknown>
        } catch {
          console.warn(`[parseResponse] Malformed JSON args for tool "${toolName}": ${match[2]}`)
        }
      }
      toolCalls.push({ tool: toolName, arguments: args })
    } else {
      contentLines.push(line)
    }
  }

  if (toolCalls.length > 0) {
    const discarded = contentLines.join('\n').trim()
    if (discarded.length > 0) {
      console.debug(`[parseResponse] Discarding mixed content alongside tool call: "${discarded.slice(0, 80)}"`)
    }
    return { action: 'tool_call', toolCalls }
  }

  // Default: everything is a natural language response
  const content = contentLines.join('\n').trim()
  if (content.length === 0) {
    return { action: 'pass', reason: 'Empty response' }
  }

  return { action: 'respond', content }
}

// === Native tool call conversion ===

const nativeCallsToToolCalls = (native: ReadonlyArray<NativeToolCall>): ReadonlyArray<ToolCall> =>
  native.map(tc => ({ tool: tc.function.name, arguments: tc.function.arguments }))

// === Tool result injection ===

const formatToolResults = (
  calls: ReadonlyArray<ToolCall>,
  results: ReadonlyArray<ToolResult>,
): string => {
  const lines = results.map((r, i) =>
    `- ${calls[i]?.tool}: ${r.success ? JSON.stringify(r.data) : `Error: ${r.error}`}`,
  )
  return `Tool results:\n${lines.join('\n')}\n\nNow respond to the conversation using these results. Write your response as natural text.`
}

// === Evaluate — single LLM call with tool loop ===

export interface EvalResult {
  readonly decision: Decision
  readonly flushInfo: FlushInfo
}

export const evaluate = async (
  contextResult: ContextResult,
  config: AIAgentConfig,
  llmProvider: LLMProvider,
  toolExecutor: ToolExecutor | undefined,
  maxToolIterations: number,
  triggerRoomId?: string,
  triggerPeerId?: string,
  toolDefinitions?: ReadonlyArray<ToolDefinition>,
): Promise<EvalResult> => {
  const context = [...contextResult.messages]
  let totalGenerationMs = 0

  const makeResult = (decision: Decision): EvalResult => ({
    decision,
    flushInfo: contextResult.flushInfo,
  })

  try {
    for (let toolRound = 0; toolRound <= maxToolIterations; toolRound++) {
      const chatResponse = await llmProvider.chat({
        model: config.model,
        messages: context,
        temperature: config.temperature,
        tools: toolDefinitions,
      })

      totalGenerationMs += chatResponse.generationMs

      // Native tool call path — model returned structured tool calls directly
      if (chatResponse.toolCalls && chatResponse.toolCalls.length > 0) {
        if (!toolExecutor) {
          return makeResult({
            response: { action: 'pass', reason: 'Tool calls not available' },
            generationMs: totalGenerationMs,
            triggerRoomId,
            triggerPeerId,
          })
        }
        const calls = nativeCallsToToolCalls(chatResponse.toolCalls)
        const results = await toolExecutor(calls, triggerRoomId)
        context.push({ role: 'assistant' as const, content: chatResponse.content })
        context.push({ role: 'user' as const, content: formatToolResults(calls, results) })
        continue
      }

      // Text protocol path — parse ::TOOL:: / ::PASS:: / natural language
      const parsed = parseResponse(chatResponse.content)

      // Tool call — execute and continue loop
      if (parsed.action === 'tool_call' && toolExecutor) {
        const results = await toolExecutor(parsed.toolCalls, triggerRoomId)

        context.push({ role: 'assistant' as const, content: chatResponse.content })
        context.push({ role: 'user' as const, content: formatToolResults(parsed.toolCalls, results) })

        continue
      }

      // tool_call without executor — fall back to pass
      if (parsed.action === 'tool_call') {
        return makeResult({
          response: { action: 'pass', reason: 'Tool calls not available' },
          generationMs: totalGenerationMs,
          triggerRoomId,
          triggerPeerId,
        })
      }

      // respond or pass — return decision
      return makeResult({
        response: parsed,
        generationMs: totalGenerationMs,
        triggerRoomId,
        triggerPeerId,
      })
    }

    // Max iterations reached
    return makeResult({
      response: { action: 'pass', reason: `Tool call loop exceeded ${maxToolIterations} iterations` },
      generationMs: totalGenerationMs,
      triggerRoomId,
      triggerPeerId,
    })
  } catch (err) {
    console.error(`[${config.name}] LLM call failed:`, err)
    return makeResult({
      response: { action: 'pass', reason: `LLM error: ${err instanceof Error ? err.message : 'unknown'}` },
      generationMs: totalGenerationMs,
      triggerRoomId,
      triggerPeerId,
    })
  }
}
