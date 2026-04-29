// ============================================================================
// GitHub-discovery helper — shared scaffolding used by pack registry + wiki
// discovery. Both modules walked the same shape:
//   - resolve sources (env + stored, deduped, fallback default)
//   - fetch each source from api.github.com
//   - classify HTTP failures (rate-limit, auth, not_found, network, http)
//   - dedupe results + cache for 5 min
//
// This helper owns the fetch/classify/cache mechanics. Each domain owns the
// repo-filter + repo-to-item mapping (different prefix conventions, different
// item shapes). Shared so silent-fail antipatterns stay fixed in one place.
// ============================================================================

export type FailureReason =
  | 'rate_limit'        // primary GitHub rate limit (60/hr unauthenticated)
  | 'secondary_limit'   // burst / abuse-detection
  | 'auth'              // 401, or 403 without rate-limit signature
  | 'not_found'         // 404
  | 'network'           // fetch threw (connection, DNS, etc.)
  | 'http'              // any other non-OK status

export interface DiscoveryFailure {
  readonly source: string         // owner or owner/repo we tried
  readonly status: number         // HTTP status, or 0 for network failures
  readonly reason: FailureReason
  readonly message: string        // user-facing — already includes the actionable hint
}

export interface GHRepo {
  readonly name: string
  readonly full_name: string
  readonly description: string | null
  readonly html_url: string
  readonly archived?: boolean
  readonly fork?: boolean
}

// Classify a non-OK fetch response. Header-first for primary rate limit
// (X-RateLimit-Remaining: 0 is GitHub's documented signal), then body regex
// for secondary/abuse, then generic 403/auth fall-through. 401 and 404 are
// unambiguous.
export const classifyHttpFailure = async (
  res: Response,
  source: string,
  tokenEnvVar: string,
): Promise<DiscoveryFailure> => {
  if (res.status === 401) {
    return { source, status: 401, reason: 'auth', message: `GitHub returned 401 — check ${tokenEnvVar}` }
  }
  if (res.status === 404) {
    return { source, status: 404, reason: 'not_found', message: `GitHub returned 404 for "${source}"` }
  }
  if (res.status === 403) {
    // Header-first: X-RateLimit-Remaining: 0 is the definitive primary-limit signal.
    if (res.headers.get('x-ratelimit-remaining') === '0') {
      return {
        source, status: 403, reason: 'rate_limit',
        message: `GitHub rate limit hit (60/hr unauthenticated). Set ${tokenEnvVar} to lift to 5000/hr.`,
      }
    }
    // Body regex for secondary / abuse limits (no dedicated header).
    let body = ''
    try { body = await res.text() } catch { /* ignore */ }
    if (/secondary rate limit|abuse/i.test(body)) {
      return {
        source, status: 403, reason: 'secondary_limit',
        message: `GitHub secondary rate limit — slow down requests. (Burst limit, distinct from the hourly cap.)`,
      }
    }
    if (/rate limit/i.test(body)) {
      return {
        source, status: 403, reason: 'rate_limit',
        message: `GitHub rate limit hit. Set ${tokenEnvVar} to lift to 5000/hr.`,
      }
    }
    return { source, status: 403, reason: 'auth', message: `GitHub returned 403 for "${source}" — token may lack scope` }
  }
  return { source, status: res.status, reason: 'http', message: `GitHub returned HTTP ${res.status} for "${source}"` }
}

// Inject-friendly fetch type so unit tests can pass a real-but-controlled
// implementation (per repo's no-mocks rule). Defaults to global fetch.
export type FetchFn = typeof fetch

