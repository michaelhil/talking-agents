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
//
// `kind` distinguishes "needs an API key" (cloud) from "self-hosted, no key
// required by default" (local). Both ollama (handled separately, has its own
// transport) and llamacpp (uses the OpenAI-compat transport) are local.
// isLocal() below is the predicate to use at every site that asks
// "does this provider need a key".
export const PROVIDER_PROFILES = {
  anthropic:  { baseUrl: 'https://api.anthropic.com/v1',                          defaultMaxConcurrent: 3, kind: 'cloud' },
  gemini:     { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultMaxConcurrent: 3, kind: 'cloud' },
  cerebras:   { baseUrl: 'https://api.cerebras.ai/v1',                            defaultMaxConcurrent: 2, kind: 'cloud' },
  groq:       { baseUrl: 'https://api.groq.com/openai/v1',                        defaultMaxConcurrent: 3, kind: 'cloud' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1',                          defaultMaxConcurrent: 1, kind: 'cloud' },
  mistral:    { baseUrl: 'https://api.mistral.ai/v1',                             defaultMaxConcurrent: 2, kind: 'cloud' },
  sambanova:  { baseUrl: 'https://api.sambanova.ai/v1',                           defaultMaxConcurrent: 2, kind: 'cloud' },
  llamacpp:   { baseUrl: 'http://localhost:8080',                                  defaultMaxConcurrent: 1, kind: 'local' },
} as const

export type CloudProviderName = keyof typeof PROVIDER_PROFILES

// True for any provider that doesn't require an API key. ollama is handled
// outside PROVIDER_PROFILES (its own transport), so it's checked by name;
// everything else falls back to the kind flag.
export const isLocal = (name: string): boolean => {
  if (name === 'ollama') return true
  const profile = (PROVIDER_PROFILES as Record<string, { kind: string } | undefined>)[name]
  return profile?.kind === 'local'
}

export const DEFAULT_PROVIDER_ORDER: ReadonlyArray<string> =
  ['anthropic', 'gemini', 'cerebras', 'groq', 'openrouter', 'mistral', 'sambanova', 'llamacpp', 'ollama']

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
  // Per-provider baseUrl override (env or store). For local providers the
  // baseUrl is configurable; for cloud providers it stays at the profile
  // default. Looked up at request time via the OAI-compat adapter's getter.
  readonly baseUrls: Partial<Record<CloudProviderName, string>>
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

// When `opts.fileStore` is supplied, env-vs-stored precedence for cloud-
// provider keys / maxConcurrent / baseUrl has already been resolved by
// mergeWithEnv (providers-store.ts). This function therefore does NOT
// re-read those env vars in that path — it consumes the merged result. Only
// bootstrap-only env vars (`PROVIDER`, `PROVIDER_ORDER`, `OLLAMA_URL`,
// `FORCE_PROVIDER_FAIL`) — which are not represented in MergedProviders —
// are still read here directly.
export const parseProviderConfig = (opts: ParseOptions = {}): ProviderConfig => {
  const env = opts.env ?? process.env
  const getEnv = (k: string): string | undefined => env[k]

  const ollamaOnly = (getEnv('PROVIDER') ?? '').toLowerCase() === 'ollama'
  const ollamaUrl = getEnv('OLLAMA_URL') ?? DEFAULTS.ollamaBaseUrl
  // OLLAMA_MAX_CONCURRENT: when fileStore is given, mergeWithEnv has already
  // applied env-over-stored precedence; trust the merged value. Otherwise
  // fall through to direct env read.
  const ollamaMaxConcurrent = opts.fileStore
    ? (opts.fileStore.ollama.maxConcurrent ?? 2)
    : intEnv('OLLAMA_MAX_CONCURRENT', 2)
  const forceFailProvider = getEnv('FORCE_PROVIDER_FAIL') ?? null

  // Collect cloud provider configs.
  //   - With fileStore: derive entirely from MergedProviders (env precedence
  //     already applied upstream).
  //   - Without fileStore: env-only fallback for tests / edge cases.
  const cloud: Partial<Record<CloudProviderName, CloudProviderConfigWithSource>> = {}
  if (!ollamaOnly) {
    if (opts.fileStore) {
      for (const name of Object.keys(PROVIDER_PROFILES) as CloudProviderName[]) {
        const merged = opts.fileStore.cloud[name]
        if (!merged) continue
        // Cloud providers need a key. Local providers (llamacpp) register
        // without one — llama-server accepts requests without auth by default.
        if (!merged.apiKey && !isLocal(name)) continue
        if (!merged.enabled) continue
        const maxConcurrent = merged.maxConcurrent
          ?? PROVIDER_PROFILES[name].defaultMaxConcurrent
        // MergedProviderEntry.source is 'env' | 'stored' | 'none'; the
        // CloudProviderConfigWithSource shape uses only 'env' | 'stored'.
        // A keyless local provider lands here with source='none' — map to
        // 'stored' by convention (matches prior behavior).
        const source: 'env' | 'stored' = merged.source === 'env' ? 'env' : 'stored'
        cloud[name] = { apiKey: merged.apiKey, maxConcurrent, source, enabled: true }
      }
    } else {
      for (const name of Object.keys(PROVIDER_PROFILES) as CloudProviderName[]) {
        const envKey = getEnv(`${name.toUpperCase()}_API_KEY`)?.trim()
        const apiKey = envKey && envKey.length > 0 ? envKey : ''
        if (!apiKey && !isLocal(name)) continue
        const maxConcurrent = intEnv(`${name.toUpperCase()}_MAX_CONCURRENT`, PROVIDER_PROFILES[name].defaultMaxConcurrent)
        cloud[name] = { apiKey, maxConcurrent, source: apiKey ? 'env' : 'stored', enabled: true }
      }
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
  // Per-provider baseUrl overrides. Only local providers use this — cloud
  // baseUrls are fixed in PROVIDER_PROFILES. With fileStore, env-vs-stored
  // precedence is already resolved on the merged entry; without fileStore,
  // fall back to direct env read.
  const baseUrls: Partial<Record<CloudProviderName, string>> = {}
  for (const name of Object.keys(PROVIDER_PROFILES) as CloudProviderName[]) {
    if (!isLocal(name)) continue
    if (opts.fileStore) {
      const url = opts.fileStore.cloud[name]?.baseUrl
      if (url) baseUrls[name] = url
    } else {
      const envUrl = getEnv(`${name.toUpperCase()}_BASE_URL`)?.trim()
      if (envUrl) baseUrls[name] = envUrl
    }
  }

  return {
    ollamaUrl,
    ollamaMaxConcurrent,
    cloud,
    baseUrls,
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
      const url = config.baseUrls[name as CloudProviderName]
        ?? PROVIDER_PROFILES[name as CloudProviderName]?.baseUrl
      if (cc) {
        if (isLocal(name)) {
          lines.push(`  ${name.padEnd(11)} ${url} (maxConcurrent=${cc.maxConcurrent})`)
        } else {
          lines.push(`  ${name.padEnd(11)} source=${cc.source} maxConcurrent=${cc.maxConcurrent}`)
        }
      } else {
        if (isLocal(name)) {
          lines.push(`  ${name.padEnd(11)} ${url} (disabled)`)
        } else {
          lines.push(`  ${name.padEnd(11)} (no key — add via UI to activate)`)
        }
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
