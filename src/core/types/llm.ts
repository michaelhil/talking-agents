// LLM provider interface and call options.

import type { ToolDefinition, NativeToolCall } from './tool.ts'

// === Circuit breaker + gateway observability ===

export type CircuitState = 'closed' | 'open' | 'half_open'

export type RequestStatus = 'success' | 'error' | 'timeout' | 'circuit_open' | 'shed'

export interface RequestRecord {
  readonly model: string
  readonly promptTokens: number
  readonly completionTokens: number
  readonly durationMs: number
  readonly queueWaitMs: number
  readonly tokensPerSecond: number
  readonly status: RequestStatus
  readonly timestamp: number
}

export interface GatewayMetrics {
  readonly requestCount: number
  readonly errorCount: number
  readonly errorRate: number
  readonly p50Latency: number
  readonly p95Latency: number
  readonly avgTokensPerSecond: number
  readonly queueDepth: number
  readonly concurrentRequests: number
  readonly circuitState: CircuitState
  readonly shedCount: number
  readonly windowMs: number
}

export interface LoadedModel {
  readonly name: string
  readonly sizeVram: number
  readonly details?: {
    readonly parameterSize?: string
    readonly quantizationLevel?: string
  }
  readonly expiresAt?: string
}

// Base health surface every provider supports.
export interface ProviderHealth {
  readonly status: 'healthy' | 'degraded' | 'down'
  readonly latencyMs: number
  readonly availableModels: ReadonlyArray<string>
  readonly lastCheckedAt: number
}

// Ollama-specific health extras (models held in VRAM via `ollama ps`).
export interface OllamaHealthExtra {
  readonly loadedModels: ReadonlyArray<LoadedModel>
}

// Combined shape the Ollama gateway returns.
export type OllamaHealth = ProviderHealth & OllamaHealthExtra

export interface ChatRequest {
  readonly model: string
  readonly messages: ReadonlyArray<{
    readonly role: 'system' | 'user' | 'assistant'
    readonly content: string
  }>
  readonly temperature?: number
  // Deterministic seed; best-effort per provider (see AIAgentConfig.seed).
  readonly seed?: number
  readonly maxTokens?: number
  readonly jsonMode?: boolean
  // Treated as deep-frozen across the full request lifecycle (router
  // failover sends the same ChatRequest to multiple providers in sequence).
  // Provider adapters that need to attach wire-format markers
  // (`cache_control` etc.) MUST clone before mutating — see
  // `markLastCacheable` in openai-compatible.ts.
  readonly tools?: ReadonlyArray<ToolDefinition>
  // Force tool-call behaviour for providers that support it (OpenAI Chat
  // Completions family + Ollama on supported models). 'auto' is the default
  // (model decides); 'required' demands at least one tool call; { name }
  // demands a call to that specific tool. Providers that don't support the
  // option silently ignore it (Anthropic + Gemini fall back to 'auto').
  // Used by the script runner's whisper-classify pass (forced JSON-mode).
  readonly toolChoice?: 'auto' | 'required' | { readonly name: string }
  readonly think?: boolean
  readonly numCtx?: number
  // Structured system-prompt blocks — opt-in, used only by providers that can
  // attach cache markers (currently Anthropic). When present, the adapter
  // emits the system message as an array of content parts with
  // `cache_control` on the last cacheable block. Providers that don't
  // understand the structured form fall back to `messages[0].content`.
  readonly systemBlocks?: ReadonlyArray<{ readonly text: string; readonly cacheable?: boolean }>
}

export interface ChatResponse {
  readonly content: string
  readonly generationMs: number
  readonly tokensUsed: {
    readonly prompt: number
    readonly completion: number
    // Anthropic-only: tokens written to / read from the prompt cache. Absent
    // when the provider doesn't expose cache metrics or no cache was used.
    readonly cacheCreation?: number
    readonly cacheRead?: number
  }
  readonly toolCalls?: ReadonlyArray<NativeToolCall>
  readonly tokensPerSecond?: number
  readonly promptEvalMs?: number
  readonly modelLoadMs?: number
  // Resolved after the call, attached by the router layer.
  readonly contextMax?: number
  readonly contextSource?: string
  readonly provider?: string
}

// A single streamed token/delta from the LLM
export interface StreamChunk {
  readonly delta: string   // raw text fragment — may be empty for final done chunk
  readonly done: boolean
  readonly thinking?: string  // qwen3 CoT thinking tokens (before visible response)
  readonly toolCalls?: ReadonlyArray<NativeToolCall>  // native tool calls from final chunk
  // Populated on the final done=true chunk when available (per-provider).
  readonly tokensUsed?: { readonly prompt: number; readonly completion: number }
  // Attached by the router on the final done=true chunk.
  readonly provider?: string
  readonly contextMax?: number
  readonly contextSource?: string
}

export interface LLMProvider {
  readonly chat: (request: ChatRequest) => Promise<ChatResponse>
  readonly stream?: (request: ChatRequest, signal?: AbortSignal) => AsyncIterable<StreamChunk>
  readonly models: () => Promise<string[]>
  readonly runningModels?: () => Promise<string[]>
}

// === Provider routing event callbacks ===
// Emitted by the provider router (src/llm/router.ts) when an agent's LLM
// call is bound to a provider, or when all providers fail. Wired into the
// system via late-binding in main.ts.

export interface ProviderAttempt {
  readonly provider: string
  readonly reason: string
}

export type OnProviderBound = (
  agentId: string | null,
  model: string,
  oldProvider: string | null,
  newProvider: string,
) => void

export type OnProviderAllFailed = (
  agentId: string | null,
  model: string,
  attempts: ReadonlyArray<ProviderAttempt>,
) => void

export type OnProviderStreamFailed = (
  agentId: string | null,
  model: string,
  provider: string,
  reason: string,
) => void

// === Standalone LLM call options ===
// Used by callLLM(), ToolContext.llm, and HouseCallbacks.callSystemLLM.
// No agent lifecycle, no history, no routing, no protocol parsing.
export interface LLMCallOptions {
  readonly model: string
  readonly systemPrompt?: string
  readonly messages: ReadonlyArray<{
    readonly role: 'user' | 'assistant'
    readonly content: string
  }>
  readonly temperature?: number
  readonly jsonMode?: boolean
  // Plumbed from the calling agent so tool-initiated LLM sub-calls inherit
  // the same determinism as the agent's main turn.
  readonly seed?: number
}
