// ============================================================================
// Evaluation — LLM interaction engine with tool loop (ReAct pattern).
//
// evaluate() builds context, calls the LLM, handles native tool calls in a
// loop, and returns a Decision. The `pass` tool allows agents to decline
// responding. All tool calling uses the model's native structured format.
// ============================================================================

import type { AgentResponse, AIAgentConfig } from '../core/types/agent.ts'
import type { ChatRequest, LLMCallOptions, LLMProvider } from '../core/types/llm.ts'
import type { EvalEventCore } from '../core/types/agent-eval.ts'
import type { NativeToolCall, ToolCall, ToolDefinition, ToolExecutor, ToolResult } from '../core/types/tool.ts'
import type { ToolTraceEntry } from '../core/types/messaging.ts'
import type { ContextResult, FlushInfo } from './context-builder.ts'
import { classifyLLMError } from './error-classify.ts'
import { extractFences } from './fence-extract.ts'
import { parseMapBody, formatMapErrors } from '../core/render-validators/map-schema.ts'

// Max times the eval loop will ask the LLM to fix an invalid map/geojson
// fence before giving up and posting the broken response (the UI banner
// then takes over). Independent of `maxToolIterations` — a tool-heavy
// agent must not lose fence retries to its tool budget.
const MAX_FENCE_RETRIES = 2

// === Decision — what the agent wants to do after evaluation ===

export interface Decision {
  readonly response: AgentResponse
  readonly generationMs: number
  readonly triggerRoomId: string
  readonly inReplyTo?: ReadonlyArray<string>
  readonly metrics?: LLMCallMetrics
  // Every tool call this agent made during the turn. Attached only when the
  // agent invoked tools. Forwarded by spawn.onDecision onto the posted Message.
  readonly toolTrace?: ReadonlyArray<ToolTraceEntry>
}

export type OnDecision = (decision: Decision) => void

// === Native tool call conversion ===

const nativeCallsToToolCalls = (native: ReadonlyArray<NativeToolCall>): ReadonlyArray<ToolCall> =>
  native.map(tc => ({ tool: tc.function.name, arguments: tc.function.arguments }))

// === Tool result injection ===
//
// No artificial cap on tool result size. Fence-emitting tools
// (procedure_lookup, vatsim_arrivals, norway_platforms, the map/mermaid/
// geojson tools) routinely produce 5-50 KB payloads that MUST reach the
// model intact — truncating mid-fence breaks the renderer downstream.
// If a tool genuinely returns runaway output, fix the tool; do not paper
// over it here.

// Render a tool's `data` field for inclusion in the LLM's next turn.
//
// String results pass through verbatim (no JSON.stringify wrapping, which
// would add `"..."` quote-wrapping and escape every newline as `\n`,
// forcing the model to mentally unescape before pasting). This is the
// single most-impactful fix for fence-emitting tools like norway_platforms
// and procedure_lookup: the fence reaches the model with real newlines
// and no escape clutter.
//
// Object/array results are pretty-printed with 2-space indent so newlines
// are real characters the model parses as structure, not `\n` literals.
//
// Other primitives (number, boolean, null) JSON-stringify cleanly.
export const formatToolDataForLLM = (data: unknown): string => {
  if (typeof data === 'string') return data
  // null / undefined → empty string; agents see a blank result instead of
  // the four-character literal "null".
  if (data === null || data === undefined) return ''
  try { return JSON.stringify(data, null, 2) } catch {
    // Circular or otherwise un-serialisable — fall back to String() so the
    // tool result still reaches the LLM (even if uninformative).
    return String(data)
  }
}

// formatToolResults composes the user-role message the eval loop pushes
// back to the LLM after running tool calls. The trailer instruction is
// the single guardrail keeping fence-shaped output (```map / ```mermaid /
// ```geojson / ```biometric) intact through to the renderer. Without the
// "include fenced code blocks intact" reminder, models paraphrase
// brittle syntax like mermaid node ids and break the post-render path.
const formatToolResults = (
  calls: ReadonlyArray<ToolCall>,
  results: ReadonlyArray<ToolResult>,
): string => {
  const lines = results.map((r, i) => {
    const toolName = calls[i]?.tool ?? '<unknown>'
    if (!r.success) return `- ${toolName}: Error: ${r.error ?? ''}`
    return `- ${toolName}: ${formatToolDataForLLM(r.data)}`
  })
  return `Tool results:\n${lines.join('\n')}\n\nUse the tool results above as you see fit. If a result contains a fenced code block (triple-backticks), include it in your reply intact — do not paraphrase the contents or rewrite identifiers inside the fence.`
}

// === Evaluate — single LLM call with tool loop ===

