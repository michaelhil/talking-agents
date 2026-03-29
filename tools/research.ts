// ============================================================================
// Research Tools — Academic paper search via arXiv, Crossref DOI lookup,
// and Semantic Scholar.
// ============================================================================

import type { Tool, ToolResult } from '../src/core/types.ts'

// ---- arXiv ----

interface ArxivEntry {
  title: string
  summary: string
  authors: string[]
  url: string
  published: string
}

const parseAtomEntries = (xml: string): ArxivEntry[] => {
  const entries: ArxivEntry[] = []
  const entryPattern = /<entry>([\s\S]*?)<\/entry>/g
  let match: RegExpExecArray | null

  while ((match = entryPattern.exec(xml)) !== null) {
    const block = match[1] ?? ''

    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/)
    const summaryMatch = block.match(/<summary>([\s\S]*?)<\/summary>/)
    const idMatch = block.match(/<id>([\s\S]*?)<\/id>/)
    const publishedMatch = block.match(/<published>([\s\S]*?)<\/published>/)

    const authorPattern = /<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g
    const authors: string[] = []
    let authorMatch: RegExpExecArray | null
    while ((authorMatch = authorPattern.exec(block)) !== null) {
      const name = authorMatch[1]?.trim()
      if (name) authors.push(name)
    }

    const title = titleMatch?.[1]?.replace(/\s+/g, ' ').trim() ?? ''
    const summary = summaryMatch?.[1]?.replace(/\s+/g, ' ').trim() ?? ''
    const url = idMatch?.[1]?.trim() ?? ''
    const published = publishedMatch?.[1]?.trim() ?? ''

    if (title || url) {
      entries.push({ title, summary, authors, url, published })
    }
  }

  return entries
}

const arxivSearchTool: Tool = {
  name: 'arxiv_search',
  description: 'Search academic papers on arXiv by keyword or phrase.',
  usage: 'Search academic papers on arXiv. Free, no API key needed. Best for physics, CS, math, economics.',
  returns: 'Array of { title, summary, authors, url, published }',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query for arXiv papers' },
      max_results: { type: 'number', description: 'Maximum number of results to return (default 5)' },
    },
    required: ['query'],
  },
  execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
    const query = params.query as string | undefined
    if (!query) return { success: false, error: '"query" is required' }
    const maxResults = typeof params.max_results === 'number' ? params.max_results : 5

    const url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=${maxResults}&sortBy=relevance`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Samsinn/1.0' },
      })
      clearTimeout(timeout)
      if (!response.ok) {
        return { success: false, error: `arXiv API error: ${response.status} ${response.statusText}` }
      }
      const xml = await response.text()
      const entries = parseAtomEntries(xml)
      return { success: true, data: entries }
    } catch (err) {
      clearTimeout(timeout)
      if (err instanceof Error && err.name === 'AbortError') {
        return { success: false, error: 'arXiv API request timed out after 15 seconds' }
      }
      return { success: false, error: err instanceof Error ? err.message : 'arXiv search failed' }
    }
  },
}

// ---- DOI Lookup (Crossref) ----

interface CrossrefAuthor {
  family?: string
  given?: string
}

interface CrossrefMessage {
  title?: string[]
  author?: CrossrefAuthor[]
  'date-parts'?: number[][]
  'published'?: { 'date-parts'?: number[][] }
  'published-print'?: { 'date-parts'?: number[][] }
  'published-online'?: { 'date-parts'?: number[][] }
  'container-title'?: string[]
  DOI?: string
}

interface CrossrefResponse {
  message?: CrossrefMessage
}

const doiLookupTool: Tool = {
  name: 'doi_lookup',
  description: 'Resolve a DOI to full citation metadata using the Crossref API.',
  usage: 'Resolve a DOI to full citation metadata. Free, no API key needed.',
  returns: '{ title, authors, published, journal?, doi }',
  parameters: {
    type: 'object',
    properties: {
      doi: { type: 'string', description: 'The DOI to resolve, e.g. "10.1145/3442188.3445922"' },
    },
    required: ['doi'],
  },
  execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
    const doi = params.doi as string | undefined
    if (!doi) return { success: false, error: '"doi" is required' }

    const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`

    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Samsinn/1.0 (mailto:samsinn@example.com)' },
      })
      if (!response.ok) {
        return { success: false, error: `Crossref API error: ${response.status} ${response.statusText}` }
      }
      const json = await response.json() as CrossrefResponse
      const msg = json.message
      if (!msg) return { success: false, error: 'No message in Crossref response' }

      const title = msg.title?.[0] ?? ''

      const authors = (msg.author ?? []).map(a => ({
        family: a.family ?? '',
        given: a.given ?? '',
      }))

      // Find the best available date-parts
      const dateParts =
        msg['published']?.['date-parts']?.[0] ??
        msg['published-print']?.['date-parts']?.[0] ??
        msg['published-online']?.['date-parts']?.[0] ??
        null

      const published = dateParts ? dateParts.join('-') : null

      const journal = msg['container-title']?.[0] ?? null

      return {
        success: true,
        data: {
          title,
          authors,
          published,
          journal,
          doi: msg.DOI ?? doi,
        },
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'DOI lookup failed' }
    }
  },
}

// ---- Semantic Scholar ----

interface S2Paper {
  title?: string
  authors?: Array<{ name?: string }>
  year?: number
  abstract?: string
  citationCount?: number
  tldr?: { text?: string }
  externalIds?: { DOI?: string }
}

interface S2Response {
  data?: S2Paper[]
}

const semanticScholarTool: Tool = {
  name: 'semantic_scholar',
  description: 'Search academic papers via Semantic Scholar with citation counts and AI summaries.',
  usage: 'Search academic papers with citation counts and AI-generated summaries (tldr). Broader than arXiv — covers all fields.',
  returns: 'Array of { title, authors, year, abstract, citationCount, tldr?, doi? }',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query for academic papers' },
      limit: { type: 'number', description: 'Maximum number of results to return (default 5)' },
    },
    required: ['query'],
  },
  execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
    const query = params.query as string | undefined
    if (!query) return { success: false, error: '"query" is required' }
    const limit = typeof params.limit === 'number' ? params.limit : 5

    const fields = 'title,authors,year,abstract,citationCount,tldr,externalIds'
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${limit}&fields=${fields}`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Samsinn/1.0' },
      })
      clearTimeout(timeout)
      if (!response.ok) {
        return { success: false, error: `Semantic Scholar API error: ${response.status} ${response.statusText}` }
      }
      const json = await response.json() as S2Response
      const papers = json.data ?? []

      const results = papers.map(p => ({
        title: p.title ?? '',
        authors: (p.authors ?? []).map(a => a.name ?? '').filter(n => n.length > 0),
        year: p.year ?? null,
        abstract: p.abstract ?? null,
        citationCount: p.citationCount ?? 0,
        tldr: p.tldr?.text ?? null,
        doi: p.externalIds?.DOI ?? null,
      }))

      return { success: true, data: results }
    } catch (err) {
      clearTimeout(timeout)
      if (err instanceof Error && err.name === 'AbortError') {
        return { success: false, error: 'Semantic Scholar API request timed out after 15 seconds' }
      }
      return { success: false, error: err instanceof Error ? err.message : 'Semantic Scholar search failed' }
    }
  },
}

export default [arxivSearchTool, doiLookupTool, semanticScholarTool]
