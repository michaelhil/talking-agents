// Generic wiki content fetcher — pulls markdown directly from
// raw.githubusercontent.com. No disk cache, no Tree API, no GitHub auth
// (the supported wiki repos are public). Process-level in-memory buffer
// keeps repeat hits within a session free.
//
// The first consumer is the pwr-ops pack's procedure_lookup tool.
// Future wiki-backed packs follow the same shape: declare a
// WikiSourceBinding in pack.json, call createWikiSource(), the helper
// owns the fetch + buffer.

import type { WikiSourceBinding } from '../packs/types.ts'
import { fetchWithTimeout } from '../core/fetch-utils.ts'

const FETCH_TIMEOUT_MS = 8_000
const DEFAULT_TTL_MS = 5 * 60 * 1000  // 5 minutes
const USER_AGENT = 'samsinn-wiki/1.0'

interface BufferEntry {
  readonly value: string
  readonly fetchedAt: number
}

/**
 * Wiki manifest schema v1 — machine-readable counterpart to wiki/index.md.
 * Emitted by the wiki's build pipeline (e.g. pwr-ops/scripts/build-manifest.ts).
 */
export interface WikiManifest {
  readonly version: 1
  readonly wiki: string
  readonly procmdVersion?: string
  readonly procedures: ReadonlyArray<WikiManifestEntry>
  /**
   * Phase D additions — non-procedure pages (system descriptions, tag /
   * setpoint catalogues, tech-spec extracts, lineups). Optional for
   * backward compatibility: a v1 manifest without `pages` is still valid.
   */
  readonly pages?: ReadonlyArray<WikiManifestPageEntry>
}

export interface WikiManifestEntry {
  readonly id: string
  readonly title?: string
  readonly file?: string
  readonly category?: string
  readonly csfsMonitored?: ReadonlyArray<string>
  readonly entryTriggers?: ReadonlyArray<string>
  readonly coverage?: 'developed' | 'partial' | 'stub'
  readonly stepCount?: number
  readonly tagDefinitionCount?: number
}

/**
 * Known page types the samsinn TypeScript side cares about. The wiki MAY
 * publish additional types beyond this union — `wiki_lookup` validates
 * incoming type strings against the live manifest's `pages[].type` set
 * rather than this union, so a new wiki page type ships without a samsinn
 * release. Add to this union when samsinn-side code wants to special-case
 * a type (e.g. a dedicated tool for `scenario` pages).
 */
export type WikiPageType =
  | 'system-description'
  | 'tag-catalogue'
  | 'setpoint-catalogue'
  | 'tech-spec'
  | 'lineup'
  | (string & {})

export interface WikiManifestPageEntry {
  readonly id: string
  readonly type: WikiPageType
  readonly title?: string
  readonly file: string
  readonly appliesTo?: string
  readonly referencePlant?: string
  readonly csfsRelated?: ReadonlyArray<string>
}

export interface WikiSource {
  readonly binding: WikiSourceBinding
  /** Fetch the index file once and cache it; subsequent calls return the cached value within ttl. */
  readonly fetchIndex: () => Promise<string>
  /**
   * Fetch the wiki's `_manifest.json` if the binding declares `manifestFile`.
   * Returns null if not declared or if the fetch/parse fails (caller falls
   * back to regex scraping of `indexFile`). Never throws.
   */
  readonly fetchManifest: () => Promise<WikiManifest | null>
  /** Fetch a procedure's raw markdown by id (case-sensitive — wiki uses canonical ids). */
  readonly fetchProcedure: (id: string) => Promise<string>
  /**
   * Fetch an arbitrary page from the wiki by its repo-relative path
   * (e.g. `wiki/systems/rcs.md`, `wiki/tags/index.md`). Uses the same
   * raw → Pages fallback path as procedures. Cached per ttl.
   */
  readonly fetchPage: (path: string) => Promise<string>
  /** Build the canonical citation URL for a procedure id (the rendered wiki page). */
  readonly citationUrl: (id: string) => string
  /** Build the raw.githubusercontent URL for a procedure id (the markdown source). */
  readonly rawUrl: (id: string) => string
}

