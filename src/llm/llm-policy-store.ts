// ============================================================================
// LLM policy store — persistent, file-backed cross-provider LLM behavior.
//
// Stored at ~/.samsinn/llm-policy.json (mode 0600). Distinct from
// providers.json (which holds keys + per-provider config) because this
// holds CROSS-PROVIDER policy: the system default fallback chain.
//
// Why a separate file: providers.json is "what credentials/settings does
// each provider have"; llm-policy.json is "what does the system do across
// providers when one fails". Mixing them means the schema for providers.json
// drifts every time a new policy lands. Separate concerns, separate files.
//
// Read at request time (not boot) so UI edits take effect without restart.
// Atomic write (tmp → rename) so a crash mid-save can't leave a torn file.
//
// Deferred consolidation: this file currently holds a single field
// (modelFallback). Trigger to fold into providers-store.ts: a second
// cross-provider policy field arrives, OR by 2026-08-01, whichever first.
// ============================================================================

import { readFile, writeFile, rename, chmod, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export const POLICY_VERSION = 1

export interface LLMPolicyFileShape {
  readonly version: number
  readonly defaults?: {
    // Comma-separated list of model refs to try when a primary call fails.
    // Provider-prefixed strings (e.g. "openai:gpt-4o-mini") work the same as
    // bare names. Order is priority — first element tried first.
    readonly modelFallback?: ReadonlyArray<string>
  }
}

const DEFAULT_FILE: LLMPolicyFileShape = { version: POLICY_VERSION }

export interface PolicyLoadResult {
  readonly data: LLMPolicyFileShape
  readonly warnings: ReadonlyArray<string>
}

export const loadPolicy = async (path: string): Promise<PolicyLoadResult> => {
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { data: DEFAULT_FILE, warnings: [] }
    }
    return { data: DEFAULT_FILE, warnings: [`failed to read ${path}: ${err instanceof Error ? err.message : err}`] }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { data: DEFAULT_FILE, warnings: [`malformed JSON in ${path}: ${err instanceof Error ? err.message : err}`] }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { data: DEFAULT_FILE, warnings: [`${path}: top-level is not an object`] }
  }
  const obj = parsed as Record<string, unknown>
  if (obj.version !== POLICY_VERSION) {
    return { data: DEFAULT_FILE, warnings: [`${path}: version ${obj.version} is not supported (expected ${POLICY_VERSION})`] }
  }
  const warnings: string[] = []
  const defaults = obj.defaults && typeof obj.defaults === 'object' ? obj.defaults as Record<string, unknown> : undefined
  let modelFallback: ReadonlyArray<string> | undefined
  if (defaults && Array.isArray(defaults.modelFallback)) {
    const items = defaults.modelFallback.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map(s => s.trim())
    if (items.length > 0) modelFallback = items
    else if (defaults.modelFallback.length > 0) warnings.push(`${path}: defaults.modelFallback contained no valid entries`)
  } else if (defaults && defaults.modelFallback !== undefined) {
    warnings.push(`${path}: defaults.modelFallback must be an array of strings`)
  }
  const data: LLMPolicyFileShape = {
    version: POLICY_VERSION,
    ...(modelFallback ? { defaults: { modelFallback } } : {}),
  }
  return { data, warnings }
}

export const savePolicy = async (path: string, data: LLMPolicyFileShape): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  await chmod(tmp, 0o600).catch(() => { /* best-effort on filesystems that don't support chmod */ })
  await rename(tmp, path)
}

// === In-memory store with file persistence ===
// Live store used by main.ts. The LLMService consults `getModelFallback`
// at request time so UI edits propagate without a restart.

export interface PolicyStore {
  readonly getModelFallback: () => ReadonlyArray<string> | undefined
  readonly setModelFallback: (chain: ReadonlyArray<string> | undefined) => Promise<void>
  readonly getRaw: () => LLMPolicyFileShape
}

export interface PolicyStoreInit {
  readonly path: string
  // Optional env override applied on first load when the file is missing
  // OR has no chain set. Read once at boot from SAMSINN_DEFAULT_MODEL_FALLBACK.
  readonly envChain?: ReadonlyArray<string>
}

export const createPolicyStore = async (init: PolicyStoreInit): Promise<{ store: PolicyStore; warnings: ReadonlyArray<string> }> => {
  const { data, warnings } = await loadPolicy(init.path)
  let current: LLMPolicyFileShape = data

  // Bootstrap from env if file had no chain. Persist so subsequent boots
  // don't need the env. UI edits later will overwrite.
  if (init.envChain && init.envChain.length > 0 && !current.defaults?.modelFallback) {
    current = { version: POLICY_VERSION, defaults: { modelFallback: [...init.envChain] } }
    try {
      await savePolicy(init.path, current)
    } catch (err) {
      // If save fails the in-memory chain still applies for this run.
      console.warn(`[llm-policy] failed to persist env-supplied default chain: ${err instanceof Error ? err.message : err}`)
    }
  }

  const store: PolicyStore = {
    getModelFallback: () => current.defaults?.modelFallback,
    setModelFallback: async (chain) => {
      const next: LLMPolicyFileShape = chain && chain.length > 0
        ? { version: POLICY_VERSION, defaults: { modelFallback: [...chain] } }
        : { version: POLICY_VERSION }
      await savePolicy(init.path, next)
      current = next
    },
    getRaw: () => current,
  }
  return { store, warnings }
}
