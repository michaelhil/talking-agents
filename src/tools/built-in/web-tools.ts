// ============================================================================
// Web Tools — web_search, web_fetch, web_extract_json
//
// web_search   — search the web via Tavily, Brave, or Google CSE (requires API key)
// web_fetch    — fetch any URL, returns cleaned Markdown
// web_extract_json — fetch a JSON endpoint, optionally extract a nested path
//
// Registration:
//   web_fetch and web_extract_json are always included.
//   web_search is included only when a search provider is configured via env.
//   Provider precedence (first match wins):
//     TAVILY_API_KEY                       → Tavily (default — LLM-optimized,
//                                              free 1000 searches/month)
//     BRAVE_API_KEY                        → Brave Search
//     GOOGLE_CSE_API_KEY + GOOGLE_CSE_ID   → Google Custom Search
//
// Context budget:
//   All tools honour context.maxResultChars to pre-size their output so
//   the evaluation loop's truncation boundary is never hit mid-content.
// ============================================================================

import type { Tool, ToolContext, ToolResult } from '../../core/types/tool.ts'
import { htmlToMarkdown } from './html-to-md.ts'

// === Configuration ===

export interface WebToolsConfig {
  readonly tavilyApiKey?: string
  readonly braveApiKey?: string
  readonly googleApiKey?: string
  readonly googleCseId?: string
}

// === Constants ===

const DEFAULT_FETCH_TIMEOUT_MS = 15_000  // default; rename signals it's not a hard cap
const DEFAULT_MAX_CHARS = 8_000
const USER_AGENT = 'samsinn/1.0 (multi-agent research assistant)'

// === Internal helpers ===

const fetchWithTimeout = async (url: string, init?: RequestInit): Promise<Response> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEFAULT_FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)  // always clean up, even if AbortError fires
  }
}

const parseAndValidateUrl = (raw: string): { href: string } | { error: string } => {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { error: `URL must use http or https (got ${u.protocol.replace(':', '')})` }
    }
    return { href: u.href }  // normalised — handles encoded spaces, etc.
  } catch {
    return { error: 'Invalid URL format' }
  }
}

const handleHttpError = (status: number, url: string): ToolResult => {
  if (status === 401 || status === 403) {
    return { success: false, error: `HTTP ${status}: Access denied for ${url}. The page may require authentication.` }
  }
  if (status === 404 || status === 410) {
    return { success: false, error: `HTTP ${status}: Page not found — ${url}` }
  }
  if (status === 429) {
    return { success: false, error: `HTTP 429: Rate limited by ${url}. Try again in a few seconds.` }
  }
  if (status >= 500) {
    return { success: false, error: `HTTP ${status}: Server error from ${url}. Try again later.` }
  }
  return { success: false, error: `HTTP ${status} from ${url}` }
}

const truncateText = (text: string, maxChars: number): { content: string; truncated: boolean } => {
  const truncated = text.length > maxChars
  return {
    content: truncated ? `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} characters omitted]` : text,
    truncated,
  }
}

// === Search result type ===

interface SearchResult {
  readonly title: string
  readonly url: string
  readonly snippet: string
  readonly score?: number
  readonly publishedAt?: string
}

// === Tool: web_search ===

