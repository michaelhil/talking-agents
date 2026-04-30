// ============================================================================
// Providers store — persistent, file-backed provider configuration.
//
// Stored at ~/.samsinn/providers.json (mode 0600). Env vars take precedence
// over stored values. This module handles file I/O; merging with env lives
// in mergeWithEnv().
//
// Never logs key values. Never exposes raw keys via any returned string.
// ============================================================================

import { readFile, writeFile, rename, chmod, mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CloudProviderName } from './providers-config.ts'
import { PROVIDER_PROFILES, isLocal } from './providers-config.ts'

export const STORE_VERSION = 1

export interface StoredCloudEntry {
  readonly apiKey?: string          // stored key (may be empty string)
  readonly enabled?: boolean        // default: true when apiKey present (or always for local providers)
  readonly maxConcurrent?: number   // override default in PROVIDER_PROFILES
  readonly pinnedModels?: ReadonlyArray<string>  // user-pinned model IDs
  readonly baseUrl?: string         // local providers (llamacpp): override the profile baseUrl
}

export interface StoredOllamaEntry {
  readonly enabled?: boolean
  readonly maxConcurrent?: number
}

export interface ProvidersFileShape {
  readonly version: number
  readonly providers: {
    readonly ollama?: StoredOllamaEntry
  } & Partial<Record<CloudProviderName, StoredCloudEntry>>
  // User-chosen router fallback order. When present, overrides
  // DEFAULT_PROVIDER_ORDER but is itself overridden by env PROVIDER_ORDER.
  // Unknown names ignored on load; missing names appended in default position.
  readonly order?: ReadonlyArray<string>
}

const EMPTY: ProvidersFileShape = { version: STORE_VERSION, providers: {} }

// === Load ===

export interface LoadResult {
  readonly data: ProvidersFileShape
  readonly warnings: ReadonlyArray<string>
}

export const loadProviderStore = async (path: string): Promise<LoadResult> => {
  const warnings: string[] = []
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (err) {
    // Missing file is fine — return empty.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { data: EMPTY, warnings }
    warnings.push(`providers.json read failed: ${(err as Error).message}`)
    return { data: EMPTY, warnings }
  }

  // Warn if file mode is wider than 0600 (group or world readable).
  try {
    const s = await stat(path)
    // Mask off type bits; keep permission bits.
    const mode = s.mode & 0o777
    if (mode & 0o077) {
      warnings.push(`providers.json has permissive mode 0${mode.toString(8)} — recommend 0600 (chmod 600 ${path})`)
    }
  } catch {
    // Stat failure is non-fatal.
  }

  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch (err) {
    warnings.push(`providers.json is not valid JSON: ${(err as Error).message}`)
    return { data: EMPTY, warnings }
  }

  const data = validateShape(parsed, warnings)
  return { data, warnings }
}

const validateShape = (raw: unknown, warnings: string[]): ProvidersFileShape => {
  if (typeof raw !== 'object' || raw === null) {
    warnings.push('providers.json root is not an object — ignoring')
    return EMPTY
  }
  const r = raw as Record<string, unknown>
  const version = typeof r.version === 'number' ? r.version : 0
  if (version !== STORE_VERSION) {
    warnings.push(`providers.json version ${version} (expected ${STORE_VERSION}) — migration may be required`)
  }
  const providers = typeof r.providers === 'object' && r.providers !== null
    ? r.providers as Record<string, Record<string, unknown>>
    : {}

  const cleaned: Record<string, StoredCloudEntry | StoredOllamaEntry> = {}
  for (const [name, entry] of Object.entries(providers)) {
    if (typeof entry !== 'object' || entry === null) continue
    const out: StoredCloudEntry = {}
    if (typeof entry.apiKey === 'string') (out as { apiKey?: string }).apiKey = entry.apiKey
    if (typeof entry.enabled === 'boolean') (out as { enabled?: boolean }).enabled = entry.enabled
    if (typeof entry.maxConcurrent === 'number' && entry.maxConcurrent > 0) {
      (out as { maxConcurrent?: number }).maxConcurrent = entry.maxConcurrent
    }
    if (Array.isArray(entry.pinnedModels)) {
      const pins = (entry.pinnedModels as unknown[]).filter((v): v is string => typeof v === 'string' && v.length > 0)
      if (pins.length > 0) (out as { pinnedModels?: ReadonlyArray<string> }).pinnedModels = pins
    }
    // Local providers (llamacpp): persisted baseUrl override.
    if (typeof entry.baseUrl === 'string' && entry.baseUrl.trim().length > 0) {
      (out as { baseUrl?: string }).baseUrl = entry.baseUrl.trim()
    }
    cleaned[name] = out
  }

  // Optional stored router order — strip non-string entries silently.
  let order: ReadonlyArray<string> | undefined
  if (Array.isArray(r.order)) {
    order = (r.order as unknown[]).filter((v): v is string => typeof v === 'string' && v.length > 0)
    if (order.length === 0) order = undefined
  }

  return {
    version: STORE_VERSION,
    providers: cleaned as ProvidersFileShape['providers'],
    ...(order ? { order } : {}),
  }
}

