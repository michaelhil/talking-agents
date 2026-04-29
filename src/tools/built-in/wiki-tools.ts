// ============================================================================
// Built-in wiki tools — wiki_list, wiki_search, wiki_get_page.
//
// These read from a WikiRegistry that the operator has populated via the
// admin surface. The agent picks which wiki to query via the wikiId argument
// (the catalog injected into the agent's context tells it what's available).
//
// All tools are read-only. WikiError is caught and returned as
// { success: false, error } so a transport failure does not crash the turn.
// ============================================================================

import type { Tool, ToolResult } from '../../core/types/tool.ts'
import type { WikiRegistry } from '../../wiki/registry.ts'
import { isWikiError } from '../../wiki/errors.ts'

const formatError = (err: unknown): string => {
  if (isWikiError(err)) return `wiki ${err.kind}: ${err.message}`
  return err instanceof Error ? err.message : String(err)
}

export const createWikiListTool = (registry: WikiRegistry): Tool => ({
  name: 'wiki_list',
  description: 'Lists all wikis available to this room/agent with page counts and last-warm timestamps.',
  usage: 'Use to discover which knowledge wikis are available before searching or fetching pages. The wiki id is what other wiki_* tools take as wikiId.',
  returns: 'Array of { id, displayName, pageCount, lastWarmAt? }.',
  parameters: { type: 'object', properties: {} },
  execute: async (): Promise<ToolResult> => ({
    success: true,
    data: registry.list(),
  }),
})

export const createWikiSearchTool = (registry: WikiRegistry): Tool => ({
  name: 'wiki_search',
  description: 'Searches wiki pages by title/slug/body/tag. Returns ranked snippets you can then fetch in full with wiki_get_page.',
  usage: 'Use BEFORE answering a domain question to find vetted source material. Pass wikiId to scope to one wiki, or omit to search all available. Cite hits using their slug as [[slug]] in your answer.',
  returns: 'Array of { wikiId, slug, title, type?, tags?, confidence?, snippet, score }.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query — keywords or phrase' },
      wikiId: { type: 'string', description: 'Restrict to one wiki (from wiki_list). Optional.' },
      type: { type: 'string', description: 'Filter by frontmatter type (e.g. "scenario", "concept"). Optional.' },
      tag: { type: 'string', description: 'Filter by tag. Optional.' },
      limit: { type: 'number', description: 'Max results (default 10).' },
    },
    required: ['query'],
  },
  execute: async (params): Promise<ToolResult> => {
    const query = typeof params.query === 'string' ? params.query : ''
    const wikiId = typeof params.wikiId === 'string' ? params.wikiId : undefined
    const type = typeof params.type === 'string' ? params.type : undefined
    const tag = typeof params.tag === 'string' ? params.tag : undefined
    const limit = typeof params.limit === 'number' && params.limit > 0 ? params.limit : undefined
    // Existence check via getState (replaces dropped hasWiki). Wikis are
    // expected to be reconciled before agents call these tools — see
    // resolveActiveWikis in REST handlers and the boot path.
    if (wikiId && !registry.getState(wikiId)) {
      return { success: false, error: `unknown wikiId: ${wikiId}` }
    }
    try {
      const hits = registry.search(query, {
        ...(wikiId !== undefined ? { wikiId } : {}),
        ...(type !== undefined ? { type } : {}),
        ...(tag !== undefined ? { tag } : {}),
        ...(limit !== undefined ? { limit } : {}),
      })
      return { success: true, data: hits }
    } catch (err) {
      return { success: false, error: formatError(err) }
    }
  },
})

export const createWikiGetPageTool = (registry: WikiRegistry): Tool => ({
  name: 'wiki_get_page',
  description: 'Fetches the full markdown of one wiki page by slug. Returns frontmatter + body. GROUND your answer on the returned text — do not rephrase from memory.',
  usage: 'Call after wiki_search returns a relevant slug, or when the user references a [[slug]] explicitly. Always cite the page you used in your answer.',
  returns: 'Object with { wikiId, slug, path, frontmatter, body, wikilinks }.',
  parameters: {
    type: 'object',
    properties: {
      wikiId: { type: 'string', description: 'Wiki id from wiki_list / wiki_search.' },
      slug: { type: 'string', description: 'Page slug (filename without .md).' },
    },
    required: ['wikiId', 'slug'],
  },
  execute: async (params): Promise<ToolResult> => {
    const wikiId = typeof params.wikiId === 'string' ? params.wikiId : ''
    const slug = typeof params.slug === 'string' ? params.slug : ''
    if (!wikiId || !slug) return { success: false, error: 'wikiId and slug are required' }
    if (!registry.getState(wikiId)) return { success: false, error: `unknown wikiId: ${wikiId}` }
    try {
      const page = await registry.getPage(wikiId, slug)
      if (!page) return { success: false, error: `page not found: ${slug}` }
      return {
        success: true,
        data: {
          wikiId, slug: page.slug, path: page.path,
          frontmatter: page.frontmatter,
          body: page.body,
          wikilinks: page.wikilinks,
        },
      }
    } catch (err) {
      return { success: false, error: formatError(err) }
    }
  },
})

export const createWikiTools = (registry: WikiRegistry): ReadonlyArray<Tool> => [
  createWikiListTool(registry),
  createWikiSearchTool(registry),
  createWikiGetPageTool(registry),
]
