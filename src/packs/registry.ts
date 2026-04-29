// ============================================================================
// Pack registry resolver — discovers available packs on GitHub so the UI
// can show a browsable list (alongside what's installed).
//
// Sources merge:
//   - SAMSINN_PACK_SOURCES env (comma-separated; deploy-time, wins)
//   - $SAMSINN_HOME/discovery-sources.json's `packs` array (UI-managed)
//   - canonical fallback `samsinn-packs` (real, operational org)
//
// Failure plumbing: getAvailablePacks returns `{ items, failures }`. The
// 5-min cache stores SUCCESS only — empty-with-failure is NOT cached so a
// user setting a token after a rate-limit hit gets unblocked on next call.
// (Same shape as the wiki boot-cache antipattern fixed in commit b660b3e —
// caching derived state when the input is about to change.)
// ============================================================================

import { stripPackPrefix } from './manifest.ts'
import { mergeSources } from '../core/discovery-sources.ts'
import {
  discoverFromGitHub,
  type DiscoveryResult,
  type FetchFn,
  type GHRepo,
} from '../core/github-discovery.ts'

const PREFIX = 'samsinn-pack-'
const CACHE_TTL_MS = 5 * 60_000
const FALLBACK_SOURCES = ['samsinn-packs'] as const

export type { DiscoveryFailure } from '../core/github-discovery.ts'

export interface RegistryPack {
  readonly name: string         // canonical install namespace (stripped repo basename)
  readonly repoName: string     // unstripped GitHub repo name (for display + diagnostics)
  readonly source: string       // "owner/repo"
  readonly repoUrl: string      // https URL
  readonly description: string
}

export type PackDiscoveryResult = DiscoveryResult<RegistryPack>

interface CacheEntry {
  readonly fetchedAt: number
  readonly result: PackDiscoveryResult
}

let cache: CacheEntry | null = null

const resolveSources = (stored: ReadonlyArray<string>): ReadonlyArray<string> =>
  mergeSources(process.env.SAMSINN_PACK_SOURCES, stored, [...FALLBACK_SOURCES])

// Token: SAMSINN_PACK_REGISTRY_TOKEN (broad public read scope).
// SAMSINN_GH_TOKEN is intentionally NOT used here — it's a fine-grained PAT
// scoped to the bug-report repo and 403s elsewhere.
const resolveToken = (stored?: string): string =>
  process.env.SAMSINN_PACK_REGISTRY_TOKEN ?? stored ?? ''

const isPackOnlyOwner = (owner: string): boolean =>
  /-packs$/.test(owner) || owner === 'samsinn-packs'

const repoToPack = (r: GHRepo): RegistryPack => ({
  name: stripPackPrefix(r.name),
  repoName: r.name,
  source: r.full_name,
  repoUrl: r.html_url,
  description: r.description ?? '',
})

export interface GetAvailablePacksOptions {
  readonly storedSources?: ReadonlyArray<string>
  readonly storedToken?: string
  readonly fetchFn?: FetchFn
}

export const getAvailablePacks = async (
  options: GetAvailablePacksOptions = {},
): Promise<PackDiscoveryResult> => {
  const now = Date.now()
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache.result

  const sources = resolveSources(options.storedSources ?? [])
  const result = await discoverFromGitHub<RegistryPack>({
    sources,
    ownerOnlyPolicy: isPackOnlyOwner,
    repoFilter: (r) => r.name.startsWith(PREFIX),
    repoToItem: (r) => repoToPack(r),
    dedupeKey: (p) => p.source,
    token: resolveToken(options.storedToken),
    tokenEnvVar: 'SAMSINN_PACK_REGISTRY_TOKEN',
    userAgent: 'samsinn-pack-registry',
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
  })
  // Don't cache empty-with-failure — token may be set seconds from now and we
  // want the next call to retry immediately, not after CACHE_TTL_MS.
  if (result.items.length > 0 || result.failures.length === 0) {
    cache = { fetchedAt: now, result }
  }
  return result
}

// Test/debug helper — clears the in-memory cache so the next call refetches.
export const invalidateRegistryCache = (): void => { cache = null }
