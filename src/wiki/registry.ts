// ============================================================================
// Wiki registry — owns the wikis configured by the operator and exposes the
// query surface the tools + context-builder need.
//
// On `warm(wikiId)` (called at register time and on manual refresh) the
// registry fetches index.md, scope.md, and every page slug listed in index.md
// into the cache. Subsequent `getPage`/`search` reads from the cache.
//
// Search is in-memory across the warmed pages of a single wiki (or all).
// Returns `WikiError` thrown by the adapter on transport failures.
// ============================================================================

import type { MergedWikiEntry, WikiPage, WikiState } from './types.ts'
import type { WikiAdapter } from './github-adapter.ts'
import type { WikiCache } from './cache.ts'
import { createGithubAdapter } from './github-adapter.ts'
import { createWikiCache } from './cache.ts'
import { parseWikiPage, extractIndexSlugs } from './parser.ts'

export interface WikiSearchHit {
  readonly wikiId: string
  readonly slug: string
  readonly title: string
  readonly type?: string
  readonly tags?: ReadonlyArray<string>
  readonly confidence?: 'high' | 'medium' | 'low'
  readonly snippet: string
  readonly score: number
}

export interface WikiSearchOptions {
  readonly wikiId?: string
  readonly type?: string
  readonly tag?: string
  readonly limit?: number
}

export interface WikiListEntry {
  readonly id: string
  readonly displayName: string
  readonly pageCount: number
  readonly lastWarmAt?: number
  readonly lastError?: string
}

export interface WikiRegistry {
  // Idempotent reconcile. Adds adapters for new ids, evicts cache for ids
  // no longer present. Replaces the boot-time setWikis (which had a write-
  // once mental model that drifted from external state). Callers should
  // route through resolveActiveWikis() so reconcile is invoked uniformly
  // before reads — the registry no longer maintains a "list of wikis"
  // independently of the merge of stored + discovered.
  readonly reconcile: (wikis: ReadonlyArray<MergedWikiEntry>) => void
  readonly warm: (wikiId: string) => Promise<{ pageCount: number; warnings: ReadonlyArray<string> }>
  readonly list: () => ReadonlyArray<WikiListEntry>
  readonly getIndex: (id: string) => string | undefined
  readonly getScope: (id: string) => string | undefined
  readonly getPage: (id: string, slug: string) => Promise<WikiPage | undefined>
  readonly search: (query: string, opts?: WikiSearchOptions) => ReadonlyArray<WikiSearchHit>
  readonly getState: (id: string) => WikiState | undefined
  // Install a callback fired when reconcile sees a new id (or a config
  // swap on an existing id). Bootstrap uses this for background-warm
  // logging. Tests can inject a recorder. Idempotent: only fires once
  // per id-or-config-change, not on every reconcile.
  readonly setOnNewWiki: (fn: (wikiId: string) => void) => void
}

export interface WikiRegistryOptions {
  readonly wikis: ReadonlyArray<MergedWikiEntry>
  readonly ttlMs?: number
  readonly cache?: WikiCache
  readonly adapterFactory?: (wiki: MergedWikiEntry) => WikiAdapter   // injectable for tests
}

interface InternalState {
  readonly wiki: MergedWikiEntry
  readonly adapter: WikiAdapter
  indexMd?: string
  scopeMd?: string
  lastWarmAt?: number
  lastError?: string
}

