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

// Cloud providers known to this build. Adding a new one needs:
//   - entry in PROVIDER_PROFILES
//   - entry in buildProvidersFromConfig in providers-setup.ts
export const PROVIDER_PROFILES = {
  cerebras:   { baseUrl: 'https://api.cerebras.ai/v1',    defaultMaxConcurrent: 2 },
  groq:       { baseUrl: 'https://api.groq.com/openai/v1', defaultMaxConcurrent: 3 },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1',   defaultMaxConcurrent: 1 },
  mistral:    { baseUrl: 'https://api.mistral.ai/v1',      defaultMaxConcurrent: 2 },
  sambanova:  { baseUrl: 'https://api.sambanova.ai/v1',    defaultMaxConcurrent: 2 },
} as const

export type CloudProviderName = keyof typeof PROVIDER_PROFILES

export const DEFAULT_PROVIDER_ORDER: ReadonlyArray<string> =
  ['cerebras', 'groq', 'openrouter', 'mistral', 'sambanova', 'ollama']

export interface CloudProviderConfig {
  readonly apiKey: string
  readonly maxConcurrent: number
}

export interface ProviderConfig {
  readonly ollamaUrl: string
  readonly ollamaMaxConcurrent: number
  readonly cloud: Partial<Record<CloudProviderName, CloudProviderConfig>>
  readonly order: ReadonlyArray<string>
  readonly ollamaOnly: boolean
  readonly forceFailProvider: string | null
  readonly droppedFromOrder: ReadonlyArray<string>  // names in user's order with no config
}

const intEnv = (name: string, fallback: number): number => {
  const v = process.env[name]
  if (!v) return fallback
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export interface ParseOptions {
  readonly env?: Record<string, string | undefined>
}

export const parseProviderConfig = (opts: ParseOptions = {}): ProviderConfig => {
  const env = opts.env ?? process.env
  const getEnv = (k: string): string | undefined => env[k]

  const ollamaOnly = (getEnv('PROVIDER') ?? '').toLowerCase() === 'ollama'
  const ollamaUrl = getEnv('OLLAMA_URL') ?? DEFAULTS.ollamaBaseUrl
  const ollamaMaxConcurrent = intEnv('OLLAMA_MAX_CONCURRENT', 2)
  const forceFailProvider = getEnv('FORCE_PROVIDER_FAIL') ?? null

  // Collect cloud provider configs where an API key is present.
  const cloud: Partial<Record<CloudProviderName, CloudProviderConfig>> = {}
  if (!ollamaOnly) {
    for (const name of Object.keys(PROVIDER_PROFILES) as CloudProviderName[]) {
      const keyEnv = `${name.toUpperCase()}_API_KEY`
      const apiKey = getEnv(keyEnv)
      if (!apiKey) continue
      const maxConcurrentEnv = `${name.toUpperCase()}_MAX_CONCURRENT`
      const maxConcurrent = intEnv(maxConcurrentEnv, PROVIDER_PROFILES[name].defaultMaxConcurrent)
      cloud[name] = { apiKey, maxConcurrent }
    }
  }

  // Resolve order. Ollama is always a candidate (when URL is set — which it is
  // by default). User override via PROVIDER_ORDER; otherwise use default order.
  // If ollamaOnly, order is just ['ollama'].
  let order: ReadonlyArray<string>
  const droppedFromOrder: string[] = []
  if (ollamaOnly) {
    order = ['ollama']
  } else {
    const requested = getEnv('PROVIDER_ORDER')
    const raw = requested
      ? requested.split(',').map(s => s.trim()).filter(Boolean)
      : [...DEFAULT_PROVIDER_ORDER]
    // Filter to only configured providers; track drops so the caller can log.
    const configured = new Set<string>(['ollama', ...Object.keys(cloud)])
    order = raw.filter(name => {
      if (configured.has(name)) return true
      droppedFromOrder.push(name)
      return false
    })
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
        lines.push(`  ${name.padEnd(11)} maxConcurrent=${cc.maxConcurrent}`)
      }
    }
  }
  if (config.droppedFromOrder.length > 0) {
    lines.push(`Dropped from PROVIDER_ORDER (missing API key): ${config.droppedFromOrder.join(', ')}`)
  }
  if (config.forceFailProvider) {
    lines.push(`FORCE_PROVIDER_FAIL=${config.forceFailProvider} (test hook active)`)
  }
  return lines.join('\n')
}