const buildTavilySearchTool = (apiKey: string): Tool => ({
  name: 'web_search',
  description: 'Searches the web (LLM-optimized via Tavily) and returns ranked results with cleaned content snippets and relevance scores.',
  usage: 'Use to find current information, discover sources, or research a topic when you do not already have a specific URL. Tavily returns LLM-ready snippets — for many questions you may not need to follow up with web_fetch. Use web_fetch only when the snippet is insufficient.',
  returns: '{ query, provider, results: Array<{ title, url, snippet, score?, publishedAt? }> }. results may be empty if nothing is found.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
      count: { type: 'number', description: 'Number of results to return (default 5, max 10)' },
      depth: { type: 'string', description: 'Search depth: "basic" (1 credit, default) or "advanced" (2 credits, deeper crawl)' },
    },
    required: ['query'],
  },
  execute: async (params, _context): Promise<ToolResult> => {
    const query = params.query as string
    const count = Math.min(Math.max(typeof params.count === 'number' ? params.count : 5, 1), 10)
    const searchDepth = params.depth === 'advanced' ? 'advanced' : 'basic'
    try {
      const res = await fetchWithTimeout('https://api.tavily.com/search', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          query,
          max_results: count,
          search_depth: searchDepth,
          include_answer: false,
        }),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        if (res.status === 401 || res.status === 403) {
          return { success: false, error: `Search API key rejected (HTTP ${res.status}). Check TAVILY_API_KEY. Body: ${body.slice(0, 200)}` }
        }
        if (res.status === 429) return { success: false, error: 'Search API rate limit exceeded (Tavily free tier is 1000/month). Try again later or upgrade.' }
        return { success: false, error: `Search API returned HTTP ${res.status}: ${body.slice(0, 200)}` }
      }
      const json = await res.json() as {
        results?: Array<{ title: string; url: string; content?: string; score?: number; published_date?: string }>
      }
      const results: SearchResult[] = (json.results ?? []).map(r => ({
        title: r.title,
        url: r.url,
        snippet: r.content ?? '',
        ...(typeof r.score === 'number' ? { score: r.score } : {}),
        ...(r.published_date ? { publishedAt: r.published_date } : {}),
      }))
      return { success: true, data: { query, provider: 'tavily', results } }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return { success: false, error: 'Search request timed out after 15s' }
      return { success: false, error: `Search request failed: ${err instanceof Error ? err.message : 'unknown error'}` }
    }
  },
})

const buildBraveSearchTool = (apiKey: string): Tool => ({
  name: 'web_search',
  description: 'Searches the web and returns a ranked list of results (title, URL, snippet) for a query.',
  usage: 'Use to find current information, discover sources, or research a topic when you do not already have a specific URL. Use before web_fetch when you need to find relevant pages. Returns snippets only — call web_fetch to read the full content of a result.',
  returns: '{ query, provider, results: Array<{ title, url, snippet, publishedAt? }> }. results may be empty if nothing is found.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
      count: { type: 'number', description: 'Number of results to return (default 5, max 10)' },
    },
    required: ['query'],
  },
  execute: async (params, _context): Promise<ToolResult> => {
    const query = params.query as string
    const count = Math.min(Math.max(typeof params.count === 'number' ? params.count : 5, 1), 10)
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`
    try {
      const res = await fetchWithTimeout(url, {
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': apiKey,
        },
      })
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          return { success: false, error: `Search API key rejected (HTTP ${res.status}). Check BRAVE_API_KEY.` }
        }
        if (res.status === 429) return { success: false, error: 'Search API rate limit exceeded. Try again later.' }
        return { success: false, error: `Search API returned HTTP ${res.status}` }
      }
      const json = await res.json() as { web?: { results?: Array<{ title: string; url: string; description?: string; page_age?: string }> } }
      const results: SearchResult[] = (json.web?.results ?? []).map(r => ({
        title: r.title,
        url: r.url,
        snippet: r.description ?? '',
        ...(r.page_age ? { publishedAt: r.page_age } : {}),
      }))
      return { success: true, data: { query, provider: 'brave', results } }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return { success: false, error: 'Search request timed out after 15s' }
      return { success: false, error: `Search request failed: ${err instanceof Error ? err.message : 'unknown error'}` }
    }
  },
})

const buildGoogleSearchTool = (apiKey: string, cseId: string): Tool => ({
  name: 'web_search',
  description: 'Searches the web and returns a ranked list of results (title, URL, snippet) for a query.',
  usage: 'Use to find current information, discover sources, or research a topic when you do not already have a specific URL. Use before web_fetch when you need to find relevant pages. Returns snippets only — call web_fetch to read the full content of a result.',
  returns: '{ query, provider, results: Array<{ title, url, snippet }> }. results may be empty if nothing is found.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
      count: { type: 'number', description: 'Number of results to return (default 5, max 10)' },
    },
    required: ['query'],
  },
  execute: async (params, _context): Promise<ToolResult> => {
    const query = params.query as string
    const count = Math.min(Math.max(typeof params.count === 'number' ? params.count : 5, 1), 10)
    const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cseId}&q=${encodeURIComponent(query)}&num=${count}`
    try {
      const res = await fetchWithTimeout(url, { headers: { 'Accept': 'application/json' } })
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          return { success: false, error: `Search API key rejected (HTTP ${res.status}). Check GOOGLE_CSE_API_KEY and GOOGLE_CSE_ID.` }
        }
        if (res.status === 429) return { success: false, error: 'Search API rate limit exceeded. Try again later.' }
        return { success: false, error: `Search API returned HTTP ${res.status}` }
      }
      const json = await res.json() as { items?: Array<{ title: string; link: string; snippet?: string }> }
      // Google CSE returns items: undefined (not []) when there are no results
      const results: SearchResult[] = (json.items ?? []).map(r => ({
        title: r.title,
        url: r.link,
        snippet: r.snippet ?? '',
      }))
      return { success: true, data: { query, provider: 'google', results } }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return { success: false, error: 'Search request timed out after 15s' }
      return { success: false, error: `Search request failed: ${err instanceof Error ? err.message : 'unknown error'}` }
    }
  },
})

