// ============================================================================
// Wiki catalog builder — produces the WIKIS section text injected into agent
// system prompts. For each bound wiki it includes a one-line header, the
// first ~MAX_INDEX_CHARS of index.md, and (if present) the first ~MAX_SCOPE_CHARS
// of scope.md. Truncation is signaled with a marker so the operator knows.
//
// Header tells the agent how to use the catalog: cite via [[slug]], call
// wiki_get_page for full content. This is the "medium grounding" contract.
// ============================================================================

import type { WikiRegistry } from './registry.ts'

export interface CatalogOptions {
  readonly maxIndexChars?: number
  readonly maxScopeChars?: number
}

const DEFAULT_OPTS: Required<CatalogOptions> = {
  maxIndexChars: 4000,
  maxScopeChars: 1500,
}

const truncate = (s: string, max: number): { text: string; truncated: boolean } => {
  if (s.length <= max) return { text: s, truncated: false }
  return { text: s.slice(0, max).trimEnd() + '\n…[truncated]', truncated: true }
}

export interface BuildCatalogResult {
  readonly text: string
  readonly truncatedWikis: ReadonlyArray<string>   // wiki ids whose content was truncated
}

const PREAMBLE = [
  'Vetted knowledge wikis are available below. Each entry shows its index and scope.',
  'GROUND your answers on these wikis when relevant. To use a wiki:',
  '  1. wiki_search(query, wikiId?) — find candidate slugs',
  '  2. wiki_get_page(wikiId, slug) — fetch the full page',
  '  3. Cite slugs as [[slug]] in your response so the user can follow up.',
  'If the wikis cover the question, prefer their content over your own knowledge.',
].join('\n')

export const buildWikisCatalog = (
  registry: WikiRegistry,
  wikiIds: ReadonlyArray<string>,
  opts: CatalogOptions = {},
): BuildCatalogResult => {
  const o = { ...DEFAULT_OPTS, ...opts }
  if (wikiIds.length === 0) return { text: '', truncatedWikis: [] }

  const truncated: string[] = []
  const sections: string[] = [PREAMBLE]

  for (const id of wikiIds) {
    // Membership check via getState — returns undefined for ids the
    // registry doesn't know about. Replaces the dropped hasWiki.
    const state = registry.getState(id)
    if (!state) continue
    const lines: string[] = [`### Wiki: ${state.displayName} (id: ${id}, pages: ${state.pages.size})`]
    if (state.indexMd) {
      const t = truncate(state.indexMd, o.maxIndexChars)
      lines.push(`#### Index`, t.text)
      if (t.truncated) truncated.push(id)
    } else {
      lines.push(`(index not yet warmed — call wiki_search to discover pages, then wiki_get_page to fetch)`)
    }
    if (state.scopeMd) {
      const t = truncate(state.scopeMd, o.maxScopeChars)
      lines.push(`#### Scope`, t.text)
      if (t.truncated && !truncated.includes(id)) truncated.push(id)
    }
    sections.push(lines.join('\n'))
  }

  return { text: sections.join('\n\n'), truncatedWikis: truncated }
}
