import type { LLMProvider, ChatRequest, ChatResponse } from '../core/types.ts'

interface OllamaMessage {
  readonly role: string
  readonly content: string
}

interface OllamaChatResponse {
  readonly model: string
  readonly message: OllamaMessage
  readonly done: boolean
  readonly total_duration?: number
  readonly prompt_eval_count?: number
  readonly eval_count?: number
}

interface OllamaTagsResponse {
  readonly models: ReadonlyArray<{ readonly name: string }>
}

interface OllamaPsResponse {
  readonly models: ReadonlyArray<{ readonly name: string; readonly size: number }>
}

const CHAT_TIMEOUT_MS = 300_000 // 5 minutes — large models can be slow
const TAGS_TIMEOUT_MS = 10_000

const fetchWithTimeout = async (
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

const validateChatResponse = (data: unknown): OllamaChatResponse => {
  if (
    typeof data !== 'object' ||
    data === null ||
    !('message' in data) ||
    typeof (data as Record<string, unknown>).message !== 'object'
  ) {
    throw new Error(`Ollama returned unexpected response shape: ${JSON.stringify(data).slice(0, 200)}`)
  }
  const msg = (data as Record<string, unknown>).message as Record<string, unknown>
  if (typeof msg.content !== 'string') {
    throw new Error(`Ollama response missing message.content: ${JSON.stringify(data).slice(0, 200)}`)
  }
  return data as OllamaChatResponse
}

// Strip chat-template tokens that some Ollama models leak into their output.
// This is an Ollama-specific concern — the provider contract is clean text out.
const TEMPLATE_TOKEN_RE = /(<\|[^|>]*\|>|\[INST\]|\[\/INST\]|<<SYS>>|<<\/SYS>>|<\|start_header_id\|>.*?<\|end_header_id\|>)/g

const sanitizeContent = (raw: string): string => {
  let s = raw.replace(TEMPLATE_TOKEN_RE, '')
  // Strip spurious role-label prefix the model sometimes emits before its response
  s = s.replace(/^(assistant|user|system)\s*[:\n]/i, '')
  return s.trim()
}

export const createOllamaProvider = (baseUrl: string): LLMProvider => {
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

    if (request.temperature !== undefined) {
      body.options = { temperature: request.temperature }
    }

    if (request.maxTokens !== undefined) {
      body.options = {
        ...(body.options as Record<string, unknown> | undefined),
        num_predict: request.maxTokens,
      }
    }

    if (request.jsonMode) {
      body.format = 'json'
    }

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
      throw new Error(`Ollama API error ${response.status}: ${text}`)
    }

    const raw = await response.json()
    const data = validateChatResponse(raw)
    const generationMs = Math.round(performance.now() - startMs)

    return {
      content: sanitizeContent(data.message.content),
      generationMs,
      tokensUsed: {
        prompt: data.prompt_eval_count ?? 0,
        completion: data.eval_count ?? 0,
      },
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
      throw new Error(`Ollama API error ${response.status}: ${text}`)
    }

    const data = (await response.json()) as OllamaTagsResponse
    return data.models.map(m => m.name)
  }

  const runningModels = async (): Promise<string[]> => {
    const response = await fetchWithTimeout(
      `${baseUrl}/api/ps`,
      {},
      TAGS_TIMEOUT_MS,
    )

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Ollama API error ${response.status}: ${text}`)
    }

    const data = (await response.json()) as OllamaPsResponse
    return data.models.map(m => m.name)
  }

  return { chat, models, runningModels }
}