export interface EvalResult {
  readonly decision: Decision
  readonly flushInfo: FlushInfo
}

// === LLM call shape ===
// LLMService applies cooldown skip, chain walk, network retry, content
// strip, and observability. The agent layer just streams the result. No
// per-agent retry policy.

export interface LLMCallMetrics {
  readonly promptTokens?: number
  readonly completionTokens?: number
  // Prompt-cache hit metrics surfaced through the posted message so cache
  // efficacy is observable in the JSONL log without dashboard inspection.
  readonly cacheCreation?: number
  readonly cacheRead?: number
  readonly contextMax?: number
  readonly provider?: string
  readonly model?: string
}

// One LLM call: either streams chunks to onEvent or falls back to a
// non-streaming chat(). Caller-visible result is identical either way.
const callLLMOnce = async (
  provider: LLMProvider,
  request: ChatRequest,
  onEvent?: (e: EvalEventCore) => void,
  signal?: AbortSignal,
): Promise<{ content: string; toolCalls?: ReadonlyArray<NativeToolCall>; durationMs: number; metrics: LLMCallMetrics }> => {
  const startMs = performance.now()

  if (provider.stream) {
    let content = ''
    let toolCalls: ReadonlyArray<NativeToolCall> | undefined
    let metrics: LLMCallMetrics = {}
    for await (const chunk of provider.stream(request, signal)) {
      if (chunk.thinking) onEvent?.({ kind: 'thinking', delta: chunk.thinking })
      if (chunk.delta) {
        content += chunk.delta
        onEvent?.({ kind: 'chunk', delta: chunk.delta })
      }
      if (chunk.done) {
        if (chunk.toolCalls?.length) toolCalls = chunk.toolCalls
        metrics = {
          promptTokens: chunk.tokensUsed?.prompt,
          completionTokens: chunk.tokensUsed?.completion,
          ...(chunk.tokensUsed?.cacheCreation !== undefined ? { cacheCreation: chunk.tokensUsed.cacheCreation } : {}),
          ...(chunk.tokensUsed?.cacheRead !== undefined ? { cacheRead: chunk.tokensUsed.cacheRead } : {}),
          contextMax: chunk.contextMax,
          provider: chunk.provider,
          model: request.model,
        }
      }
    }
    return { content: content.trim(), toolCalls, durationMs: Math.round(performance.now() - startMs), metrics }
  }

  const response = await provider.chat(request)
  onEvent?.({ kind: 'chunk', delta: response.content })
  return {
    content: response.content,
    toolCalls: response.toolCalls,
    durationMs: response.generationMs,
    metrics: {
      promptTokens: response.tokensUsed.prompt,
      completionTokens: response.tokensUsed.completion,
      ...(response.tokensUsed.cacheCreation !== undefined ? { cacheCreation: response.tokensUsed.cacheCreation } : {}),
      ...(response.tokensUsed.cacheRead !== undefined ? { cacheRead: response.tokensUsed.cacheRead } : {}),
      contextMax: response.contextMax,
      provider: response.provider,
      model: request.model,
    },
  }
}

// === Map-fence validation + retry ===
//
// Validate every ```map and ```geojson fence in the response content. If
// any are invalid, append a synthetic correction prompt to the conversation
// context and re-call the LLM. Repeat up to MAX_FENCE_RETRIES times. Returns
// the final response content (corrected if a retry succeeded; the last
// attempt's content if all retries failed — the UI banner then shows the
// errors below the fence).
//
// Map-only by design: mermaid's parser is browser-only; a server-side
// validator would only catch trivial cases (oversized, completely wrong
// keyword) and miss real syntax errors. Honest scoping > pretend-bulletproof.
const validateAllMapFences = (content: string): { ok: boolean; errors: string } => {
  const fences = extractFences(content, ['map', 'geojson'])
  if (fences.length === 0) return { ok: true, errors: '' }
  const errorParts: string[] = []
  for (const fence of fences) {
    const result = parseMapBody(fence.body)
    if (!result.ok) {
      errorParts.push(
        `\`\`\`${fence.language}\` block at content line ${fence.startLine}:\n${formatMapErrors(result.errors)}`,
      )
    }
  }
  return errorParts.length === 0
    ? { ok: true, errors: '' }
    : { ok: false, errors: errorParts.join('\n\n') }
}

