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
// GitHub API is hit unauthenticated (60 req/hr) by default; set
// SAMSINN_GH_TOKEN to lift to 5000/hr (the same token bug-reporting uses).
// Results are cached for 5 min so the UI Browse view doesn't hammer the API.
// ============================================================================

const PREFIX = 'samsinn-pack-'
const CACHE_TTL_MS = 5 * 60_000

export interface RegistryPack {
  readonly name: string         // canonical install namespace (= repo basename)
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

const ghHeaders = (): Record<string, string> => {
  const h: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'samsinn-pack-registry',
  }
  const token = process.env.SAMSINN_GH_TOKEN
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
  name: r.name,
  source: r.full_name,
  repoUrl: r.html_url,
  description: r.description ?? '',
})

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
  return repos
    .filter(r => !r.archived && !r.fork && r.name.startsWith(PREFIX))
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
