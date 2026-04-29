import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { deriveWikiId, ensureUniqueId, getAvailableWikis, invalidateDiscoveryCache } from './discovery.ts'
import { mergeWithDiscovery, STORE_VERSION } from './store.ts'
import type { DiscoveredWiki } from './discovery.ts'
import type { WikiConfig } from './types.ts'

describe('deriveWikiId', () => {
  it('lowercases plain repo name', () => {
    expect(deriveWikiId('Nuclear-Wiki')).toBe('nuclear-wiki')
  })

  it('strips samsinn-wiki- prefix', () => {
    expect(deriveWikiId('samsinn-wiki-aviation')).toBe('aviation')
  })

  it('replaces underscores and other chars with dashes', () => {
    expect(deriveWikiId('foo_bar.baz')).toBe('foo-bar-baz')
  })

  it('collapses multiple dashes', () => {
    expect(deriveWikiId('foo___bar')).toBe('foo-bar')
  })

  it('trims leading/trailing dashes', () => {
    expect(deriveWikiId('-foo-bar-')).toBe('foo-bar')
  })

  it('truncates to 63 chars', () => {
    const long = 'a'.repeat(80)
    expect(deriveWikiId(long).length).toBeLessThanOrEqual(63)
  })

  it('prefixes w- when first char is non-alphanumeric after cleaning', () => {
    // '___' becomes '' after cleanup → fallback to w-
    const id = deriveWikiId('___')
    expect(id.startsWith('w-')).toBe(true)
  })

  it('produces validator-safe ids', () => {
    const cases = ['UPPER', 'with spaces', 'unicode-ñ', '123start', '-leading', 'trailing-']
    for (const c of cases) {
      const id = deriveWikiId(c)
      expect(id).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/)
    }
  })
})

describe('ensureUniqueId', () => {
  it('returns base when not taken', () => {
    expect(ensureUniqueId('foo', new Set())).toBe('foo')
  })

  it('suffixes -2 on first collision', () => {
    expect(ensureUniqueId('foo', new Set(['foo']))).toBe('foo-2')
  })

  it('skips taken suffixes', () => {
    expect(ensureUniqueId('foo', new Set(['foo', 'foo-2', 'foo-3']))).toBe('foo-4')
  })
})

describe('mergeWithDiscovery', () => {
  const stored = (cfg: Partial<WikiConfig> & { id: string; owner: string; repo: string }): WikiConfig => cfg
  const discovered = (cfg: Partial<DiscoveredWiki> & { id: string; owner: string; repo: string }): DiscoveredWiki => ({
    displayName: cfg.displayName ?? `${cfg.owner}/${cfg.repo}`,
    description: cfg.description ?? '',
    repoUrl: cfg.repoUrl ?? `https://github.com/${cfg.owner}/${cfg.repo}`,
    source: `${cfg.owner}/${cfg.repo}`,
    ...cfg,
  })

  it('returns stored entries with source=stored', () => {
    const result = mergeWithDiscovery(
      { version: STORE_VERSION, wikis: [stored({ id: 'a', owner: 'u', repo: 'r' })] },
      [],
    )
    expect(result).toHaveLength(1)
    expect(result[0]?.source).toBe('stored')
  })

  it('appends discovered entries with source=discovered', () => {
    const result = mergeWithDiscovery(
      { version: STORE_VERSION, wikis: [] },
      [discovered({ id: 'a', owner: 'u', repo: 'r' })],
    )
    expect(result).toHaveLength(1)
    expect(result[0]?.source).toBe('discovered')
    expect(result[0]?.enabled).toBe(true)
    expect(result[0]?.apiKey).toBe('')
  })

  it('stored wins on id collision', () => {
    const result = mergeWithDiscovery(
      { version: STORE_VERSION, wikis: [stored({ id: 'a', owner: 'u', repo: 'r', apiKey: 'secret', enabled: false })] },
      [discovered({ id: 'a', owner: 'u', repo: 'r' })],
    )
    expect(result).toHaveLength(1)
    expect(result[0]?.source).toBe('stored')
    expect(result[0]?.apiKey).toBe('secret')
    expect(result[0]?.enabled).toBe(false)
  })

  it('uses discovered displayName as fallback when stored has none', () => {
    const result = mergeWithDiscovery(
      { version: STORE_VERSION, wikis: [stored({ id: 'a', owner: 'u', repo: 'r' })] },
      [discovered({ id: 'a', owner: 'u', repo: 'r', displayName: 'Nuclear Emergency Wiki' })],
    )
    expect(result[0]?.displayName).toBe('Nuclear Emergency Wiki')
  })

  it('preserves stored displayName over discovered', () => {
    const result = mergeWithDiscovery(
      { version: STORE_VERSION, wikis: [stored({ id: 'a', owner: 'u', repo: 'r', displayName: 'Custom' })] },
      [discovered({ id: 'a', owner: 'u', repo: 'r', displayName: 'Discovered' })],
    )
    expect(result[0]?.displayName).toBe('Custom')
  })
})

describe('getAvailableWikis (live GitHub API — gated by env)', () => {
  beforeEach(() => { invalidateDiscoveryCache() })
  afterEach(() => { invalidateDiscoveryCache() })

  // The discovery uses real GitHub API. Skip by default; opt in by setting a
  // throwaway source that resolves to an empty list (or in CI with a real
  // public org configured). We only smoke-test the empty path here.
  it('returns empty array for unknown owner', async () => {
    const prev = process.env.SAMSINN_WIKI_SOURCES
    process.env.SAMSINN_WIKI_SOURCES = 'definitely-not-a-real-github-org-zxqwerty12345'
    try {
      const wikis = await getAvailableWikis()
      expect(Array.isArray(wikis)).toBe(true)
      expect(wikis.length).toBe(0)
    } finally {
      if (prev === undefined) delete process.env.SAMSINN_WIKI_SOURCES
      else process.env.SAMSINN_WIKI_SOURCES = prev
    }
  })
})
