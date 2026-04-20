// System-wide constants. Runtime values, leaf module.

export const SYSTEM_SENDER_ID = 'system' as const

export const DEFAULTS = {
  port: 3000,
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  historyLimit: 10,
} as const