// === Save — atomic write with 0600 ===

export const saveProviderStore = async (path: string, data: ProvidersFileShape): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  const tmpPath = `${path}.tmp`
  await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
  try { await chmod(tmpPath, 0o600) } catch { /* best-effort */ }
  await rename(tmpPath, path)
}

// === Merge with env ===

export interface MergedProviderEntry {
  readonly apiKey: string                       // '' if none
  readonly source: 'env' | 'stored' | 'none'
  readonly enabled: boolean
  readonly maxConcurrent: number | undefined    // undefined → use default from PROVIDER_PROFILES
  readonly maskedKey: string                    // safe for UI / logs
  readonly pinnedModels: ReadonlyArray<string>  // [] when none
  readonly baseUrl: string | undefined          // local providers: override of profile baseUrl
}

export interface MergedProviders {
  readonly cloud: Partial<Record<CloudProviderName, MergedProviderEntry>>
  readonly ollama: { readonly enabled: boolean; readonly maxConcurrent: number | undefined }
  // Stored router-order preference (unchanged from the file; env still wins).
  readonly order?: ReadonlyArray<string>
}

export const maskKey = (key: string): string => {
  if (!key) return ''
  if (key.length <= 4) return '•'.repeat(key.length)
  return `•••${key.slice(-4)}`
}

export interface MergeOptions {
  readonly env?: Record<string, string | undefined>
}

export const mergeWithEnv = (
  store: ProvidersFileShape,
  opts: MergeOptions = {},
): MergedProviders => {
  const env = opts.env ?? process.env
  const cloud: Partial<Record<CloudProviderName, MergedProviderEntry>> = {}

  for (const name of Object.keys(PROVIDER_PROFILES) as CloudProviderName[]) {
    const stored = (store.providers as Record<string, StoredCloudEntry | undefined>)[name]
    const envKey = env[`${name.toUpperCase()}_API_KEY`]?.trim()
    const storedKey = stored?.apiKey?.trim() ?? ''

    let apiKey = ''
    let source: MergedProviderEntry['source'] = 'none'
    if (envKey) { apiKey = envKey; source = 'env' }
    else if (storedKey) { apiKey = storedKey; source = 'stored' }

    // Enabled defaults: true when a key is set (via any source). Local
    // providers (llamacpp) default to enabled even without a key — they
    // don't need one.
    const enabled = stored?.enabled ?? (isLocal(name) || apiKey !== '')

    // maxConcurrent precedence: env > stored > undefined (fall through to default).
    const envMc = env[`${name.toUpperCase()}_MAX_CONCURRENT`]
    const envMcNum = envMc ? Number.parseInt(envMc, 10) : undefined
    const maxConcurrent = Number.isFinite(envMcNum) && (envMcNum as number) > 0
      ? envMcNum
      : stored?.maxConcurrent

    // baseUrl: env var first, then stored, else undefined (consumer falls
    // through to PROVIDER_PROFILES default). Only meaningful for local
    // providers; cloud baseUrls are fixed.
    const envBaseUrl = env[`${name.toUpperCase()}_BASE_URL`]?.trim()
    const baseUrl = (envBaseUrl && envBaseUrl.length > 0)
      ? envBaseUrl
      : (stored?.baseUrl?.trim() || undefined)

    cloud[name] = {
      apiKey, source, enabled, maxConcurrent,
      maskedKey: maskKey(apiKey),
      pinnedModels: stored?.pinnedModels ?? [],
      baseUrl,
    }
  }

  const ollamaStored = store.providers.ollama
  const ollamaEnabledEnv = env.PROVIDER?.toLowerCase() === 'ollama'
    ? true
    : undefined
  const envOllamaMc = env.OLLAMA_MAX_CONCURRENT
  const envOllamaMcNum = envOllamaMc ? Number.parseInt(envOllamaMc, 10) : undefined
  const ollama = {
    enabled: ollamaEnabledEnv ?? ollamaStored?.enabled ?? true,
    maxConcurrent: Number.isFinite(envOllamaMcNum) && (envOllamaMcNum as number) > 0
      ? envOllamaMcNum
      : ollamaStored?.maxConcurrent,
  }

  return { cloud, ollama, ...(store.order ? { order: store.order } : {}) }
}
