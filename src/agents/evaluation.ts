// ============================================================================
// Evaluation — LLM interaction engine with tool loop (ReAct pattern).
//
// evaluate() builds context, calls the LLM, handles native tool calls in a
// loop, and returns a Decision. The `pass` tool allows agents to decline
// responding. All tool calling uses the model's native structured format.
// ============================================================================

import type {
  AgentResponse,
  AIAgentConfig,
  ChatRequest,
  EvalEvent,
  LLMCallOptions,
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
  readonly triggerRoomId: string
  readonly inReplyTo?: ReadonlyArray<string>
}

export type OnDecision = (decision: Decision) => void

// === Native tool call conversion ===

const nativeCallsToToolCalls = (native: ReadonlyArray<NativeToolCall>): ReadonlyArray<ToolCall> =>
  native.map(tc => ({ tool: tc.function.name, arguments: tc.function.arguments }))

// === Tool result injection ===

const MAX_TOOL_RESULT_CHARS = 4_000

const truncateResult = (s: string, maxChars: number): string =>
  s.length > maxChars
    ? `${s.slice(0, maxChars)}\n[... ${s.length - maxChars} characters omitted]`
    : s

const formatToolResults = (
  calls: ReadonlyArray<ToolCall>,
  results: ReadonlyArray<ToolResult>,
  maxChars: number,
): string => {
  const lines = results.map((r, i) => {
    const value = r.success
      ? truncateResult(JSON.stringify(r.data), maxChars)
      : `Error: ${truncateResult(r.error ?? '', maxChars)}`
    return `- ${calls[i]?.tool}: ${value}`
  })
  return `Tool results:\n${lines.join('\n')}\n\nNow respond to the conversation using these results. Write your response as natural text.`
}

// === Evaluate — single LLM call with tool loop ===

export interface EvalResult {
  readonly decision: Decision
  readonly flushInfo: FlushInfo
}

// === Streaming LLM call with retry ===

const THINK_BLOCK_RE = /<think>[\s\S]*?<\/think>/g
const LLM_RETRIES = 2
const LLM_RETRY_DELAY_MS = 1000

const streamWithRetry = async (
  provider: LLMProvider,
  config: AIAgentConfig,
  request: ChatRequest,
  onEvent?: (e: EvalEvent) => void,
  signal?: AbortSignal,
): Promise<{ content: string; toolCalls?: ReadonlyArray<NativeToolCall>; durationMs: number }> => {
  for (let attempt = 0; attempt <= LLM_RETRIES; attempt++) {
    try {
      const startMs = performance.now()

      if (provider.stream) {
        let content = ''
        let toolCalls: ReadonlyArray<NativeToolCall> | undefined
        for await (const chunk of provider.stream(request, signal)) {
          if (chunk.delta) {
            content += chunk.delta
            onEvent?.({ kind: 'chunk', delta: chunk.delta })
          }
          if (chunk.done && chunk.toolCalls?.length) {
            toolCalls = chunk.toolCalls
          }
        }
        // Strip think blocks and trim
        content = content.replace(THINK_BLOCK_RE, '').trim()
        return { content, toolCalls, durationMs: Math.round(performance.now() - startMs) }
      }

      // Fallback: provider doesn't support streaming — use chat()
      const response = await provider.chat(request)
      onEvent?.({ kind: 'chunk', delta: response.content })
      return { content: response.content, toolCalls: response.toolCalls, durationMs: response.generationMs }
    } catch (err) {
      if (signal?.aborted) throw err  // Don't retry if cancelled
      const errMsg = err instanceof Error ? err.message : String(err)
      if (attempt < LLM_RETRIES) {
        onEvent?.({ kind: 'warning', message: `LLM call failed (attempt ${attempt + 1}/${LLM_RETRIES + 1}), retrying: ${errMsg}` })
        await new Promise(r => setTimeout(r, LLM_RETRY_DELAY_MS))
      } else {
        throw err
      }
    }
  }
  throw new Error('Unreachable')
}

// === Main evaluation loop ===

export interface EvalOptions {
  readonly toolDefinitions?: ReadonlyArray<ToolDefinition>
  readonly inReplyTo?: ReadonlyArray<string>
  readonly onEvent?: (event: EvalEvent) => void
  readonly signal?: AbortSignal
}

