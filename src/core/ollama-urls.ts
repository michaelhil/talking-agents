// OllamaUrlRegistry — editor for the saved Ollama endpoint list + current
// selection. Only meaningful when Ollama is in the router; the absent-ollama
// factory returns a no-op implementation so the UI dashboard can always
// call list/add/remove/getCurrent/setCurrent without null-checks.

import type { LLMGateway } from '../llm/gateway.ts'

export interface OllamaRawHandle {
  readonly baseUrl: string
  readonly setBaseUrl: (url: string) => void
}

export interface OllamaUrlRegistry {
  readonly list: () => string[]
  readonly add: (url: string) => void
  readonly remove: (url: string) => void
  readonly getCurrent: () => string
  readonly setCurrent: (url: string) => void
}

export const createOllamaUrlRegistry = (
  ollamaRaw: OllamaRawHandle | undefined,
  ollama: LLMGateway | undefined,
): OllamaUrlRegistry => {
  if (!ollamaRaw || !ollama) {
    return {
      list: () => [],
      add: () => {},
      remove: () => {},
      getCurrent: () => '',
      setCurrent: () => {},
    }
  }
  const saved = new Set<string>([ollamaRaw.baseUrl])
  return {
    list: () => [...saved],
    add: (url: string) => { saved.add(url) },
    remove: (url: string) => { saved.delete(url) },
    getCurrent: () => ollamaRaw.baseUrl,
    setCurrent: (url: string) => {
      ollamaRaw.setBaseUrl(url)
      saved.add(url)
      ollama.resetCircuitBreaker()
      ollama.refreshHealth()
    },
  }
}
