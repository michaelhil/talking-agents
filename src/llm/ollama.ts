import type { LLMProvider, ChatRequest, ChatResponse, StreamChunk } from '../core/types/llm.ts'
import { createOllamaError } from './errors.ts'
import { fetchWithTimeout } from '../core/fetch-utils.ts'

interface OllamaToolCall {
  readonly function: {
    readonly name: string
    readonly arguments: Record<string, unknown>
  }
}

interface OllamaMessage {
  readonly role: string
  readonly content: string
  readonly tool_calls?: ReadonlyArray<OllamaToolCall>
}

interface OllamaChatResponse {
  readonly model: string
  readonly message: OllamaMessage
  readonly done: boolean
  readonly total_duration?: number
  readonly load_duration?: number
  readonly prompt_eval_count?: number
  readonly prompt_eval_duration?: number
  readonly eval_count?: number
  readonly eval_duration?: number
}

interface OllamaTagsResponse {
  readonly models: ReadonlyArray<{ readonly name: string }>
}

export interface OllamaPsModel {
  readonly name: string
  readonly size: number
  readonly size_vram: number
  readonly details?: {
    readonly parameter_size?: string
    readonly quantization_level?: string
  }
  readonly expires_at?: string
}

interface OllamaPsResponse {
  readonly models: ReadonlyArray<OllamaPsModel>
}

const CHAT_TIMEOUT_MS = 300_000 // 5 minutes — large models can be slow
const TAGS_TIMEOUT_MS = 10_000
const STREAM_IDLE_TIMEOUT_MS = 30_000  // abort if no chunk arrives within 30s
const DEFAULT_NUM_CTX = 16384  // modern models support 32K+; 16K gives room for rich context + history

const validateChatResponse = (data: unknown): OllamaChatResponse => {
  if (
    typeof data !== 'object' ||
    data === null ||
    !('message' in data) ||
    typeof (data as Record<string, unknown>).message !== 'object'
  ) {
    throw createOllamaError(0, `Ollama returned unexpected response shape: ${JSON.stringify(data).slice(0, 200)}`)
  }
  const msg = (data as Record<string, unknown>).message as Record<string, unknown>
  if (typeof msg.content !== 'string') {
    throw createOllamaError(0, `Ollama response missing message.content: ${JSON.stringify(data).slice(0, 200)}`)
  }
  return data as OllamaChatResponse
}

// Strip chat-template tokens that some Ollama models leak into their output.
// This is an Ollama-specific concern — the provider contract is clean text out.
const TEMPLATE_TOKEN_RE = /(<\|[^|>]*\|>|\[INST\]|\[\/INST\]|<<SYS>>|<<\/SYS>>|<\|start_header_id\|>.*?<\|end_header_id\|>)/g

const THINK_BLOCK_RE = /<think>[\s\S]*?<\/think>/g

const sanitizeContent = (raw: string): string => {
  let s = raw.replace(TEMPLATE_TOKEN_RE, '')
  // Strip qwen3 thinking blocks — they add latency and noise to responses
  s = s.replace(THINK_BLOCK_RE, '')
  // Strip spurious role-label prefix the model sometimes emits before its response
  s = s.replace(/^(assistant|user|system)\s*[:\n]/i, '')
  return s.trim()
}

export interface OllamaProviderExtended extends LLMProvider {
  readonly runningModelsDetailed: () => Promise<ReadonlyArray<OllamaPsModel>>
  readonly loadModel: (name: string, keepAlive?: string) => Promise<void>
  readonly unloadModel: (name: string) => Promise<void>
  readonly baseUrl: string
  readonly setBaseUrl: (url: string) => void
}

// Ollama doesn't honor OpenAI-style `tool_choice`. We surface this once per
// (model, choice) pair via console.warn so callers expecting forced tool
// invocation aren't silently disappointed.
const warnedToolChoice = new Set<string>()
const warnIgnoredToolChoice = (model: string, choice: ChatRequest['toolChoice']): void => {
  if (choice === undefined || choice === 'auto') return
  const key = `${model}::${typeof choice === 'string' ? choice : `name:${choice.name}`}`
  if (warnedToolChoice.has(key)) return
  warnedToolChoice.add(key)
  console.warn(`[ollama] toolChoice ${JSON.stringify(choice)} ignored for model "${model}" (Ollama does not support tool_choice; behaves as 'auto')`)
}

