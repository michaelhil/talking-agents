// ============================================================================
// GitHub tokens store — file-backed registry tokens for pack + wiki discovery.
// Mirrors src/llm/providers-store.ts: file mode 0600, env-wins merge, masked
// display. Two slots:
//   - packRegistry → SAMSINN_PACK_REGISTRY_TOKEN
//   - wikiRegistry → SAMSINN_WIKI_REGISTRY_TOKEN
//
// Distinct from SAMSINN_GH_TOKEN (the bug-report PAT, fine-grained to a
// single repo and 403s elsewhere). These need broad public read scope.
//
// Keys never leave the server in plaintext — endpoints return only
// `{ hasKey, source, maskedKey }`.
// ============================================================================

import { readFile, writeFile, rename, chmod, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export const STORE_VERSION = 1

export type TokenSlot = 'packRegistry' | 'wikiRegistry'

export interface StoredTokenEntry {
  readonly apiKey?: string
}

export interface GithubTokensFileShape {
  readonly version: number
  readonly tokens: Partial<Record<TokenSlot, StoredTokenEntry>>
}

const EMPTY: GithubTokensFileShape = { version: STORE_VERSION, tokens: {} }

const ENV_BY_SLOT: Record<TokenSlot, string> = {
  packRegistry: 'SAMSINN_PACK_REGISTRY_TOKEN',
  wikiRegistry: 'SAMSINN_WIKI_REGISTRY_TOKEN',
}

export const envVarFor = (slot: TokenSlot): string => ENV_BY_SLOT[slot]

export const loadGithubTokens = async (path: string): Promise<GithubTokensFileShape> => {
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY
    return EMPTY
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return EMPTY }
  const obj = parsed as Record<string, unknown>
  const t = (obj.tokens as Record<string, unknown> | undefined) ?? {}
  const out: Partial<Record<TokenSlot, StoredTokenEntry>> = {}
  for (const slot of ['packRegistry', 'wikiRegistry'] as const) {
    const entry = t[slot] as Record<string, unknown> | undefined
    if (entry && typeof entry.apiKey === 'string' && entry.apiKey.length > 0) {
      out[slot] = { apiKey: entry.apiKey }
    }
  }
  return { version: STORE_VERSION, tokens: out }
}

export const saveGithubTokens = async (
  path: string,
  data: GithubTokensFileShape,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  const tmpPath = `${path}.tmp`
  await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
  try { await chmod(tmpPath, 0o600) } catch { /* best-effort */ }
  await rename(tmpPath, path)
}

export const maskKey = (key: string): string => {
  if (!key) return ''
  if (key.length <= 4) return '•'.repeat(key.length)
  return `•••${key.slice(-4)}`
}

export interface MergedTokenEntry {
  readonly apiKey: string                      // '' if none — never logged
  readonly source: 'env' | 'stored' | 'none'
  readonly maskedKey: string                   // safe for UI / logs
}

export interface MergedGithubTokens {
  readonly packRegistry: MergedTokenEntry
  readonly wikiRegistry: MergedTokenEntry
}

const mergeOne = (slot: TokenSlot, stored: StoredTokenEntry | undefined): MergedTokenEntry => {
  const envValue = process.env[ENV_BY_SLOT[slot]]?.trim() ?? ''
  if (envValue.length > 0) return { apiKey: envValue, source: 'env', maskedKey: maskKey(envValue) }
  const storedValue = stored?.apiKey?.trim() ?? ''
  if (storedValue.length > 0) return { apiKey: storedValue, source: 'stored', maskedKey: maskKey(storedValue) }
  return { apiKey: '', source: 'none', maskedKey: '' }
}

export const mergeWithEnv = (data: GithubTokensFileShape): MergedGithubTokens => ({
  packRegistry: mergeOne('packRegistry', data.tokens.packRegistry),
  wikiRegistry: mergeOne('wikiRegistry', data.tokens.wikiRegistry),
})