const retryInvalidMapFences = async (
  initialContent: string,
  context: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  config: AIAgentConfig,
  llmProvider: LLMProvider,
  signal: AbortSignal | undefined,
  onEvent: ((event: EvalEventCore) => void) | undefined,
  systemBlocks: ContextResult['systemBlocks'],
  toolDefinitions: ReadonlyArray<ToolDefinition> | undefined,
  addGenerationMs: (ms: number) => void,
  setLastMetrics: (m: LLMCallMetrics) => void,
): Promise<string> => {
  let content = initialContent
  for (let attempt = 0; attempt < MAX_FENCE_RETRIES; attempt++) {
    const validation = validateAllMapFences(content)
    if (validation.ok) return content
    // Append the invalid response + a precise correction prompt. The next
    // LLM call will see (a) what it just emitted, (b) why it failed,
    // (c) instruction to re-emit a corrected version.
    context.push({ role: 'assistant' as const, content })
    context.push({
      role: 'user' as const,
      content:
        `Your previous response contained one or more invalid map fences:\n\n${validation.errors}\n\n` +
        `Re-emit the FULL corrected response (keep the surrounding prose, fix the fence schema). ` +
        `Refer to the rendering skill for the canonical schema.`,
    })
    if (signal?.aborted) return content
    const request: ChatRequest = {
      model: config.model,
      messages: context as ReadonlyArray<{ role: 'system' | 'user' | 'assistant'; content: string }>,
      temperature: config.temperature,
      ...(config.seed !== undefined ? { seed: config.seed } : {}),
      tools: toolDefinitions,
      think: config.thinking,
      ...(systemBlocks ? { systemBlocks } : {}),
    }
    const stream = await callLLMOnce(llmProvider, request, onEvent, signal)
    addGenerationMs(stream.durationMs)
    setLastMetrics(stream.metrics)
    content = stream.content.trim()
    if (content.length === 0) {
      // Empty correction attempt — give up and return the prior content.
      return initialContent
    }
  }
  // Exhausted retries — return the last attempt as-is. The UI's per-fence
  // validation banner will render the errors to the user, who can prompt
  // for another correction manually.
  return content
}

// === Main evaluation loop ===

export interface EvalOptions {
  readonly toolDefinitions?: ReadonlyArray<ToolDefinition>
  readonly inReplyTo?: ReadonlyArray<string>
  readonly onEvent?: (event: EvalEventCore) => void
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
  let lastMetrics: LLMCallMetrics = {}
  const { toolDefinitions, inReplyTo, onEvent, signal } = options ?? {}

  // Accumulates one entry per tool call across every loop iteration. Attached
  // to the final Decision — lets downstream consumers (export_room, UI)
  // reconstruct what the agent actually did before answering.
  const toolTrace: Array<ToolTraceEntry> = []

  // Cap preview at 200 chars — this is a debugging/analysis aid for the
  // UI trace panel, not context fed to the LLM, and arbitrarily long
  // previews would bloat every message blob the UI ships.
  const PREVIEW_MAX = 200
  const previewFor = (result: ToolResult): string => {
    const raw = result.success
      ? JSON.stringify(result.data ?? null)
      : (result.error ?? '')
    return raw.length > PREVIEW_MAX ? `${raw.slice(0, PREVIEW_MAX)}…` : raw
  }

  const makeResult = (decision: Decision): EvalResult => {
    // Emit `eval_completed` exactly once per evaluate() call. This is the
    // single source of truth for "this agent is done" — anything that
    // previously polled agent.state can rely on this firing on every
    // terminal path because every `return` in evaluate() routes through
    // makeResult.
    onEvent?.({ kind: 'eval_completed', outcome: decision.response.action })
    return {
      decision: {
        ...(inReplyTo && inReplyTo.length > 0 ? { ...decision, inReplyTo } : decision),
        metrics: lastMetrics,
        ...(toolTrace.length > 0 ? { toolTrace: [...toolTrace] } : {}),
      },
      flushInfo: contextResult.flushInfo,
    }
  }

  // Track the latest non-empty text the model emitted across tool rounds.
  // When the loop hits maxToolIterations we surface this to the user along
  // with the pass reason, instead of replacing the streamed text with a bare
  // [pass] message — that was a bad UX where you'd see the agent typing,
  // then watch its message get deleted and replaced with a terse error.
  let lastAssistantText = ''

