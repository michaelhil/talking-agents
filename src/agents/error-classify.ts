// Classify a thrown LLM-layer error into a structured AgentResponse error
// code + user-readable message + optional provider hint.
//
// Single source of truth for the agent <-> LLM error mapping. LLMService
// imports `isAgentFallbackable` (a predicate over this classification) so
// the chain-walk logic uses the same mapping the agent's catch block uses.

import type { AgentResponseErrorCode } from '../core/types/agent.ts'
import { isCloudProviderError, isGatewayError, isOllamaError, isPermanent } from '../llm/errors.ts'

export interface ClassifiedLLMError {
  readonly code: AgentResponseErrorCode
  readonly message: string
  readonly providerHint?: string
}

export const classifyLLMError = (err: unknown): ClassifiedLLMError => {
  if (isCloudProviderError(err)) {
    if (err.code === 'auth') return { code: 'no_api_key', message: err.message, providerHint: err.provider }
    if (err.code === 'bad_request') return { code: 'model_unavailable', message: err.message, providerHint: err.provider }
    if (err.code === 'rate_limit' || err.code === 'quota') return { code: 'rate_limited', message: err.message, providerHint: err.provider }
    if (err.code === 'provider_down') return { code: 'provider_down', message: err.message, providerHint: err.provider }
  }
  if (isOllamaError(err) && isPermanent(err)) {
    return { code: 'model_unavailable', message: err.message, providerHint: 'ollama' }
  }
  if (isGatewayError(err)) {
    return { code: 'provider_down', message: err.message }
  }
  if (err instanceof Error && /fetch|network|ECONN|ETIMEDOUT/i.test(err.message)) {
    return { code: 'network', message: err.message }
  }
  return { code: 'unknown', message: err instanceof Error ? err.message : String(err) }
}

// Codes that warrant advancing to the next fallback chain element. Mirrors
// FALLBACKABLE_AGENT_CODES in llm-service.ts but expressed as a derived
// predicate over the classification, not a parallel set.
const FALLBACKABLE_AGENT_CODES: ReadonlySet<AgentResponseErrorCode> = new Set([
  'rate_limited', 'provider_down', 'network', 'model_unavailable',
])

export const isAgentFallbackable = (err: unknown): boolean => {
  // No throw → no failure → trivially "yes" (irrelevant; never reached).
  if (err === undefined || err === null) return true
  return FALLBACKABLE_AGENT_CODES.has(classifyLLMError(err).code)
}
