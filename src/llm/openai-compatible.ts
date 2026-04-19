// ============================================================================
// OpenAI-compatible provider — Groq, Cerebras, OpenRouter, Mistral, SambaNova.
//
// All five providers speak the OpenAI Chat Completions API. This adapter
// converts samsinn's ChatRequest/ChatResponse to/from OpenAI format, handles
// incremental tool-call accumulation in streaming, and maps HTTP failure
// modes to typed CloudProviderError variants (rate_limit, quota, auth,
// provider_down) so the router can decide whether to fall through.
//
// Behaviour specific to individual providers (e.g. OpenRouter's ":free"
// model slugs, DeepSeek R1's <think>...</think> content stream) is handled
// here rather than requiring per-provider subclasses.
// ============================================================================

import type { LLMProvider, ChatRequest, ChatResponse, StreamChunk } from '../core/types/llm.ts'
import type { NativeToolCall } from '../core/types/tool.ts'
import { createCloudProviderError, parseRetryAfterMs } from './errors.ts'

const DEFAULT_CHAT_TIMEOUT_MS = 300_000
const DEFAULT_MODELS_TIMEOUT_MS = 10_000
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000

// === Config ===

export interface OpenAICompatConfig {
  readonly name: string                  // logical provider name, e.g. "groq"
  readonly baseUrl: string               // e.g. "https://api.groq.com/openai/v1"
  // Resolved lazily so runtime key changes take effect without restart.
  readonly getApiKey: () => string
  // Optional extra headers (e.g. Anthropic's `anthropic-version`) — resolved
  // per request for symmetry with `getApiKey`.
  readonly extraHeaders?: () => Record<string, string>
  readonly chatTimeoutMs?: number
  readonly modelsTimeoutMs?: number
  readonly streamIdleTimeoutMs?: number
}

// === OpenAI wire types ===

// Anthropic's OpenAI-compat endpoint accepts an array of content parts on a
// message, where each part can carry a `cache_control` marker. We only emit
// this shape when talking to Anthropic; other providers continue to get a
// plain string in `content`.
interface OAIContentPart {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}

interface OAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ReadonlyArray<OAIContentPart> | null
  tool_calls?: ReadonlyArray<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