  try {
    for (let toolRound = 0; toolRound <= maxToolIterations; toolRound++) {
      const request: ChatRequest = {
        model: config.model,
        messages: context as ReadonlyArray<{ role: 'system' | 'user' | 'assistant'; content: string }>,
        temperature: config.temperature,
        ...(config.seed !== undefined ? { seed: config.seed } : {}),
        tools: toolDefinitions,
        think: config.thinking,
        ...(contextResult.systemBlocks ? { systemBlocks: contextResult.systemBlocks } : {}),
      }

      const streamResult = await callLLMOnce(llmProvider, request, onEvent, signal)
      totalGenerationMs += streamResult.durationMs
      lastMetrics = streamResult.metrics

      // Native tool calls
      if (streamResult.toolCalls && streamResult.toolCalls.length > 0) {
        // Hold on to any text the model emitted before/alongside the tool
        // calls — the user just watched it stream in. If we end up exhausting
        // iterations, this is what we restore so the chat doesn't blank out.
        if (streamResult.content && streamResult.content.trim().length > 0) {
          lastAssistantText = streamResult.content.trim()
        }
        const calls = nativeCallsToToolCalls(streamResult.toolCalls)

        // pass tool → return pass decision without executing
        if (calls.length === 1 && calls[0]!.tool === 'pass') {
          return makeResult({ response: { action: 'pass', reason: (calls[0]!.arguments.reason as string) ?? 'nothing to add' }, generationMs: totalGenerationMs, triggerRoomId })
        }

        if (!toolExecutor) {
          return makeResult({
            response: { action: 'error', code: 'tools_unavailable', message: 'Model emitted tool calls but no executor is wired' },
            generationMs: totalGenerationMs,
            triggerRoomId,
          })
        }

        for (let i = 0; i < calls.length; i++) {
          const call = calls[i]!
          onEvent?.({ kind: 'tool_start', tool: call.tool, callId: String(i) })
        }
        const results = await toolExecutor(calls, triggerRoomId)
        for (let i = 0; i < results.length; i++) {
          const call = calls[i]
          const result = results[i]
          if (!call || !result) continue
          onEvent?.({ kind: 'tool_result', tool: call.tool, callId: String(i), success: result.success, preview: result.success ? undefined : result.error })
          toolTrace.push({
            tool: call.tool,
            arguments: call.arguments,
            success: result.success,
            resultPreview: previewFor(result),
          })
        }
        context.push({ role: 'assistant' as const, content: streamResult.content })
        context.push({ role: 'user' as const, content: formatToolResults(calls, results) })
        continue
      }

      // No tool calls → response text is the message.
      const content = streamResult.content.trim()
      if (content.length === 0) {
        return makeResult({
          response: { action: 'error', code: 'empty_response', message: 'LLM returned no content and no tool calls' },
          generationMs: totalGenerationMs,
          triggerRoomId,
        })
      }
      // Map-fence retry loop: validate any ```map / ```geojson fences in
      // the response. If invalid, append a synthetic correction prompt to
      // context and re-call the LLM up to MAX_FENCE_RETRIES times. Each
      // retry streams live (the user sees the rewrite); only the final
      // response is committed via makeResult. Retry budget is independent
      // of toolRound — fence retries don't consume tool-iteration budget.
      //
      // Map-only on purpose: mermaid's parser is browser-only and a
      // server-side validator would be a smell-test, not a real check.
      // Honest scoping > pretending to bulletproof.
      const finalContent = await retryInvalidMapFences(
        content,
        context,
        config,
        llmProvider,
        signal,
        onEvent,
        contextResult.systemBlocks,
        toolDefinitions,
        (ms) => { totalGenerationMs += ms },
        (m) => { lastMetrics = m },
      )
      return makeResult({ response: { action: 'respond', content: finalContent }, generationMs: totalGenerationMs, triggerRoomId })
    }

    // Max iterations reached. If the model produced any visible text along
    // the way, deliver it with a footer instead of replacing it with a bare
    // pass. Without this, the user sees streamed text disappear and a terse
    // [pass] error take its place.
    const loopReason = `Tool call loop exceeded ${maxToolIterations} iterations`
    if (lastAssistantText.length > 0) {
      return makeResult({
        response: {
          action: 'respond',
          content: `${lastAssistantText}\n\n_⚠ ${loopReason} — partial result._`,
        },
        generationMs: totalGenerationMs,
        triggerRoomId,
      })
    }
    return makeResult({
      response: { action: 'error', code: 'tool_loop_exceeded', message: loopReason },
      generationMs: totalGenerationMs,
      triggerRoomId,
    })
  } catch (err) {
    const classified = classifyLLMError(err)
    // LLMService attaches `remediation` to thrown errors derived from the
    // structured attempts[] array. When present, append to the user-visible
    // message so the agent's error bubble includes actionable next steps
    // ("Set a fallback chain in Settings → Providers", etc.) rather than
    // just the raw upstream string.
    const remediation = (err as { remediation?: string }).remediation
    const message = remediation && remediation.length > 0
      ? `${classified.message}\n\n${remediation}`
      : classified.message
    onEvent?.({ kind: 'warning', message })
    return makeResult({
      response: {
        action: 'error',
        code: classified.code,
        message,
        ...(classified.providerHint ? { providerHint: classified.providerHint } : {}),
      },
      generationMs: totalGenerationMs,
      triggerRoomId,
    })
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
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
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
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
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
