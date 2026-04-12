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
  readonly inReplyTo?: ReadonlyArray<string>  // IDs of messages that triggered this decision
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
      if (attempt < LLM_RETRIES) {
        console.warn(`[${config.name}] LLM call failed (attempt ${attempt + 1}/${LLM_RETRIES + 1}), retrying in ${LLM_RETRY_DELAY_MS}ms:`, err instanceof Error ? err.message : err)
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

      // Native tool call path — model returned structured tool calls
      if (streamResult.toolCalls && streamResult.toolCalls.length > 0) {
        if (!toolExecutor) {
          return makeResult({ response: { action: 'pass', reason: 'Tool calls not available' }, generationMs: totalGenerationMs, triggerRoomId })
        }
        const calls = nativeCallsToToolCalls(streamResult.toolCalls)
        for (const call of calls) onEvent?.({ kind: 'tool_start', tool: call.tool })
        const results = await toolExecutor(calls, triggerRoomId)
        for (let i = 0; i < results.length; i++) {
          onEvent?.({ kind: 'tool_result', tool: calls[i]?.tool ?? 'unknown', success: results[i]?.success ?? false, preview: results[i]?.success ? undefined : results[i]?.error })
        }
        context.push({ role: 'assistant' as const, content: streamResult.content })
        context.push({ role: 'user' as const, content: formatToolResults(calls, results, maxToolResultChars) })
        continue
      }

      // Text protocol path — parse ::TOOL:: / ::PASS:: / natural language
      const parsed = parseResponse(streamResult.content)

      // Tool call — execute and continue loop
      if (parsed.action === 'tool_call' && toolExecutor) {
        for (const call of parsed.toolCalls) onEvent?.({ kind: 'tool_start', tool: call.tool })
        const results = await toolExecutor(parsed.toolCalls, triggerRoomId)
        for (let i = 0; i < results.length; i++) {
          onEvent?.({ kind: 'tool_result', tool: parsed.toolCalls[i]?.tool ?? 'unknown', success: results[i]?.success ?? false, preview: results[i]?.success ? undefined : results[i]?.error })
        }
        context.push({ role: 'assistant' as const, content: streamResult.content })
        context.push({ role: 'user' as const, content: formatToolResults(parsed.toolCalls, results, maxToolResultChars) })
        continue
      }

      // tool_call without executor — fall back to pass
      if (parsed.action === 'tool_call') {
        return makeResult({ response: { action: 'pass', reason: 'Tool calls not available' }, generationMs: totalGenerationMs, triggerRoomId })
      }

      // respond or pass — return decision
      return makeResult({ response: parsed, generationMs: totalGenerationMs, triggerRoomId })
    }

    // Max iterations reached
    return makeResult({ response: { action: 'pass', reason: `Tool call loop exceeded ${maxToolIterations} iterations` }, generationMs: totalGenerationMs, triggerRoomId })
  } catch (err) {
    console.error(`[${config.name}] LLM call failed:`, err)
    return makeResult({ response: { action: 'pass', reason: `LLM error: ${err instanceof Error ? err.message : 'unknown'}` }, generationMs: totalGenerationMs, triggerRoomId })
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
