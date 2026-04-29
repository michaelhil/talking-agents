// ============================================================================
// Wiki discovery — finds available wikis on GitHub so prod (and any new
// instance) can pick them up without per-machine wikis.json edits.
//
// Mirrors src/packs/registry.ts. Sources via SAMSINN_WIKI_SOURCES (csv of
// `<owner>` or `<owner>/<repo>`, default `samsinn-wikis`).
//
// Convention:
//   - Owner ending in `-wikis` (e.g. `samsinn-wikis`) → every non-archived /
//     non-fork repo is treated as a wiki.
//   - Other owners → repo basename must start with `samsinn-wiki-`.
//
// Token: SAMSINN_WIKI_REGISTRY_TOKEN (separate from SAMSINN_GH_TOKEN — same
// rationale as packs/registry.ts: org listings need broad public read; the
// fine-grained bug-report PAT 403s on every endpoint outside its scope).
//
// The result is ephemeral: discovered wikis are merged with the on-disk
// store at runtime via store.ts:mergeWithDiscovery. Discovery NEVER writes
// to wikis.json. Operator-managed entries (PATs, manual disable, displayName
// overrides) win on id collision.
// ============================================================================

import { isValidWikiId } from './store.ts'

const PREFIX = 'samsinn-wiki-'
const CACHE_TTL_MS = 5 * 60_000

export interface DiscoveredWiki {
  readonly id: string           // canonical wiki id (validator-safe)
  readonly owner: string
  readonly repo: string         // unstripped GitHub repo name (for display + diagnostics)
  readonly displayName: string  // repo description if present, else "{owner}/{repo}"
  readonly description: string
  readonly repoUrl: string
  readonly source: string       // "owner/repo" — dedupe key
}

interface CacheEntry {
  readonly fetchedAt: number
  readonly wikis: ReadonlyArray<DiscoveredWiki>
}

let cache: CacheEntry | null = null

const parseSources = (raw: string | undefined): ReadonlyArray<string> => {
  const fallback = ['samsinn-wikis']
  if (!raw) return fallback
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean)
  return parts.length > 0 ? parts : fallback
}

const ghHeaders = (): Record<string, string> => {
  const h: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'samsinn-wiki-registry',
  }
  const token = process.env.SAMSINN_WIKI_REGISTRY_TOKEN
  if (token) h['Authorization'] = `Bearer ${token}`
  return h
}

interface GHRepo {
  name: string
  full_name: string
  description: string | null
  html_url: string
  archived?: boolean
  fork?: boolean
}

// Owners whose repos are ALL treated as wikis (no prefix filter). Anything
// matching `<x>-wikis` is assumed to be a dedicated wiki-hosting org by
// convention. Operators putting a personal account in SAMSINN_WIKI_SOURCES
// still get the prefix filter so unrelated repos don't pollute the registry.
const isWikiOnlyOwner = (owner: string): boolean =>
  /-wikis$/.test(owner) || owner === 'samsinn-wikis'

// Derive a validator-safe wiki id from the repo basename.
//   - lowercase
//   - strip `samsinn-wiki-` prefix
//   - replace any non-`[a-z0-9-]` with `-`
//   - collapse runs of `-`
//   - trim leading/trailing `-`
//   - truncate to 63 chars (validator max)
//   - if first char isn't `[a-z0-9]`, prefix `w-`
//   - if validation still fails, fall back to `w-<8-hex>` of the source
//
// Collision suffixing (-2, -3, …) is the caller's job since it depends on
// the merge target.
export const deriveWikiId = (repoName: string): string => {
  const lower = repoName.toLowerCase()
  const stripped = lower.startsWith(PREFIX) ? lower.slice(PREFIX.length) : lower
  let cleaned = stripped.replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  if (cleaned.length > 63) cleaned = cleaned.slice(0, 63).replace(/-$/, '')
  if (cleaned && !/^[a-z0-9]/.test(cleaned)) cleaned = `w-${cleaned}`.slice(0, 63).replace(/-$/, '')
  if (!cleaned || !isValidWikiId(cleaned)) {
    // Hash fallback for empty/invalid cleaned ids. Deterministic given the repo name.
    let h = 0
    for (let i = 0; i < repoName.length; i++) h = ((h << 5) - h + repoName.charCodeAt(i)) | 0
    cleaned = `w-${(h >>> 0).toString(16).padStart(8, '0')}`
  }
  return cleaned
}

// Caller passes the set of ids already taken (by stored entries or earlier
// discovered entries). Suffix `-2`, `-3`, … until free.
export const ensureUniqueId = (base: string, taken: ReadonlySet<string>): string => {
  if (!taken.has(base)) return base
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`.slice(0, 63).replace(/-$/, '')
    if (!taken.has(candidate)) return candidate
  }
  // Should never happen — 1000 collisions on the same base means a config bug.
  throw new Error(`could not allocate unique wiki id from base ${base}`)
}

const repoToWiki = (r: GHRepo, taken: Set<string>): DiscoveredWiki => {
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

const fetchOwnerRepos = async (owner: string): Promise<ReadonlyArray<GHRepo>> => {
  const res = await fetch(
    `https://api.github.com/users/${encodeURIComponent(owner)}/repos?per_page=100&sort=updated`,
    { headers: ghHeaders() },
  )
  if (!res.ok) {
    console.warn(`[wiki/discovery] fetch ${owner} failed: HTTP ${res.status}`)
    return []
  }
  const repos = await res.json() as ReadonlyArray<GHRepo>
  return repos.filter((r) => !r.archived && !r.fork && (isWikiOnlyOwner(owner) || r.name.startsWith(PREFIX)))
}

const fetchOneRepo = async (ownerRepo: string): Promise<GHRepo | null> => {
  const res = await fetch(`https://api.github.com/repos/${ownerRepo}`, { headers: ghHeaders() })
  if (!res.ok) {
    console.warn(`[wiki/discovery] fetch ${ownerRepo} failed: HTTP ${res.status}`)
    return null
  }
  return await res.json() as GHRepo
}

export const getAvailableWikis = async (): Promise<ReadonlyArray<DiscoveredWiki>> => {
  const now = Date.now()
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache.wikis

  const sources = parseSources(process.env.SAMSINN_WIKI_SOURCES)
  const repos: GHRepo[] = []
  const seenSource = new Set<string>()
  for (const src of sources) {
    if (src.includes('/')) {
      const one = await fetchOneRepo(src)
      if (one && !seenSource.has(one.full_name)) {
        seenSource.add(one.full_name)
        repos.push(one)
      }
    } else {
      for (const r of await fetchOwnerRepos(src)) {
        if (seenSource.has(r.full_name)) continue
        seenSource.add(r.full_name)
        repos.push(r)
      }
    }
  }
  const taken = new Set<string>()
  const wikis = repos.map((r) => repoToWiki(r, taken))
  cache = { fetchedAt: now, wikis }
  return wikis
}

// Test/debug helper — clears the in-memory cache so the next call refetches.
export const invalidateDiscoveryCache = (): void => { cache = null }
