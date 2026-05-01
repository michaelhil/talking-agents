// Shared HTTP fetch helpers. Generic — used by LLM provider adapters
// (ollama.ts, openai-compatible.ts) and the web-fetch tools. Lives in
// src/core/ rather than src/llm/ so the tools layer can consume without
// crossing into LLM internals.
// Single AbortController-based timeout — three byte-identical copies
// existed before this consolidation.

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
