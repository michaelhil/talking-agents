// ============================================================================
// Provider configuration — parses environment variables into a typed
// configuration object for the provider router + Ollama gateway.
//
// Env vars:
//   PROVIDER=ollama                       override: single-Ollama mode
//   PROVIDER_ORDER=cerebras,groq,...      explicit router priority order
//   OLLAMA_URL=http://localhost:11434     Ollama endpoint (preserved)
//   CEREBRAS_API_KEY, GROQ_API_KEY,
//   OPENROUTER_API_KEY, MISTRAL_API_KEY,
//   SAMBANOVA_API_KEY                     cloud provider credentials
//   <NAME>_MAX_CONCURRENT                 per-provider concurrency cap
//   FORCE_PROVIDER_FAIL=<name>            test hook — forces provider to fail
// ============================================================================

import { DEFAULTS } from '../core/types/constants.ts'
import type { MergedProviders } from './providers-store.ts'

// Cloud providers known to this build. Adding a new one needs:
//   - entry in PROVIDER_PROFILES
//   - entry in buildProvidersFromConfig in providers-setup.ts
export const PROVIDER_PROFILES = {
  anthropic:  { baseUrl: 'https://api.anthropic.com/v1',                          defaultMaxConcurrent: 3 },
  gemini:     { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultMaxConcurrent: 3 },
  cerebras:   { baseUrl: 'https://api.cerebras.ai/v1',                            defaultMaxConcurrent: 2 },
  groq:       { baseUrl: 'https://api.groq.com/openai/v1',                        defaultMaxConcurrent: 3 },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1',                          defaultMaxConcurrent: 1 },
  mistral:    { baseUrl: 'https://api.mistral.ai/v1',                             defaultMaxConcurrent: 2 },
  sambanova:  { baseUrl: 'https://api.sambanova.ai/v1',                           defaultMaxConcurrent: 2 },
} as const

export type CloudProviderName = keyof typeof PROVIDER_PROFILES

export const DEFAULT_PROVIDER_ORDER: ReadonlyArray<string> =
  ['anthropic', 'gemini', 'cerebras', 'groq', 'openrouter', 'mistral', 'sambanova', 'ollama']

export interface CloudProviderConfig {
  readonly apiKey: string
  readonly maxConcurrent: number
}

export interface CloudProviderConfigWithSource extends CloudProviderConfig {
  readonly source: 'env' | 'stored'
  readonly enabled: boolean
}

export interface ProviderConfig {
  readonly ollamaUrl: string
  readonly ollamaMaxConcurrent: number
  readonly cloud: Partial<Record<CloudProviderName, CloudProviderConfigWithSource>>
  readonly order: ReadonlyArray<string>
  readonly ollamaOnly: boolean
  readonly forceFailProvider: string | null
  readonly droppedFromOrder: ReadonlyArray<string>  // names in order with no config
  readonly orderFromUser: boolean                   // true iff PROVIDER_ORDER was set
}