export const createWikiRegistry = (opts: WikiRegistryOptions): WikiRegistry => {
  const cache = opts.cache ?? createWikiCache({ ttlMs: opts.ttlMs ?? 24 * 60 * 60 * 1000 })
  const factory = opts.adapterFactory ?? createGithubAdapter
  const states = new Map<string, InternalState>()

  const installWiki = (wiki: MergedWikiEntry): void => {
    states.set(wiki.id, { wiki, adapter: factory(wiki) })
  }

  for (const w of opts.wikis) installWiki(w)

  // Background-warm callback: invoked when reconcile encounters a NEW id
  // (not previously in the registry). Default no-op; bootstrap installs a
  // logging warmer. Tests can inject a recorder. Lives here so all the
  // "wiki appeared" logic is in one place.
  let onNewWiki: (wikiId: string) => void = () => {}

  const setOnNewWiki = (fn: (wikiId: string) => void): void => { onNewWiki = fn }

  const reconcile: WikiRegistry['reconcile'] = (wikis) => {
    const newIds = new Set(wikis.map((w) => w.id))
    for (const id of [...states.keys()]) {
      if (!newIds.has(id)) { states.delete(id); cache.clear(id) }
    }
    for (const w of wikis) {
      const existing = states.get(w.id)
      // Re-install if config changed (new ref/PAT/etc).
      const configChanged = !existing
        || existing.wiki.owner !== w.owner
        || existing.wiki.repo !== w.repo
        || existing.wiki.ref !== w.ref
        || existing.wiki.apiKey !== w.apiKey
      if (configChanged) {
        cache.clear(w.id)
        installWiki(w)
        // First sighting of this id (or config swap) → trigger background
        // warm. Idempotent: subsequent reconciles with the same config
        // skip this branch.
        try { onNewWiki(w.id) } catch (err) {
          console.warn(`[wiki:${w.id}] onNewWiki callback threw: ${(err as Error).message}`)
        }
      }
    }
  }

  // Concurrency cap for parallel page fetches during warm. Authenticated
  // GitHub gives 5000 req/hr — a single warm at this cap is well within
  // budget. The cap keeps us courteous on shared raw.githubusercontent.com.
  const WARM_CONCURRENCY = 8

  const warm: WikiRegistry['warm'] = async (wikiId) => {
    const s = states.get(wikiId)
    if (!s) throw new Error(`unknown wiki: ${wikiId}`)
    cache.clear(wikiId)
    const warnings: string[] = []
    s.lastError = undefined

    s.indexMd = await s.adapter.fetchIndex()
    try { s.scopeMd = await s.adapter.fetchScope() } catch (err) {
      warnings.push(`scope.md skipped: ${(err as Error).message}`)
      s.scopeMd = undefined
    }
    const slugs = extractIndexSlugs(s.indexMd)

    // Parallel page fetches with a concurrency cap. Sequential per-page
    // await was ~50ms × N pages = ~5s wall time for a 100-page wiki; this
    // drops it to roughly N/cap × 50ms (~700ms at cap=8). Order of
    // `warnings` is non-deterministic; previously-implicit-by-loop ordering
    // is not part of any contract.
    let okCount = 0
    let cursor = 0
    const fetchOne = async (slug: string): Promise<void> => {
      try {
        const { path, body } = await s.adapter.fetchPage(slug)
        cache.put(wikiId, parseWikiPage(path, body))
        okCount += 1
      } catch (err) {
        warnings.push(`page ${slug}: ${(err as Error).message}`)
      }
    }
    const worker = async (): Promise<void> => {
      while (true) {
        const i = cursor++
        if (i >= slugs.length) return
        const slug = slugs[i]
        if (slug !== undefined) await fetchOne(slug)
      }
    }
    const workerCount = Math.min(WARM_CONCURRENCY, Math.max(1, slugs.length))
    await Promise.all(Array.from({ length: workerCount }, () => worker()))

    s.lastWarmAt = Date.now()
    return { pageCount: okCount, warnings }
  }

  const getPage: WikiRegistry['getPage'] = async (id, slug) => {
    const s = states.get(id)
    if (!s) return undefined
    const cached = cache.get(id, slug)
    if (cached) return cached
    try {
      const { path, body } = await s.adapter.fetchPage(slug)
      const page = parseWikiPage(path, body)
      cache.put(id, page)
      return page
    } catch (err) {
      s.lastError = (err as Error).message
      throw err
    }
  }

  const search: WikiRegistry['search'] = (query, opts2 = {}) => {
    const q = query.trim().toLowerCase()
    const limit = opts2.limit ?? 10
    const targets = opts2.wikiId
      ? (states.has(opts2.wikiId) ? [opts2.wikiId] : [])
      : [...states.keys()]
    const hits: WikiSearchHit[] = []
    for (const id of targets) {
      for (const page of cache.listPages(id)) {
        if (opts2.type && page.frontmatter.type !== opts2.type) continue
        if (opts2.tag && !(page.frontmatter.tags ?? []).includes(opts2.tag)) continue
        const score = scorePage(page, q)
        if (score <= 0 && q.length > 0) continue
        hits.push({
          wikiId: id,
          slug: page.slug,
          title: page.frontmatter.title,
          ...(page.frontmatter.type ? { type: page.frontmatter.type } : {}),
          ...(page.frontmatter.tags ? { tags: page.frontmatter.tags } : {}),
          ...(page.frontmatter.confidence ? { confidence: page.frontmatter.confidence } : {}),
          snippet: snippetAround(page.body, q),
          score,
        })
      }
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, limit)
  }

  const list: WikiRegistry['list'] = () =>
    [...states.values()].map((s) => ({
      id: s.wiki.id,
      displayName: s.wiki.displayName,
      pageCount: cache.size(s.wiki.id),
      ...(s.lastWarmAt !== undefined ? { lastWarmAt: s.lastWarmAt } : {}),
      ...(s.lastError !== undefined ? { lastError: s.lastError } : {}),
    }))

  return {
    reconcile,
    warm,
    list,
    getIndex: (id) => states.get(id)?.indexMd,
    getScope: (id) => states.get(id)?.scopeMd,
    getPage,
    search,
    setOnNewWiki,
    getState: (id) => {
      const s = states.get(id)
      if (!s) return undefined
      const pageMap = new Map<string, WikiPage>()
      for (const p of cache.listPages(id)) pageMap.set(p.slug, p)
      return {
        id: s.wiki.id,
        displayName: s.wiki.displayName,
        ...(s.indexMd !== undefined ? { indexMd: s.indexMd } : {}),
        ...(s.scopeMd !== undefined ? { scopeMd: s.scopeMd } : {}),
        pages: pageMap,
        ...(s.lastWarmAt !== undefined ? { lastWarmAt: s.lastWarmAt } : {}),
        ...(s.lastError !== undefined ? { lastError: s.lastError } : {}),
      }
    },
  }
}

// === Scoring + snippet ===

const scorePage = (page: WikiPage, q: string): number => {
  if (!q) return 1
  const title = page.frontmatter.title.toLowerCase()
  const slug = page.slug.toLowerCase()
  const body = page.body.toLowerCase()
  const tags = (page.frontmatter.tags ?? []).map((t) => t.toLowerCase())

  let score = 0
  if (slug === q) score += 100
  if (title === q) score += 80
  if (slug.includes(q)) score += 30
  if (title.includes(q)) score += 20
  if (tags.some((t) => t === q)) score += 25
  if (tags.some((t) => t.includes(q))) score += 5
  // Body occurrences: cap to avoid one big page dominating.
  const bodyHits = body.split(q).length - 1
  score += Math.min(bodyHits, 5) * 2
  return score
}

const snippetAround = (body: string, q: string, len = 200): string => {
  if (!q) return body.slice(0, len)
  const idx = body.toLowerCase().indexOf(q)
  if (idx < 0) return body.slice(0, len)
  const start = Math.max(0, idx - 60)
  return (start > 0 ? '…' : '') + body.slice(start, start + len).replace(/\s+/g, ' ').trim() + (start + len < body.length ? '…' : '')
}