const tryCreateSearchTool = (config: WebToolsConfig): Tool | undefined => {
  // Precedence: Tavily (LLM-optimized default) → Brave → Google CSE.
  if (config.tavilyApiKey) return buildTavilySearchTool(config.tavilyApiKey)
  if (config.braveApiKey) return buildBraveSearchTool(config.braveApiKey)
  if (config.googleApiKey && config.googleCseId) return buildGoogleSearchTool(config.googleApiKey, config.googleCseId)
  return undefined
}

// === Tool: web_fetch ===

export const webFetchTool: Tool = {
  name: 'web_fetch',
  description: 'Fetches a URL and returns its content as clean Markdown text. Handles HTML pages, plain text, and JSON responses.',
  usage: 'Use to read the content of a specific web page, article, or document. Does not execute JavaScript — pages requiring JS rendering may return incomplete content. For JSON APIs where you need to extract a specific field, use web_extract_json instead.',
  returns: '{ url, title, content, charCount, truncated }. content is cleaned Markdown text.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Full URL to fetch (must use http or https)' },
      maxChars: { type: 'number', description: 'Max characters of content to return (default: agent context budget, max 32000)' },
    },
    required: ['url'],
  },
  execute: async (params, context: ToolContext): Promise<ToolResult> => {
    const parsed = parseAndValidateUrl(params.url as string)
    if ('error' in parsed) return { success: false, error: parsed.error }

    // Content limit: explicit param → context budget → fallback default
    const effectiveMaxChars = Math.min(
      typeof params.maxChars === 'number' ? params.maxChars : (context.maxResultChars ?? DEFAULT_MAX_CHARS),
      32_000,
    )

    let res: Response
    try {
      res = await fetchWithTimeout(parsed.href, { headers: { 'User-Agent': USER_AGENT } })
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return { success: false, error: `Request timed out after ${DEFAULT_FETCH_TIMEOUT_MS / 1000}s` }
      }
      return { success: false, error: `Fetch failed: ${err instanceof Error ? err.message : 'unknown error'}` }
    }

    if (!res.ok) return handleHttpError(res.status, parsed.href)

    const contentType = res.headers.get('content-type') ?? ''

    // Binary types — error immediately with informative message
    if (/^(image|video|audio)\//.test(contentType)) {
      return { success: false, error: `Cannot return binary content (${contentType}). This URL points to a media file, not a text document.` }
    }
    if (contentType.includes('application/pdf')) {
      return { success: false, error: 'PDF files are not supported. Try finding an HTML version of this document.' }
    }

    const rawText = await res.text()

    // HTML detection: content-type OR body sniffing (handles servers that omit Content-Type)
    const looksLikeHtml = contentType.includes('text/html')
      || contentType.includes('application/xhtml')
      || /^\s*<!doctype\s+html/i.test(rawText)
      || /^\s*<html/i.test(rawText)

    if (looksLikeHtml) {
      const result = htmlToMarkdown(rawText, effectiveMaxChars)
      return {
        success: true,
        data: {
          url: res.url,
          title: result.title,
          content: result.markdown,
          charCount: result.charCount,
          truncated: result.truncated,
        },
      }
    }

    if (contentType.includes('application/json')) {
      // Pretty-print JSON as text. For path extraction, use web_extract_json.
      let formatted: string
      try {
        formatted = JSON.stringify(JSON.parse(rawText), null, 2)
      } catch {
        formatted = rawText
      }
      const { content, truncated } = truncateText(formatted, effectiveMaxChars)
      return { success: true, data: { url: res.url, title: undefined, content, charCount: formatted.length, truncated } }
    }

    // Plain text, Markdown, CSV, or unknown text type
    const { content, truncated } = truncateText(rawText, effectiveMaxChars)
    return { success: true, data: { url: res.url, title: undefined, content, charCount: rawText.length, truncated } }
  },
}