export const createOllamaProvider = (initialBaseUrl: string): OllamaProviderExtended => {
  let baseUrl = initialBaseUrl
  const chat = async (request: ChatRequest): Promise<ChatResponse> => {
    const startMs = performance.now()

    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
      stream: false,
    }

    if ((request as unknown as Record<string, unknown>).keepAlive !== undefined) {
      body.keep_alive = (request as unknown as Record<string, unknown>).keepAlive
    }

    const options: Record<string, unknown> = {
      num_ctx: request.numCtx ?? DEFAULT_NUM_CTX,
    }

    if (request.temperature !== undefined) options.temperature = request.temperature
    if (request.seed !== undefined) options.seed = request.seed
    if (request.maxTokens !== undefined) options.num_predict = request.maxTokens

    body.options = options

    if (request.jsonMode) {
      body.format = 'json'
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools
      warnIgnoredToolChoice(request.model, request.toolChoice)
    }
    if (request.think !== undefined) body.think = request.think

    const response = await fetchWithTimeout(
      `${baseUrl}/api/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      CHAT_TIMEOUT_MS,
    )

    if (!response.ok) {
      const text = await response.text()
      throw createOllamaError(response.status, `Ollama API error ${response.status}: ${text}`)
    }

    const raw = await response.json()
    const data = validateChatResponse(raw)
    const generationMs = Math.round(performance.now() - startMs)

    const nativeToolCalls = data.message.tool_calls?.length
      ? data.message.tool_calls.map(tc => ({
          function: { name: tc.function.name, arguments: tc.function.arguments },
        }))
      : undefined

    const evalCount = data.eval_count ?? 0
    const evalDurationNs = data.eval_duration ?? 0
    const tokensPerSecond = evalDurationNs > 0 ? (evalCount / evalDurationNs) * 1e9 : undefined
    const promptEvalMs = data.prompt_eval_duration !== undefined ? Math.round(data.prompt_eval_duration / 1e6) : undefined
    const modelLoadMs = data.load_duration !== undefined ? Math.round(data.load_duration / 1e6) : undefined

    return {
      content: sanitizeContent(data.message.content),
      generationMs,
      tokensUsed: {
        prompt: data.prompt_eval_count ?? 0,
        completion: evalCount,
      },
      toolCalls: nativeToolCalls,
      tokensPerSecond,
      promptEvalMs,
      modelLoadMs,
    }
  }

  const stream = async function* (request: ChatRequest, externalSignal?: AbortSignal): AsyncIterable<StreamChunk> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map(m => ({ role: m.role, content: m.content })),
      stream: true,
    }
    // Pass tool definitions for native tool calling in streaming mode
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map(t => t)
      warnIgnoredToolChoice(request.model, request.toolChoice)
    }
    const streamOpts: Record<string, unknown> = {
      num_ctx: request.numCtx ?? DEFAULT_NUM_CTX,
    }
    if (request.temperature !== undefined) streamOpts.temperature = request.temperature
    if (request.seed !== undefined) streamOpts.seed = request.seed
    if (request.maxTokens !== undefined) streamOpts.num_predict = request.maxTokens
    body.options = streamOpts
    if (request.think !== undefined) body.think = request.think

    const controller = new AbortController()
    let idleTimer = setTimeout(() => controller.abort(), STREAM_IDLE_TIMEOUT_MS)

    // Abort on external signal (user cancellation)
    if (externalSignal) {
      externalSignal.addEventListener('abort', () => controller.abort(), { once: true })
    }

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      clearTimeout(idleTimer)
      const text = await response.text()
      throw createOllamaError(response.status, `Ollama stream error ${response.status}: ${text}`)
    }

    const reader = response.body?.getReader()
    if (!reader) {
      clearTimeout(idleTimer)
      throw createOllamaError(0, 'Ollama stream: no response body')
    }

    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        clearTimeout(idleTimer)
        idleTimer = setTimeout(() => controller.abort(), STREAM_IDLE_TIMEOUT_MS)

        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.trim()) continue
          let parsed: { message?: { content?: string; tool_calls?: ReadonlyArray<OllamaToolCall> }; done?: boolean; thinking?: string; prompt_eval_count?: number; eval_count?: number }
          try { parsed = JSON.parse(line) } catch { continue }
          // qwen3 thinking mode: tokens arrive in 'thinking' field before 'content'
          const thinking = (parsed as Record<string, unknown>).thinking as string | undefined
          const delta = parsed.message?.content ?? ''
          const isDone = parsed.done === true
          const toolCalls = isDone && parsed.message?.tool_calls?.length
            ? parsed.message.tool_calls.map(tc => ({ function: { name: tc.function.name, arguments: tc.function.arguments } }))
            : undefined
          const tokensUsed = isDone && (parsed.prompt_eval_count !== undefined || parsed.eval_count !== undefined)
            ? { prompt: parsed.prompt_eval_count ?? 0, completion: parsed.eval_count ?? 0 }
            : undefined
          yield { delta, done: isDone, thinking, ...(toolCalls ? { toolCalls } : {}), ...(tokensUsed ? { tokensUsed } : {}) }
          if (isDone) return
        }
      }
      // Flush any remaining buffer content
      if (buffer.trim()) {
        try {
          const parsed = JSON.parse(buffer) as { message?: { content?: string }; done?: boolean }
          yield { delta: parsed.message?.content ?? '', done: true }
        } catch { /* ignore malformed final chunk */ }
      }
    } finally {
      clearTimeout(idleTimer)
      reader.releaseLock()
    }
  }

  const models = async (): Promise<string[]> => {
    const response = await fetchWithTimeout(
      `${baseUrl}/api/tags`,
      {},
      TAGS_TIMEOUT_MS,
    )

    if (!response.ok) {
      const text = await response.text()
      throw createOllamaError(response.status, `Ollama API error ${response.status}: ${text}`)
    }

    const data = (await response.json()) as OllamaTagsResponse
    return data.models.map(m => m.name)
  }

  const runningModels = async (): Promise<string[]> => {
    const data = await runningModelsDetailed()
    return data.map(m => m.name)
  }

  const runningModelsDetailed = async (): Promise<ReadonlyArray<OllamaPsModel>> => {
    const response = await fetchWithTimeout(
      `${baseUrl}/api/ps`,
      {},
      TAGS_TIMEOUT_MS,
    )

    if (!response.ok) {
      const text = await response.text()
      throw createOllamaError(response.status, `Ollama API error ${response.status}: ${text}`)
    }

    const data = (await response.json()) as OllamaPsResponse
    return data.models
  }

  const loadModel = async (name: string, keepAlive = '30m'): Promise<void> => {
    const response = await fetchWithTimeout(
      `${baseUrl}/api/generate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name, keep_alive: keepAlive }),
      },
      CHAT_TIMEOUT_MS,
    )
    if (!response.ok) {
      const text = await response.text()
      throw createOllamaError(response.status, `Ollama load model error ${response.status}: ${text}`)
    }
    // Consume response body
    await response.text()
  }

  const unloadModel = async (name: string): Promise<void> => {
    const response = await fetchWithTimeout(
      `${baseUrl}/api/generate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name, keep_alive: 0 }),
      },
      TAGS_TIMEOUT_MS,
    )
    if (!response.ok) {
      const text = await response.text()
      throw createOllamaError(response.status, `Ollama unload model error ${response.status}: ${text}`)
    }
    await response.text()
  }

  return {
    chat, stream, models, runningModels, runningModelsDetailed, loadModel, unloadModel,
    get baseUrl() { return baseUrl },
    setBaseUrl: (url: string) => { baseUrl = url },
  }
}