export const evaluate = async (
  contextResult: ContextResult,
  config: AIAgentConfig,
  llmProvider: LLMProvider,
  toolExecutor: ToolExecutor | undefined,
  maxToolIterations: number,
  triggerRoomId: string,
  options?: EvalOptions,
): Promise<EvalResult> => {
  const context = [...contextResult.messages]
  let totalGenerationMs = 0
  const maxToolResultChars = config.maxToolResultChars ?? MAX_TOOL_RESULT_CHARS
  const { toolDefinitions, inReplyTo, onEvent, signal } = options ?? {}

  const makeResult = (decision: Decision): EvalResult => ({
    decision: inReplyTo && inReplyTo.length > 0 ? { ...decision, inReplyTo } : decision,
    flushInfo: contextResult.flushInfo,
  })

  try {
    for (let toolRound = 0; toolRound <= maxToolIterations; toolRound++) {
      const request: ChatRequest = {
        model: config.model,
        messages: context as ReadonlyArray<{ role: 'system' | 'user' | 'assistant'; content: string }>,
        temperature: config.temperature,
        tools: toolDefinitions,
      }

      const streamResult = await streamWithRetry(llmProvider, config, request, onEvent, signal)
      totalGenerationMs += streamResult.durationMs

      // Native tool calls
      if (streamResult.toolCalls && streamResult.toolCalls.length > 0) {
        const calls = nativeCallsToToolCalls(streamResult.toolCalls)

        // pass tool → return pass decision without executing
        if (calls.length === 1 && calls[0]!.tool === 'pass') {
          return makeResult({ response: { action: 'pass', reason: (calls[0]!.arguments.reason as string) ?? 'nothing to add' }, generationMs: totalGenerationMs, triggerRoomId })
        }

        if (!toolExecutor) {
          return makeResult({ response: { action: 'pass', reason: 'Tool calls not available' }, generationMs: totalGenerationMs, triggerRoomId })
        }

        for (const call of calls) onEvent?.({ kind: 'tool_start', tool: call.tool })
        const results = await toolExecutor(calls, triggerRoomId)
        for (let i = 0; i < results.length; i++) {
          onEvent?.({ kind: 'tool_result', tool: calls[i]?.tool ?? 'unknown', success: results[i]?.success ?? false, preview: results[i]?.success ? undefined : results[i]?.error })
        }
        context.push({ role: 'assistant' as const, content: streamResult.content })
        context.push({ role: 'user' as const, content: formatToolResults(calls, results, maxToolResultChars) })
        continue
      }

      // No tool calls → response text is the message
      const content = streamResult.content.trim()
      if (content.length === 0) {
        return makeResult({ response: { action: 'pass', reason: 'Empty response' }, generationMs: totalGenerationMs, triggerRoomId })
      }
      return makeResult({ response: { action: 'respond', content }, generationMs: totalGenerationMs, triggerRoomId })
    }

    // Max iterations reached
    return makeResult({ response: { action: 'pass', reason: `Tool call loop exceeded ${maxToolIterations} iterations` }, generationMs: totalGenerationMs, triggerRoomId })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'unknown'
    onEvent?.({ kind: 'warning', message: `LLM error: ${errMsg}` })
    return makeResult({ response: { action: 'pass', reason: `LLM error: ${errMsg}` }, generationMs: totalGenerationMs, triggerRoomId })
  }
}

// === Standalone LLM call ===
// Single-shot call with no agent state, no history management, no protocol parsing.
// Returns raw model output. Use jsonMode for structured extraction.
// Tool loop support is planned for a future phase — for now, tools are not supported.

export const callLLM = async (
  provider: LLMProvider,
  options: LLMCallOptions,
): Promise<string> => {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = []
  if (options.systemPrompt) {
    messages.push({ role: 'system', content: options.systemPrompt })
  }
  for (const m of options.messages) messages.push(m)
  const response = await provider.chat({
    model: options.model,
    messages,
    temperature: options.temperature,
    jsonMode: options.jsonMode,
  })
  return response.content
}

// Streaming variant — yields raw deltas as they arrive. Falls back to callLLM if
// the provider does not support streaming, emitting the full response as one chunk.
export const streamLLM = async function* (
  provider: LLMProvider,
  options: LLMCallOptions,
): AsyncGenerator<string> {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = []
  if (options.systemPrompt) messages.push({ role: 'system', content: options.systemPrompt })
  for (const m of options.messages) messages.push(m)

  const request = {
    model: options.model,
    messages,
    temperature: options.temperature,
    jsonMode: options.jsonMode,
  }

  if (provider.stream) {
    for await (const chunk of provider.stream(request)) {
      if (chunk.delta) yield chunk.delta
    }
  } else {
    // Provider doesn't support streaming — emit full response as a single delta
    const response = await provider.chat(request)
    yield response.content
  }
}
