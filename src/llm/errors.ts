// Discriminated-union error types for the LLM layer.
// Plain objects (with Error prototype) so stack traces survive, while staying
// in functional style (no ES6 classes).

export type OllamaErrorCode = 'ollama_error'
export type GatewayErrorCode = 'circuit_open' | 'queue_full' | 'queue_timeout' | 'not_supported'
export type CloudErrorCode = 'rate_limit' | 'quota' | 'auth' | 'provider_down' | 'bad_request'

export interface OllamaError extends Error {
  readonly kind: 'ollama_error'
  readonly status: number
}

export interface GatewayError extends Error {
  readonly kind: 'gateway_error'
  readonly code: GatewayErrorCode
}

export interface CloudProviderError extends Error {
  readonly kind: 'cloud_error'
  readonly code: CloudErrorCode
  readonly provider: string
  readonly status?: number
  readonly retryAfterMs?: number
}

export const createOllamaError = (status: number, message: string): OllamaError => {
  const err = new Error(message) as Error & { kind: 'ollama_error'; status: number }
  err.name = 'OllamaError'
  err.kind = 'ollama_error'
  err.status = status
  return err
}

export const createGatewayError = (code: GatewayErrorCode, message: string): GatewayError => {
  const err = new Error(message) as Error & { kind: 'gateway_error'; code: GatewayErrorCode }
  err.name = 'GatewayError'
  err.kind = 'gateway_error'
  err.code = code
  return err
}

export interface CloudProviderErrorInit {
  readonly code: CloudErrorCode
  readonly provider: string
  readonly message: string
  readonly status?: number
  readonly retryAfterMs?: number
}

export const createCloudProviderError = (init: CloudProviderErrorInit): CloudProviderError => {
  const err = new Error(init.message) as Error & {
    kind: 'cloud_error'
    code: CloudErrorCode
    provider: string
    status?: number
    retryAfterMs?: number
  }
  err.name = 'CloudProviderError'
  err.kind = 'cloud_error'
  err.code = init.code
  err.provider = init.provider
  if (init.status !== undefined) err.status = init.status
  if (init.retryAfterMs !== undefined) err.retryAfterMs = init.retryAfterMs
  return err
}

export const isOllamaError = (err: unknown): err is OllamaError =>
  err instanceof Error && (err as { kind?: string }).kind === 'ollama_error'

export const isGatewayError = (err: unknown): err is GatewayError =>
  err instanceof Error && (err as { kind?: string }).kind === 'gateway_error'

export const isCloudProviderError = (err: unknown): err is CloudProviderError =>
  err instanceof Error && (err as { kind?: string }).kind === 'cloud_error'

// 4xx Ollama errors are permanent (model not found, bad request). Don't retry, don't trip circuit breaker.
export const isPermanent = (err: OllamaError): boolean =>
  err.status >= 400 && err.status < 500

// Cloud errors that indicate the provider is unusable for this request but the
// request itself is fine (try next provider): rate_limit, quota, provider_down.
// auth and bad_request are permanent (config problem — propagate, no fallback).
export const isFallbackable = (err: CloudProviderError): boolean =>
  err.code === 'rate_limit' || err.code === 'quota' || err.code === 'provider_down'

// Parse Retry-After header: HTTP spec allows delta-seconds (integer) or HTTP-date.
// Returns ms from now, or undefined if absent/unparseable/already-elapsed.
//
// Returning 0 for past dates would collapse the cooldown — callers use
// `err.retryAfterMs ?? defaultMs` and `0 ?? defaultMs` is `0` (the nullish
// coalesce only triggers on null/undefined). A zero cooldown causes immediate
// re-attempt on the same provider, defeating the failover. Past dates and
// zero deltas therefore map to undefined so the default cooldown applies.
export const parseRetryAfterMs = (header: string | null, now: () => number = Date.now): number | undefined => {
  if (!header) return undefined
  const trimmed = header.trim()
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10)
    if (seconds <= 0) return undefined
    return seconds * 1000
  }
  const dateMs = Date.parse(trimmed)
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - now()
    return delta > 0 ? delta : undefined
  }
  return undefined
}