export const createWikiSource = (
  binding: WikiSourceBinding,
  ttlMs: number = DEFAULT_TTL_MS,
): WikiSource => {
  const buffer = new Map<string, BufferEntry>()

  const rawBase = `https://raw.githubusercontent.com/${binding.org}/${binding.repo}/${binding.branch}`

  // Fallback fetch: if raw.githubusercontent.com is unavailable (rate-limit,
  // transient outage), try the GitHub Pages mirror for files the wiki ships
  // into its `site/` artifact. The pwr-ops deploy workflow stages
  // _manifest.json into site/_manifest.json at the org-page root, so the
  // fallback URL is `<citationBase>../<basename>`. For procedure markdown,
  // there is no published .md sidecar today — the fallback returns 404 and
  // surfaces the original raw error to the caller. Adding a `<id>/raw.md`
  // sidecar is a separate wiki-side workstream.
  const pagesFallbackUrl = (path: string): string | null => {
    // citationBase ends like ".../pwr-ops/procedures/" — strip trailing path
    // segments to get the site root.
    try {
      const base = new URL(binding.citationBase)
      const siteRoot = `${base.origin}${base.pathname.replace(/procedures\/?$/, '')}`
      const basename = path.split('/').pop()!
      // The deploy workflow stages these into the GitHub Pages tree:
      //   site/_manifest.json
      //   site/procedures/<id>.md   (verbatim source markdown)
      //   site/profiles/<id>.md
      if (basename === '_manifest.json' || path === binding.manifestFile) {
        return `${siteRoot}_manifest.json`.replace(/([^:])\/\/+/g, '$1/')
      }
      // F.1 — _eal-rules.json sibling, same Pages-fallback pattern.
      if (basename === '_eal-rules.json') {
        return `${siteRoot}_eal-rules.json`.replace(/([^:])\/\/+/g, '$1/')
      }
      // Procedure markdown: <procedureDir>/<id>.md → site/procedures/<id>.md
      const procPrefix = binding.procedureDir.replace(/\/$/, '') + '/'
      if (path.startsWith(procPrefix) && path.endsWith('.md')) {
        return `${siteRoot}procedures/${basename}`.replace(/([^:])\/\/+/g, '$1/')
      }
      return null
    } catch { return null }
  }

  const fetchFresh = async (path: string): Promise<string> => {
    const url = `${rawBase}/${path}`
    let res: Response
    try {
      res = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT } }, FETCH_TIMEOUT_MS)
    } catch (err) {
      // Network-level failure — try fallback before giving up
      const fb = pagesFallbackUrl(path)
      if (fb) {
        try {
          const fbRes = await fetchWithTimeout(fb, { headers: { 'User-Agent': USER_AGENT } }, FETCH_TIMEOUT_MS)
          if (fbRes.ok) return await fbRes.text()
        } catch { /* fall through to original error */ }
      }
      throw err
    }
    if (!res.ok) {
      const fb = pagesFallbackUrl(path)
      if (fb) {
        try {
          const fbRes = await fetchWithTimeout(fb, { headers: { 'User-Agent': USER_AGENT } }, FETCH_TIMEOUT_MS)
          if (fbRes.ok) return await fbRes.text()
        } catch { /* fall through */ }
      }
      throw new Error(`HTTP ${res.status} fetching ${path} from ${binding.org}/${binding.repo}`)
    }
    return await res.text()
  }

  const getBuffered = async (key: string, path: string): Promise<string> => {
    const now = Date.now()
    const cached = buffer.get(key)
    if (cached && now - cached.fetchedAt < ttlMs) return cached.value
    const value = await fetchFresh(path)
    buffer.set(key, { value, fetchedAt: now })
    return value
  }

  const fetchManifest = async (): Promise<WikiManifest | null> => {
    if (!binding.manifestFile) return null
    let raw: string
    try {
      raw = await getBuffered('__manifest__', binding.manifestFile)
    } catch {
      return null
    }
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!parsed || typeof parsed !== 'object') return null
      const m = parsed as Partial<WikiManifest>
      if (m.version !== 1 || !Array.isArray(m.procedures)) return null
      // `pages` is optional — silently drop a malformed `pages` field
      // rather than failing the whole manifest (procedures still usable).
      if (m.pages !== undefined && !Array.isArray(m.pages)) {
        const { pages: _ignored, ...rest } = m
        return rest as WikiManifest
      }
      return m as WikiManifest
    } catch {
      return null
    }
  }

  return {
    binding,
    fetchIndex: () => getBuffered('__index__', binding.indexFile),
    fetchManifest,
    fetchProcedure: (id: string) => getBuffered(id, `${binding.procedureDir}/${id}.md`),
    fetchPage: (path: string) => getBuffered(`page:${path}`, path),
    citationUrl: (id: string) => `${binding.citationBase.replace(/\/$/, '')}/${id}/`,
    rawUrl: (id: string) => `${rawBase}/${binding.procedureDir}/${id}.md`,
  }
}

// Extract canonical procedure ids from an index page that uses wikilinks.
// The pwr-ops index lists procedures as `[[E-0]]`, `[[ECA-0.0]]`, etc.
// Returns deduplicated ids in encounter order, filtered to procmd-shaped
// ids (uppercase + digits + hyphens + dots; must start with a letter).
const ID_RE = /\[\[([A-Z][A-Z0-9.-]*)\]\]/g

export const extractProcedureIds = (indexMarkdown: string): ReadonlyArray<string> => {
  const seen = new Set<string>()
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = ID_RE.exec(indexMarkdown)) !== null) {
    const id = m[1]!
    if (!seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}
