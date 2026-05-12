// Generic wiki content fetcher — pulls markdown directly from
// raw.githubusercontent.com. No disk cache, no Tree API, no GitHub auth
// (the supported wiki repos are public). Process-level in-memory buffer
// keeps repeat hits within a session free.
//
// The first consumer is the pwr-eops pack's procedure_lookup tool.
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

export interface WikiSource {
  readonly binding: WikiSourceBinding
  /** Fetch the index file once and cache it; subsequent calls return the cached value within ttl. */
  readonly fetchIndex: () => Promise<string>
  /** Fetch a procedure's raw markdown by id (case-sensitive — wiki uses canonical ids). */
  readonly fetchProcedure: (id: string) => Promise<string>
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

  const fetchFresh = async (path: string): Promise<string> => {
    const url = `${rawBase}/${path}`
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT } }, FETCH_TIMEOUT_MS)
    if (!res.ok) {
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

  return {
    binding,
    fetchIndex: () => getBuffered('__index__', binding.indexFile),
    fetchProcedure: (id: string) => getBuffered(id, `${binding.procedureDir}/${id}.md`),
    citationUrl: (id: string) => `${binding.citationBase.replace(/\/$/, '')}/${id}/`,
    rawUrl: (id: string) => `${rawBase}/${binding.procedureDir}/${id}.md`,
  }
}

// Extract canonical procedure ids from an index page that uses wikilinks.
// The pwr-eops index lists procedures as `[[E-0]]`, `[[ECA-0.0]]`, etc.
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
