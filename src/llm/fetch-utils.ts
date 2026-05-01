// Shared HTTP fetch helpers used by every LLM provider adapter.
// Single AbortController-based timeout — both ollama.ts and
// openai-compatible.ts had byte-identical copies before this extract.

export const fetchWithTimeout = async (
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