// === Tool: web_extract_json ===

export const webExtractJsonTool: Tool = {
  name: 'web_extract_json',
  description: 'Fetches a URL that returns JSON and extracts the data. Optionally navigate to a nested field using dot notation.',
  usage: 'Use for REST APIs, data feeds, weather services, or any URL that returns application/json. Prefer over web_fetch for JSON endpoints — cleaner output, no HTML processing, extracts exactly the data you need. Use dot notation for path: "results.0.title" or "data.items".',
  returns: '{ url, data, truncated } where data is the parsed JSON or the value at the given path.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL of the JSON API endpoint' },
      path: { type: 'string', description: 'Dot-notation path to a nested value (e.g. "results.0.title"). Omit to return the whole response.' },
    },
    required: ['url'],
  },
  execute: async (params, context: ToolContext): Promise<ToolResult> => {
    const parsed = parseAndValidateUrl(params.url as string)
    if ('error' in parsed) return { success: false, error: parsed.error }

    let res: Response
    try {
      res = await fetchWithTimeout(parsed.href, {
        headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT },
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return { success: false, error: `Request timed out after ${DEFAULT_FETCH_TIMEOUT_MS / 1000}s` }
      }
      return { success: false, error: `Fetch failed: ${err instanceof Error ? err.message : 'unknown error'}` }
    }

    if (!res.ok) return handleHttpError(res.status, parsed.href)

    let json: unknown
    try {
      json = await res.json()
    } catch {
      const ct = res.headers.get('content-type') ?? 'unknown content-type'
      return { success: false, error: `Expected JSON but got ${ct}. The URL may require authentication or returned an error page.` }
    }

    // Path navigation — dot-separated segments, handles both objects and arrays.
    // Array indices are explicit integer coercion (not relying on string-key quirk).
    let extracted: unknown = json
    const pathStr = (params.path as string | undefined)?.trim()
    if (pathStr) {
      for (const segment of pathStr.split('.')) {
        if (extracted === null || extracted === undefined) {
          return { success: false, error: `Path "${pathStr}": reached null/undefined at segment "${segment}"` }
        }
        if (Array.isArray(extracted)) {
          const idx = Number(segment)
          if (!Number.isInteger(idx) || idx < 0 || idx >= extracted.length) {
            return { success: false, error: `Path "${pathStr}": index "${segment}" out of bounds (array length ${extracted.length})` }
          }
          extracted = extracted[idx]
        } else if (typeof extracted === 'object') {
          const next = (extracted as Record<string, unknown>)[segment]
          if (next === undefined) {
            return { success: false, error: `Path "${pathStr}": key "${segment}" does not exist` }
          }
          extracted = next
        } else {
          return { success: false, error: `Path "${pathStr}": cannot navigate into ${typeof extracted} at segment "${segment}"` }
        }
      }
    }

    const effectiveMaxChars = context.maxResultChars ?? DEFAULT_MAX_CHARS
    const serialised = JSON.stringify(extracted, null, 2)
    const truncated = serialised.length > effectiveMaxChars
    const data = truncated
      ? `${serialised.slice(0, effectiveMaxChars)}\n... [${serialised.length - effectiveMaxChars} characters omitted]`
      : extracted

    return { success: true, data: { url: res.url, data, truncated } }
  },
}

// === Factory ===

export const createWebTools = (config: WebToolsConfig): ReadonlyArray<Tool> => {
  const tools: Tool[] = [webFetchTool, webExtractJsonTool]
  const searchTool = tryCreateSearchTool(config)
  if (searchTool) tools.unshift(searchTool)
  return tools
}
