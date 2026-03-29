import { describe, test, expect } from 'bun:test'
import tools from './research.ts'

const ctx = { callerId: 'test-id', callerName: 'TestAgent' }

const toolMap = Object.fromEntries(tools.map(t => [t.name, t]))

describe('arxiv_search', () => {
  test('returns results for "quantum computing"', async () => {
    const arxiv = toolMap['arxiv_search']
    expect(arxiv).toBeDefined()

    const result = await arxiv!.execute({ query: 'quantum computing', max_results: 3 }, ctx)

    // Skip gracefully when the API is rate-limited, timed out, or temporarily unavailable
    if (!result.success) {
      const isTransient = typeof result.error === 'string' && (
        result.error.includes('429') || result.error.includes('503') ||
        result.error.includes('rate') || result.error.includes('timed out')
      )
      if (isTransient) return
    }

    expect(result.success).toBe(true)

    const data = result.data as Array<{
      title: string
      summary: string
      authors: string[]
      url: string
      published: string
    }>
    expect(Array.isArray(data)).toBe(true)
    expect(data.length).toBeGreaterThan(0)

    const first = data[0]
    expect(first).toBeDefined()
    expect(typeof first!.title).toBe('string')
    expect(first!.title.length).toBeGreaterThan(0)
    expect(typeof first!.summary).toBe('string')
    expect(Array.isArray(first!.authors)).toBe(true)
    expect(typeof first!.url).toBe('string')
    expect(first!.url).toContain('arxiv.org')
  }, 30_000)

  test('returns error for missing query', async () => {
    const arxiv = toolMap['arxiv_search']
    const result = await arxiv!.execute({}, ctx)
    expect(result.success).toBe(false)
  })
})

describe('doi_lookup', () => {
  test('resolves DOI 10.1145/3442188.3445922 to citation metadata', async () => {
    const doiLookup = toolMap['doi_lookup']
    expect(doiLookup).toBeDefined()

    const result = await doiLookup!.execute({ doi: '10.1145/3442188.3445922' }, ctx)
    expect(result.success).toBe(true)

    const data = result.data as {
      title: string
      authors: Array<{ family: string; given: string }>
      published: string | null
      journal: string | null
      doi: string
    }
    expect(typeof data.title).toBe('string')
    expect(data.title.length).toBeGreaterThan(0)
    expect(Array.isArray(data.authors)).toBe(true)
    expect(data.authors.length).toBeGreaterThan(0)
    expect(typeof data.doi).toBe('string')
    expect(data.doi).toContain('10.1145')
  }, 30_000)

  test('returns error for missing doi parameter', async () => {
    const doiLookup = toolMap['doi_lookup']
    const result = await doiLookup!.execute({}, ctx)
    expect(result.success).toBe(false)
  })
})

describe('semantic_scholar', () => {
  test('returns results for "transformer neural network"', async () => {
    const s2 = toolMap['semantic_scholar']
    expect(s2).toBeDefined()

    const result = await s2!.execute({ query: 'transformer neural network', limit: 3 }, ctx)

    // Skip gracefully when the API is rate-limited, timed out, or temporarily unavailable
    if (!result.success) {
      const isTransient = typeof result.error === 'string' && (
        result.error.includes('429') || result.error.includes('503') ||
        result.error.includes('rate') || result.error.includes('timed out')
      )
      if (isTransient) return
    }

    expect(result.success).toBe(true)

    const data = result.data as Array<{
      title: string
      authors: string[]
      year: number | null
      abstract: string | null
      citationCount: number
      tldr: string | null
      doi: string | null
    }>
    expect(Array.isArray(data)).toBe(true)
    expect(data.length).toBeGreaterThan(0)

    const first = data[0]
    expect(first).toBeDefined()
    expect(typeof first!.title).toBe('string')
    expect(first!.title.length).toBeGreaterThan(0)
    expect(Array.isArray(first!.authors)).toBe(true)
    expect(typeof first!.citationCount).toBe('number')
  }, 30_000)

  test('returns error for missing query parameter', async () => {
    const s2 = toolMap['semantic_scholar']
    const result = await s2!.execute({}, ctx)
    expect(result.success).toBe(false)
  })
})