const intEnv = (name: string, fallback: number): number => {
  const v = process.env[name]
  if (!v) return fallback
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export interface ParseOptions {
  readonly env?: Record<string, string | undefined>
  readonly fileStore?: MergedProviders
}

export const parseProviderConfig = (opts: ParseOptions = {}): ProviderConfig => {
  const env = opts.env ?? process.env
  const getEnv = (k: string): string | undefined => env[k]

  const ollamaOnly = (getEnv('PROVIDER') ?? '').toLowerCase() === 'ollama'
  const ollamaUrl = getEnv('OLLAMA_URL') ?? DEFAULTS.ollamaBaseUrl
  const ollamaMaxConcurrent = opts.fileStore?.ollama.maxConcurrent
    ?? intEnv('OLLAMA_MAX_CONCURRENT', 2)
  const forceFailProvider = getEnv('FORCE_PROVIDER_FAIL') ?? null

  // Collect cloud provider configs. Precedence (handled by mergeWithEnv if a
  // fileStore is supplied): env > stored. Without a fileStore we fall back
  // to env-only — identical to previous behaviour.
  const cloud: Partial<Record<CloudProviderName, CloudProviderConfigWithSource>> = {}
  if (!ollamaOnly) {
    for (const name of Object.keys(PROVIDER_PROFILES) as CloudProviderName[]) {
      const merged = opts.fileStore?.cloud[name]
      const envKey = getEnv(`${name.toUpperCase()}_API_KEY`)?.trim()
      const apiKey = envKey && envKey.length > 0 ? envKey : (merged?.apiKey ?? '')
      if (!apiKey) continue
      const source: 'env' | 'stored' = envKey && envKey.length > 0 ? 'env' : 'stored'

      // Enabled: env-sourced keys default to enabled; stored keys honour the
      // stored enabled flag (default true if missing).
      const enabled = source === 'env' ? true : (merged?.enabled ?? true)
      if (!enabled) continue

      const maxConcurrent = merged?.maxConcurrent
        ?? intEnv(`${name.toUpperCase()}_MAX_CONCURRENT`, PROVIDER_PROFILES[name].defaultMaxConcurrent)
      cloud[name] = { apiKey, maxConcurrent, source, enabled }
    }
  }

  // Resolve order. Ollama is always a candidate (when URL is set — which it is
  // by default). User override via PROVIDER_ORDER; otherwise use default order.
  // If ollamaOnly, order is just ['ollama'].
  let order: ReadonlyArray<string>
  let orderFromUser = false
  const droppedFromOrder: string[] = []
  if (ollamaOnly) {
    order = ['ollama']
  } else {
    const requested = getEnv('PROVIDER_ORDER')
    orderFromUser = !!requested
    // Precedence: env PROVIDER_ORDER > stored order (opts.fileStore.order) >
    // DEFAULT_PROVIDER_ORDER. Unknown names dropped; known names not present
    // are appended in default-order position (forward-compat when new
    // providers ship between stored-order writes).
    const baseRaw = requested
      ? requested.split(',').map(s => s.trim()).filter(Boolean)
      : (opts.fileStore?.order && opts.fileStore.order.length > 0
          ? [...opts.fileStore.order]
          : [...DEFAULT_PROVIDER_ORDER])
    const known = new Set<string>(['ollama', ...Object.keys(PROVIDER_PROFILES)])
    const filtered = baseRaw.filter(name => {
      if (known.has(name)) return true
      droppedFromOrder.push(name)
      return false
    })
    const present = new Set(filtered)
    const missing = [...DEFAULT_PROVIDER_ORDER].filter(n => known.has(n) && !present.has(n))
    order = [...filtered, ...missing]
    if (order.length === 0) {
      // Fallback safety: always at least Ollama.
      order = ['ollama']
    }
  }
  return {
    ollamaUrl,
    ollamaMaxConcurrent,
    cloud,
    order,
    ollamaOnly,
    forceFailProvider,
    droppedFromOrder,
    orderFromUser,
  }
}

// Summarise the configuration for the startup log. One line per provider,
// plus a note for dropped names.
export const summariseProviderConfig = (config: ProviderConfig): string => {
  const lines: string[] = []
  if (config.ollamaOnly) {
    lines.push(`PROVIDER=ollama (cloud providers disabled)`)
  }
  lines.push(`Router order: ${config.order.join(' → ')}`)
  for (const name of config.order) {
    if (name === 'ollama') {
      lines.push(`  ollama:     ${config.ollamaUrl} (maxConcurrent=${config.ollamaMaxConcurrent})`)
    } else {
      const cc = config.cloud[name as CloudProviderName]
      if (cc) {
        lines.push(`  ${name.padEnd(11)} source=${cc.source} maxConcurrent=${cc.maxConcurrent}`)
      } else {
        lines.push(`  ${name.padEnd(11)} (no key — add via UI to activate)`)
      }
    }
  }
  if (config.droppedFromOrder.length > 0) {
    lines.push(`Unknown provider names in PROVIDER_ORDER: ${config.droppedFromOrder.join(', ')}`)
  }
  if (config.forceFailProvider) {
    lines.push(`FORCE_PROVIDER_FAIL=${config.forceFailProvider} (test hook active)`)
  }
  return lines.join('\n')
}
