// ============================================================================
// Pack registry resolver — discovers available packs on GitHub so the UI
// can show a browsable list (alongside what's installed).
//
// Sources are configured via SAMSINN_PACK_SOURCES (comma-separated). Each
// entry is one of:
//   - `<owner>`         — list `<owner>/samsinn-pack-*` repos
//   - `<owner>/<repo>`  — a single specific pack repo
//
// Default: `samsinn-packs` (the canonical org once it exists).
//
// The exposed `name` is the canonical install namespace — the repo basename
// with any `samsinn-pack-` prefix stripped. This matches what install_pack
// writes under packsDir (manifest.name first; stripped basename fallback —
// for canonical packs the two agree). Downstream consumers can do straight
// equality against installed-pack namespaces; no prefix-stripping shims.
//
// GitHub API is hit unauthenticated (60 req/hr) by default; set
// SAMSINN_GH_TOKEN to lift to 5000/hr (the same token bug-reporting uses).
// Results are cached for 5 min so the UI Browse view doesn't hammer the API.
// ============================================================================

import { stripPackPrefix } from './manifest.ts'

const PREFIX = 'samsinn-pack-'
const CACHE_TTL_MS = 5 * 60_000

export interface RegistryPack {
  readonly name: string         // canonical install namespace (stripped repo basename)
  readonly repoName: string     // unstripped GitHub repo name (for display + diagnostics)
  readonly source: string       // "owner/repo"
  readonly repoUrl: string      // https URL
  readonly description: string
}

interface CacheEntry {
  readonly fetchedAt: number
  readonly packs: ReadonlyArray<RegistryPack>
}

let cache: CacheEntry | null = null

const parseSources = (raw: string | undefined): ReadonlyArray<string> => {
  const fallback = ['samsinn-packs']
  if (!raw) return fallback
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean)
  return parts.length > 0 ? parts : fallback
}

// Tokens: registry calls list public repos under arbitrary orgs/users, so
// the right credential is a token with broad public read — NOT the bug-
// reporting PAT which is fine-grained to a single repo and 403s on every
// other endpoint.
//
// Order:
//   1. SAMSINN_PACK_REGISTRY_TOKEN — explicit, intended for this purpose
//   2. unauthenticated — 60 req/hr per IP, fine for a 5-min-cached registry
//
// SAMSINN_GH_TOKEN is intentionally NOT used here — see commit log for
// the symptom (org listing 403'd because the fine-grained scope denied
// every endpoint outside michaelhil/samsinn).
const ghHeaders = (): Record<string, string> => {
  const h: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'samsinn-pack-registry',
  }
  const token = process.env.SAMSINN_PACK_REGISTRY_TOKEN
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

const repoToPack = (r: GHRepo): RegistryPack => ({
  name: stripPackPrefix(r.name),
  repoName: r.name,
  source: r.full_name,
  repoUrl: r.html_url,
  description: r.description ?? '',
})

// Owners whose repos are ALL treated as packs (no prefix filter). Anything
// matching `<x>-packs` is assumed to be a dedicated pack-hosting org by
// convention — `samsinn-packs`, `acme-packs`, etc. Operators putting their
// personal account in SAMSINN_PACK_SOURCES still get the prefix filter so
// random repos don't pollute the registry.
const isPackOnlyOwner = (owner: string): boolean =>
  /-packs$/.test(owner) || owner === 'samsinn-packs'

const fetchOwnerRepos = async (owner: string): Promise<ReadonlyArray<RegistryPack>> => {
  // /users/{owner}/repos works for both users and orgs.
  const res = await fetch(`https://api.github.com/users/${encodeURIComponent(owner)}/repos?per_page=100&sort=updated`, {
    headers: ghHeaders(),
  })
  if (!res.ok) {
    console.warn(`[packs/registry] fetch ${owner} failed: HTTP ${res.status}`)
    return []
  }
  const repos = await res.json() as ReadonlyArray<GHRepo>
  const baseFilter = (r: GHRepo): boolean => !r.archived && !r.fork
  return repos
    .filter(r => baseFilter(r) && (isPackOnlyOwner(owner) || r.name.startsWith(PREFIX)))
    .map(repoToPack)
}

const fetchOneRepo = async (ownerRepo: string): Promise<RegistryPack | null> => {
  const res = await fetch(`https://api.github.com/repos/${ownerRepo}`, {
    headers: ghHeaders(),
  })
  if (!res.ok) {
    console.warn(`[packs/registry] fetch ${ownerRepo} failed: HTTP ${res.status}`)
    return null
  }
  return repoToPack(await res.json() as GHRepo)
}

const dedupe = (packs: ReadonlyArray<RegistryPack>): ReadonlyArray<RegistryPack> => {
  const seen = new Set<string>()
  const out: RegistryPack[] = []
  for (const p of packs) {
    if (seen.has(p.source)) continue
    seen.add(p.source)
    out.push(p)
  }
  return out
}

export const getAvailablePacks = async (): Promise<ReadonlyArray<RegistryPack>> => {
  const now = Date.now()
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache.packs

  const sources = parseSources(process.env.SAMSINN_PACK_SOURCES)
  const all: RegistryPack[] = []
  for (const src of sources) {
    if (src.includes('/')) {
      const one = await fetchOneRepo(src)
      if (one) all.push(one)
    } else {
      const list = await fetchOwnerRepos(src)
      all.push(...list)
    }
  }
  const packs = dedupe(all)
  cache = { fetchedAt: now, packs }
  return packs
}

// Test/debug helper — clears the in-memory cache so the next call refetches.
export const invalidateRegistryCache = (): void => { cache = null }
