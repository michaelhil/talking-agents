// ============================================================================
// Web Tools — Web search and URL fetching.
//
// web_search requires BRAVE_API_KEY or SERPER_API_KEY environment variable.
// fetch_url strips HTML and returns clean text content.
// ============================================================================

import type { Tool, ToolResult } from '../src/core/types.ts'

interface SearchResult {
  title: string
  url: string
  snippet: string
}

const braveSearch = async (query: string, count: number): Promise<SearchResult[]> => {
  const apiKey = process.env.BRAVE_API_KEY ?? ''
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`
  const response = await fetch(url, {
    headers: {
      'X-Subscription-Token': apiKey,
      'Accept': 'application/json',
    },
  })
  if (!response.ok) {
    throw new Error(`Brave Search API error: ${response.status} ${response.statusText}`)
  }
  const data = await response.json() as Record<string, unknown>
  const webResults = data.web as { results?: Array<{ title?: string; url?: string; description?: string }> } | undefined
  const results = webResults?.results ?? []
  return results.map(r => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.description ?? '',
  }))
}

const serperSearch = async (query: string, count: number): Promise<SearchResult[]> => {
  const apiKey = process.env.SERPER_API_KEY ?? ''
  const response = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ q: query, num: count }),
  })
  if (!response.ok) {
    throw new Error(`Serper API error: ${response.status} ${response.statusText}`)
  }
  const data = await response.json() as Record<string, unknown>
  const organic = data.organic as Array<{ title?: string; link?: string; snippet?: string }> | undefined
  const results = organic ?? []
  return results.map(r => ({
    title: r.title ?? '',
    url: r.link ?? '',
    snippet: r.snippet ?? '',
  }))
}

const webSearchTool: Tool = {
  name: 'web_search',
  description: 'Search the web for current information using Brave or Serper.',
  usage: 'Search for current information. Requires BRAVE_API_KEY or SERPER_API_KEY env var. Follow with fetch_url to read the full content of a result.',
  returns: 'Array of { title, url, snippet }',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
      count: { type: 'number', description: 'Number of results to return (default 5)' },
    },
    required: ['query'],
  },
  execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
    const query = params.query as string | undefined
    if (!query) return { success: false, error: '"query" is required' }
    const count = typeof params.count === 'number' ? params.count : 5

    const hasBrave = !!process.env.BRAVE_API_KEY
    const hasSerper = !!process.env.SERPER_API_KEY

    if (!hasBrave && !hasSerper) {
      return { success: false, error: 'web_search requires BRAVE_API_KEY or SERPER_API_KEY environment variable' }
    }

    try {
      const results = hasBrave
        ? await braveSearch(query, count)
        : await serperSearch(query, count)
      return { success: true, data: results }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Search failed' }
    }
  },
}

const stripHtml = (html: string): string => {
  // Remove <script> blocks
  let text = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  // Remove <style> blocks
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
  // Strip all remaining HTML tags
  text = text.replace(/<[^>]+>/g, ' ')
  // Normalize whitespace
  text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  return text
}

const extractTitle = (html: string): string => {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!match || !match[1]) return ''
  return match[1].replace(/\s+/g, ' ').trim()
}

const fetchUrlTool: Tool = {
  name: 'fetch_url',
  description: 'Fetch a web page and return its cleaned text content.',
  usage: 'Retrieve and read the text content of a web page. Use after web_search to read full articles.',
  returns: '{ title, text, url, chars: number }',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch' },
    },
    required: ['url'],
  },
  execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
    const url = params.url as string | undefined
    if (!url) return { success: false, error: '"url" is required' }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Samsinn/1.0 (web reader)' },
      })
      clearTimeout(timeout)

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}: ${response.statusText}` }
      }

      const html = await response.text()
      const title = extractTitle(html)
      const text = stripHtml(html)

      return {
        success: true,
        data: { title, text, url, chars: text.length },
      }
    } catch (err) {
      clearTimeout(timeout)
      if (err instanceof Error && err.name === 'AbortError') {
        return { success: false, error: `Request timed out after 10 seconds: ${url}` }
      }
      return { success: false, error: err instanceof Error ? err.message : 'Fetch failed' }
    }
  },
}

export default [webSearchTool, fetchUrlTool]
