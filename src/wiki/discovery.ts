// ============================================================================
// Wiki discovery — finds available wikis on GitHub so prod (and any new
// instance) can pick them up without per-machine wikis.json edits.
//
// Sources merge: SAMSINN_WIKI_SOURCES env + UI-managed discovery-sources.json
// + canonical fallback `samsinn-wikis` (real org). Failure plumbing identical
// to packs/registry — see comment there.
//
// Convention:
//   - Owner ending in `-wikis` → every non-archived/non-fork repo is a wiki.
//   - Other owners → repo basename must start with `samsinn-wiki-`.
//
// Token: SAMSINN_WIKI_REGISTRY_TOKEN (broad public read scope; separate from
// SAMSINN_GH_TOKEN for the same reason as packs).
//
// The result is ephemeral: discovered wikis are merged with the on-disk store
// at runtime via store.ts:mergeWithDiscovery. Discovery NEVER writes to
// wikis.json. Operator-managed entries (PATs, manual disable, displayName
// overrides) win on id collision.
// ============================================================================

import { isValidWikiId } from './store.ts'
import { mergeSources } from '../core/discovery-sources.ts'
import {
  discoverFromGitHub,
  type DiscoveryResult,
  type FetchFn,
  type GHRepo,
} from '../core/github-discovery.ts'

const PREFIX = 'samsinn-wiki-'
const CACHE_TTL_MS = 5 * 60_000
const FALLBACK_SOURCES = ['samsinn-wikis'] as const

export type { DiscoveryFailure } from '../core/github-discovery.ts'

export interface DiscoveredWiki {
  readonly id: string
  readonly owner: string
  readonly repo: string
  readonly displayName: string
  readonly description: string
  readonly repoUrl: string
  readonly source: string
}

export type WikiDiscoveryResult = DiscoveryResult<DiscoveredWiki>

interface CacheEntry {
  readonly fetchedAt: number
  readonly result: WikiDiscoveryResult
}

let cache: CacheEntry | null = null

const resolveSources = (stored: ReadonlyArray<string>): ReadonlyArray<string> =>
  mergeSources(process.env.SAMSINN_WIKI_SOURCES, stored, [...FALLBACK_SOURCES])

const resolveToken = (stored?: string): string =>
  process.env.SAMSINN_WIKI_REGISTRY_TOKEN ?? stored ?? ''

const isWikiOnlyOwner = (owner: string): boolean =>
  /-wikis$/.test(owner) || owner === 'samsinn-wikis'

// Derive a validator-safe wiki id from the repo basename. See prior version
// for the exhaustive rules — same logic, kept here so the discovery module
// stays self-contained.
export const deriveWikiId = (repoName: string): string => {
  const lower = repoName.toLowerCase()
  const stripped = lower.startsWith(PREFIX) ? lower.slice(PREFIX.length) : lower
  let cleaned = stripped.replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  if (cleaned.length > 63) cleaned = cleaned.slice(0, 63).replace(/-$/, '')
  if (cleaned && !/^[a-z0-9]/.test(cleaned)) cleaned = `w-${cleaned}`.slice(0, 63).replace(/-$/, '')
  if (!cleaned || !isValidWikiId(cleaned)) {
    let h = 0
    for (let i = 0; i < repoName.length; i++) h = ((h << 5) - h + repoName.charCodeAt(i)) | 0
    cleaned = `w-${(h >>> 0).toString(16).padStart(8, '0')}`
  }
  return cleaned
}

export const ensureUniqueId = (base: string, taken: ReadonlySet<string>): string => {
  if (!taken.has(base)) return base
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`.slice(0, 63).replace(/-$/, '')
    if (!taken.has(candidate)) return candidate
  }
  throw new Error(`could not allocate unique wiki id from base ${base}`)
}

// repoToItem closure carries the running `taken` set so collision suffixing
// stays deterministic across the iteration.
const makeRepoToItem = () => {
  const taken = new Set<string>()
  return (r: GHRepo): DiscoveredWiki => {
    const base = deriveWikiId(r.name)
    const id = ensureUniqueId(base, taken)
    taken.add(id)
    const description = r.description ?? ''
    return {
      id,
      owner: r.full_name.split('/')[0] ?? '',
      repo: r.name,
      displayName: description.trim() || `${r.full_name}`,
      description,
      repoUrl: r.html_url,
      source: r.full_name,
    }
  }
}

export interface GetAvailableWikisOptions {
  readonly storedSources?: ReadonlyArray<string>
  readonly storedToken?: string
  readonly fetchFn?: FetchFn
}

export const getAvailableWikis = async (
  options: GetAvailableWikisOptions = {},
): Promise<WikiDiscoveryResult> => {
  const now = Date.now()
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache.result

  const sources = resolveSources(options.storedSources ?? [])
  const repoToItem = makeRepoToItem()
  const result = await discoverFromGitHub<DiscoveredWiki>({
    sources,
    ownerOnlyPolicy: isWikiOnlyOwner,
    repoFilter: (r) => r.name.startsWith(PREFIX),
    repoToItem,
    dedupeKey: (w) => w.source,
    token: resolveToken(options.storedToken),
    tokenEnvVar: 'SAMSINN_WIKI_REGISTRY_TOKEN',
    userAgent: 'samsinn-wiki-registry',
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
  })
  if (result.items.length > 0 || result.failures.length === 0) {
    cache = { fetchedAt: now, result }
  }
  return result
}

export const invalidateDiscoveryCache = (): void => { cache = null }
