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
  readonly maxTokens?: number
  readonly jsonMode?: boolean
  readonly tools?: ReadonlyArray<ToolDefinition>
  readonly think?: boolean
  readonly numCtx?: number
}

export interface ChatResponse {
  readonly content: string
  readonly generationMs: number
  readonly tokensUsed: {
    readonly prompt: number
    readonly completion: number
  }
  readonly toolCalls?: ReadonlyArray<NativeToolCall>
  readonly tokensPerSecond?: number
  readonly promptEvalMs?: number
  readonly modelLoadMs?: number
}

// A single streamed token/delta from the LLM
export interface StreamChunk {
  readonly delta: string   // raw text fragment — may be empty for final done chunk
  readonly done: boolean
  readonly thinking?: string  // qwen3 CoT thinking tokens (before visible response)
  readonly toolCalls?: ReadonlyArray<NativeToolCall>  // native tool calls from final chunk
}

export interface LLMProvider {
  readonly chat: (request: ChatRequest) => Promise<ChatResponse>
  readonly stream?: (request: ChatRequest, signal?: AbortSignal) => AsyncIterable<StreamChunk>
  readonly models: () => Promise<string[]>
  readonly runningModels?: () => Promise<string[]>
}

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
}