interface OAIChatResponse {
  id?: string
  model?: string
  choices: ReadonlyArray<{
    message: OAIMessage
    finish_reason?: string
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    // Anthropic-specific. Passed through when present.
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

interface OAIStreamChunk {
  choices?: ReadonlyArray<{
    delta?: {
      content?: string
      tool_calls?: ReadonlyArray<{
        index?: number
        id?: string
        type?: 'function'
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
    finish_reason?: string
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  }
}

interface OAIModelsResponse {
  data?: ReadonlyArray<{ id: string }>
}

// === Error mapping ===

const mapHttpError = (
  providerName: string,
  status: number,
  body: string,
  retryAfterHeader: string | null,
): Error => {
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader)
  const snippet = body.slice(0, 300)

  if (status === 401 || status === 403) {
    // Many providers return 429/403 for quota; distinguish via body text.
    const bodyLower = body.toLowerCase()
    if (bodyLower.includes('quota') || bodyLower.includes('exceeded') || bodyLower.includes('limit')) {
      return createCloudProviderError({
        code: 'quota', provider: providerName, message: `${providerName} quota exceeded: ${snippet}`,
        status, retryAfterMs,
      })
    }
    return createCloudProviderError({
      code: 'auth', provider: providerName, message: `${providerName} auth error ${status}: ${snippet}`,
      status,
    })
  }
  if (status === 429) {
    return createCloudProviderError({
      code: 'rate_limit', provider: providerName, message: `${providerName} rate-limited: ${snippet}`,
      status, retryAfterMs,
    })
  }
  if (status >= 500) {
    return createCloudProviderError({
      code: 'provider_down', provider: providerName, message: `${providerName} server error ${status}: ${snippet}`,
      status, retryAfterMs,
    })
  }
  // Per-model limitations that aren't permanent config errors — classify as
  // provider_down so the router falls through for bare model names. Prefix-
  // pinned models still throw because the router doesn't fall back on pins.
  //   - context_length_exceeded: request too long for this model's window
  //   - model_not_found: provider's /models listed it but the account can't
  //     actually use it (common on Cerebras free-tier for premium models)
  const bodyLowerFull = body.toLowerCase()
  const isContextIssue = bodyLowerFull.includes('context_length_exceeded') || bodyLowerFull.includes('maximum context length')
  const isModelIssue = status === 404 || bodyLowerFull.includes('model_not_found') || bodyLowerFull.includes('does not exist')
  if (isContextIssue) {
    return createCloudProviderError({
      code: 'provider_down', provider: providerName,
      message: `${providerName} context-length exceeded: ${snippet}`,
      status,
    })
  }
  if (isModelIssue) {
    return createCloudProviderError({
      code: 'provider_down', provider: providerName,
      message: `${providerName} model not available: ${snippet}`,
      status,
    })
  }
  // Other 4xx — treat as bad_request (permanent, do not fall through).
  return createCloudProviderError({
    code: 'bad_request', provider: providerName, message: `${providerName} request error ${status}: ${snippet}`,
    status,
  })
}

// === Request conversion ===

const toOAIMessages = (request: ChatRequest, providerName: string): OAIMessage[] => {
  // Anthropic path: if systemBlocks are provided, emit the system message as
  // an array of content parts with `cache_control: ephemeral` on the last
  // cacheable block. Anthropic's caching is triggered by the marker and caches
  // every token from message start up to (and including) that marker.
  if (providerName === 'anthropic' && request.systemBlocks && request.systemBlocks.length > 0) {
    const out: OAIMessage[] = []
    const systemParts: OAIContentPart[] = []
    // Find last cacheable block so we know where to put the single marker.
    let lastCacheableIdx = -1
    for (let i = 0; i < request.systemBlocks.length; i++) {
      if (request.systemBlocks[i]!.cacheable) lastCacheableIdx = i
    }
    for (let i = 0; i < request.systemBlocks.length; i++) {
      const block = request.systemBlocks[i]!
      if (!block.text) continue
      const part: OAIContentPart = { type: 'text', text: block.text }
      if (i === lastCacheableIdx) part.cache_control = { type: 'ephemeral' }
      systemParts.push(part)
    }
    if (systemParts.length > 0) {
      out.push({ role: 'system', content: systemParts })
    }
    // Remaining non-system messages pass through as strings.
    for (const m of request.messages) {
      if (m.role === 'system') continue // superseded by systemParts above
      out.push({ role: m.role, content: m.content })
    }
    return out
  }
  // Default path — plain strings.
  return request.messages.map(m => ({ role: m.role, content: m.content }))
}

const buildOAIBody = (request: ChatRequest, stream: boolean, providerName: string): Record<string, unknown> => {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: toOAIMessages(request, providerName),
    stream,
  }
  // Ask providers to include a final usage frame (supported by OpenAI, Groq,
  // Cerebras, OpenRouter). Providers that don't support it ignore the flag.
  if (stream) body.stream_options = { include_usage: true }
  if (request.temperature !== undefined) body.temperature = request.temperature
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens
  if (request.jsonMode) body.response_format = { type: 'json_object' }
  if (request.tools && request.tools.length > 0) body.tools = request.tools
  return body
}

// Some providers (DeepSeek R1 via OpenRouter) emit chain-of-thought inside
// <think>...</think> in the content stream, without a dedicated "thinking"
// field. We pull those out into StreamChunk.thinking to keep samsinn's
// thinking-indicator UX working.
const splitThinkAndContent = (raw: string): { thinking: string; content: string } => {
  let thinking = ''
  let content = ''
  let cursor = 0
  const openRe = /<think>/gi
  while (cursor < raw.length) {
    openRe.lastIndex = cursor
    const open = openRe.exec(raw)
    if (!open) {
      content += raw.slice(cursor)
      break
    }
    content += raw.slice(cursor, open.index)
    const closeIdx = raw.indexOf('</think>', open.index + open[0].length)
    if (closeIdx === -1) {
      thinking += raw.slice(open.index + open[0].length)
      break
    }
    thinking += raw.slice(open.index + open[0].length, closeIdx)
    cursor = closeIdx + '</think>'.length
  }
  return { thinking, content }
}

// === Factory ===

export const createOpenAICompatibleProvider = (config: OpenAICompatConfig): LLMProvider => {
  const chatTimeoutMs = config.chatTimeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS
  const modelsTimeoutMs = config.modelsTimeoutMs ?? DEFAULT_MODELS_TIMEOUT_MS
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS

  const headers = (): Record<string, string> => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.getApiKey()}`,
    ...(config.extraHeaders?.() ?? {}),
  })

  const fetchWithTimeout = async (url: string, init: RequestInit, timeoutMs: number): Promise<Response> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await fetch(url, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  const chat = async (request: ChatRequest): Promise<ChatResponse> => {
    const startMs = performance.now()
    const body = buildOAIBody(request, false, config.name)

    const response = await fetchWithTimeout(
      `${config.baseUrl}/chat/completions`,
      { method: 'POST', headers: headers(), body: JSON.stringify(body) },
      chatTimeoutMs,
    )

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw mapHttpError(config.name, response.status, text, response.headers.get('retry-after'))
    }

    const data = (await response.json()) as OAIChatResponse
    const choice = data.choices?.[0]
    if (!choice) {
      throw createCloudProviderError({
        code: 'provider_down', provider: config.name,
        message: `${config.name}: empty choices array`,
        status: response.status,
      })
    }

    // Anthropic's OAI-compat response returns content as either a plain
    // string or an array of content parts. Normalise to string.
    const rawContentRaw = choice.message.content
    const rawContent: string = typeof rawContentRaw === 'string'
      ? rawContentRaw
      : Array.isArray(rawContentRaw)
        ? rawContentRaw.filter(p => p.type === 'text').map(p => p.text).join('')
        : ''
    const { thinking, content } = splitThinkAndContent(rawContent)
    void thinking // thinking in non-streaming is discarded — samsinn only surfaces it during streaming

    const toolCalls: NativeToolCall[] | undefined = choice.message.tool_calls?.length
      ? choice.message.tool_calls.map(tc => ({
          function: {
            name: tc.function.name,
            arguments: parseArgs(tc.function.arguments),
          },
        }))
      : undefined

    const generationMs = Math.round(performance.now() - startMs)
    const cacheCreation = data.usage?.cache_creation_input_tokens
    const cacheRead = data.usage?.cache_read_input_tokens
    return {
      content,
      generationMs,
      tokensUsed: {
        prompt: data.usage?.prompt_tokens ?? 0,
        completion: data.usage?.completion_tokens ?? 0,
        ...(cacheCreation !== undefined ? { cacheCreation } : {}),
        ...(cacheRead !== undefined ? { cacheRead } : {}),
      },
      toolCalls,
    }
  }

  const stream = async function* (request: ChatRequest, externalSignal?: AbortSignal): AsyncIterable<StreamChunk> {
    const body = buildOAIBody(request, true, config.name)

    const controller = new AbortController()
    let idleTimer = setTimeout(() => controller.abort(), streamIdleTimeoutMs)
    if (externalSignal) {
      externalSignal.addEventListener('abort', () => controller.abort(), { once: true })
    }

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      clearTimeout(idleTimer)
      const text = await response.text().catch(() => '')
      throw mapHttpError(config.name, response.status, text, response.headers.get('retry-after'))
    }

    const reader = response.body?.getReader()
    if (!reader) {
      clearTimeout(idleTimer)
      throw createCloudProviderError({
        code: 'provider_down', provider: config.name,
        message: `${config.name} stream: no response body`,
      })
    }

    const decoder = new TextDecoder()
    let buffer = ''
    // Accumulators for incremental tool calls (OpenAI streams arguments as fragments).
    const toolAccum: Array<{ id?: string; name: string; argsBuffer: string }> = []
    // Accumulator for <think> block spanning chunks.
    let inThink = false
    let thinkCarry = ''

    const flushDelta = (delta: string): StreamChunk | null => {
      if (!delta) return null
      let thinkingOut = ''
      let contentOut = ''
      let cursor = 0
      while (cursor < delta.length) {
        if (inThink) {
          const close = delta.indexOf('</think>', cursor)
          if (close === -1) {
            thinkingOut += delta.slice(cursor)
            break
          }
          thinkingOut += delta.slice(cursor, close)
          inThink = false
          cursor = close + '</think>'.length
        } else {
          const combined = thinkCarry + delta.slice(cursor)
          const openIdx = combined.indexOf('<think>')
          if (openIdx === -1) {
            // Possible partial "<think" at tail — keep up to 6 chars as carry.
            const safe = combined.length - 6
            if (safe > 0) {
              contentOut += combined.slice(0, safe)
              thinkCarry = combined.slice(safe)
            } else {
              thinkCarry = combined
            }
            break
          }
          contentOut += combined.slice(0, openIdx)
          thinkCarry = ''
          inThink = true
          cursor = delta.length - (combined.length - (openIdx + '<think>'.length))
        }
      }
      if (!thinkingOut && !contentOut) return null
      const out: StreamChunk = { delta: contentOut, done: false }
      if (thinkingOut) (out as { thinking?: string }).thinking = thinkingOut
      return out
    }

    // Accumulators for final-chunk metadata (finish_reason may arrive before
    // [DONE]; usage typically arrives AFTER finish_reason but BEFORE [DONE]).
    let finishSeen = false
    let usageTokens: { prompt: number; completion: number } | undefined

    const emitFinal = (): StreamChunk => {
      const toolCalls: NativeToolCall[] | undefined = toolAccum.length
        ? toolAccum.map(t => ({
            function: { name: t.name, arguments: parseArgs(t.argsBuffer) },
          }))
        : undefined
      const chunk: StreamChunk = {
        delta: '', done: true,
        ...(toolCalls ? { toolCalls } : {}),
        ...(usageTokens ? { tokensUsed: usageTokens } : {}),
      }
      return chunk
    }

    try {
      while (true) {
        clearTimeout(idleTimer)
        idleTimer = setTimeout(() => controller.abort(), streamIdleTimeoutMs)
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // SSE: split on double-newline frames.
        let sep = buffer.indexOf('\n\n')
        while (sep !== -1) {
          const frame = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          sep = buffer.indexOf('\n\n')

          // Each frame may have multiple "data:" lines.
          const dataLines = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim())
          for (const payload of dataLines) {
            if (payload === '[DONE]') {
              if (thinkCarry) { yield { delta: thinkCarry, done: false }; thinkCarry = '' }
              yield emitFinal()
              return
            }
            let parsed: OAIStreamChunk
            try { parsed = JSON.parse(payload) } catch { continue }

            // Final usage frame (OpenAI with include_usage: true; Groq,
            // Cerebras follow the same convention). The frame carries an
            // empty choices array + a `usage` field.
            if (parsed.usage && (parsed.usage.prompt_tokens !== undefined || parsed.usage.completion_tokens !== undefined)) {
              usageTokens = {
                prompt: parsed.usage.prompt_tokens ?? 0,
                completion: parsed.usage.completion_tokens ?? 0,
              }
            }

            const choice = parsed.choices?.[0]
            if (!choice) continue

            const deltaContent = choice.delta?.content ?? ''
            if (deltaContent) {
              const chunk = flushDelta(deltaContent)
              if (chunk) yield chunk
            }

            if (choice.delta?.tool_calls) {
              for (const tc of choice.delta.tool_calls) {
                const idx = tc.index ?? 0
                if (!toolAccum[idx]) toolAccum[idx] = { name: '', argsBuffer: '' }
                const acc = toolAccum[idx]
                if (tc.id) acc.id = tc.id
                if (tc.function?.name) acc.name = tc.function.name
                if (tc.function?.arguments) acc.argsBuffer += tc.function.arguments
              }
            }

            if (choice.finish_reason) {
              // Mark finish but don't emit yet — wait one more frame in case
              // usage arrives (it typically does on a subsequent SSE event).
              finishSeen = true
            }
          }
        }
      }
      // Reader closed. Emit final chunk with whatever we've accumulated.
      if (thinkCarry) yield { delta: thinkCarry, done: false }
      yield emitFinal()
      void finishSeen  // value consumed by the loop logic above
    } finally {
      clearTimeout(idleTimer)
      reader.releaseLock()
    }
  }

  const models = async (): Promise<string[]> => {
    const response = await fetchWithTimeout(
      `${config.baseUrl}/models`,
      { headers: headers() },
      modelsTimeoutMs,
    )
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw mapHttpError(config.name, response.status, text, response.headers.get('retry-after'))
    }
    const data = (await response.json()) as OAIModelsResponse
    return (data.data ?? []).map(m => m.id)
  }

  return { chat, stream, models }
}

// OpenAI tool_call.function.arguments is a JSON string. Ollama passes an object.
// samsinn's NativeToolCall expects an object.
const parseArgs = (raw: string): Record<string, unknown> => {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}
