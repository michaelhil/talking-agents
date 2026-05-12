// System-wide constants. Runtime values, leaf module.

export const SYSTEM_SENDER_ID = 'system' as const

export const DEFAULTS = {
  port: 3000,
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  // Per-agent room-history window (count, not tokens). The token budget
  // (resolveContextTokenBudget in ai-agent.ts) auto-scales to 70% of the
  // model's context window and is the real safety net — for modern
  // models (gpt-5.4 = 1.05M, Claude = 200k, Gemini = 1M+) the 10-message
  // legacy default cut off conversations the agent should remember.
  // Set to 100: the token budget trims further if needed for small-
  // context models. For Ollama with 8k context, ~50 messages typically
  // fit; for gpt-5.4, all 100 plus most of history.
  historyLimit: 100,
} as const