export interface DiscoverDeps<TItem> {
  // List of `<owner>` or `<owner>/<repo>` to scan.
  readonly sources: ReadonlyArray<string>
  // Owners whose repos are ALL treated as items (no name prefix filter).
  // Convention: `<x>-packs` / `<x>-wikis` are dedicated org names.
  readonly ownerOnlyPolicy: (owner: string) => boolean
  // Per-domain repo filter (e.g. starts-with `samsinn-pack-`). Applied
  // after archived/fork are excluded.
  readonly repoFilter: (repo: GHRepo) => boolean
  // Map a GH repo to the domain item shape.
  readonly repoToItem: (repo: GHRepo, owner: string) => TItem
  // Dedupe key — typically `repo.full_name`.
  readonly dedupeKey: (item: TItem) => string
  // Auth token; '' for unauthenticated.
  readonly token: string
  // Env var name to mention in failure messages.
  readonly tokenEnvVar: string
  // User-Agent header — debugging aid.
  readonly userAgent: string
  // Optional fetch override for testing.
  readonly fetchFn?: FetchFn
}

export interface DiscoveryResult<TItem> {
  readonly items: ReadonlyArray<TItem>
  readonly failures: ReadonlyArray<DiscoveryFailure>
}

const buildHeaders = (token: string, userAgent: string): Record<string, string> => {
  const h: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': userAgent,
  }
  if (token) h['Authorization'] = `Bearer ${token}`
  return h
}

const fetchOwnerRepos = async <TItem>(
  owner: string,
  deps: DiscoverDeps<TItem>,
): Promise<{ items: TItem[]; failure?: DiscoveryFailure }> => {
  const fetchImpl = deps.fetchFn ?? fetch
  let res: Response
  try {
    res = await fetchImpl(
      `https://api.github.com/users/${encodeURIComponent(owner)}/repos?per_page=100&sort=updated`,
      { headers: buildHeaders(deps.token, deps.userAgent) },
    )
  } catch (err) {
    return {
      items: [],
      failure: { source: owner, status: 0, reason: 'network', message: err instanceof Error ? err.message : 'network failure' },
    }
  }
  if (!res.ok) return { items: [], failure: await classifyHttpFailure(res, owner, deps.tokenEnvVar) }
  const repos = await res.json() as ReadonlyArray<GHRepo>
  const ownerOnly = deps.ownerOnlyPolicy(owner)
  const items = repos
    .filter((r) => !r.archived && !r.fork && (ownerOnly || deps.repoFilter(r)))
    .map((r) => deps.repoToItem(r, owner))
  return { items }
}

const fetchOneRepo = async <TItem>(
  ownerRepo: string,
  deps: DiscoverDeps<TItem>,
): Promise<{ item: TItem | null; failure?: DiscoveryFailure }> => {
  const fetchImpl = deps.fetchFn ?? fetch
  let res: Response
  try {
    res = await fetchImpl(
      `https://api.github.com/repos/${ownerRepo}`,
      { headers: buildHeaders(deps.token, deps.userAgent) },
    )
  } catch (err) {
    return {
      item: null,
      failure: { source: ownerRepo, status: 0, reason: 'network', message: err instanceof Error ? err.message : 'network failure' },
    }
  }
  if (!res.ok) return { item: null, failure: await classifyHttpFailure(res, ownerRepo, deps.tokenEnvVar) }
  const repo = await res.json() as GHRepo
  const owner = repo.full_name.split('/')[0] ?? ''
  return { item: deps.repoToItem(repo, owner) }
}

export const discoverFromGitHub = async <TItem>(
  deps: DiscoverDeps<TItem>,
): Promise<DiscoveryResult<TItem>> => {
  const all: TItem[] = []
  const failures: DiscoveryFailure[] = []
  for (const src of deps.sources) {
    if (src.includes('/')) {
      const { item, failure } = await fetchOneRepo(src, deps)
      if (item) all.push(item)
      if (failure) failures.push(failure)
    } else {
      const { items, failure } = await fetchOwnerRepos(src, deps)
      all.push(...items)
      if (failure) failures.push(failure)
    }
  }
  // Dedupe — preserve first occurrence order.
  const seen = new Set<string>()
  const items: TItem[] = []
  for (const it of all) {
    const k = deps.dedupeKey(it)
    if (seen.has(k)) continue
    seen.add(k)
    items.push(it)
  }
  return { items, failures }
}
