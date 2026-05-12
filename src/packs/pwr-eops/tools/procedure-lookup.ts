// procedure_lookup — fetch a Westinghouse PWR EOP from the samsinn-wikis
// pwr-eops wiki, parse procmd, render a ready-to-paste markdown reply.
//
// Contract: the tool returns a single markdown string (`data`). The agent
// pastes the string verbatim into chat — no composition, no rewriting,
// no citation substitution. Same shape as norway_platforms / vatsim_arrivals.
//
// Fetch policy: fresh from raw.githubusercontent.com on every "first" call,
// with a process-level 5-minute in-memory buffer for repeats. No disk
// cache, no Tree API, no GitHub auth.

import type { Tool, ToolResult } from '../../../core/types/tool.ts'
import type { WikiSourceBinding } from '../../types.ts'
import { createWikiSource, extractProcedureIds, type WikiSource } from '../../../wikis/wiki-fetcher.ts'
import { parseProcedure } from '../procmd/parser.ts'
import { renderProcedure, renderIndex } from '../procmd/renderer.ts'

interface PwrEopsToolDeps {
  readonly source: WikiSource
  readonly wikiName: string
  readonly wikiHomepage: string
}

// Lazy index cache — process-level, refreshed on TTL boundary by the
// wiki-fetcher itself. We hold the parsed id list separately so each
// call doesn't re-extract from the raw markdown.
interface IndexCache {
  ids: ReadonlyArray<string>
  fetchedAt: number
}
const INDEX_TTL_MS = 5 * 60 * 1000

const fuzzyMatch = (query: string, candidates: ReadonlyArray<string>): ReadonlyArray<string> => {
  const q = query.toLowerCase().trim()
  if (!q) return []
  const out: Array<{ id: string; score: number }> = []
  for (const id of candidates) {
    const lc = id.toLowerCase()
    if (lc === q) return [id]
    if (lc.startsWith(q)) out.push({ id, score: 3 })
    else if (lc.includes(q)) out.push({ id, score: 2 })
    else if (q.includes(lc)) out.push({ id, score: 1 })
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 5).map(x => x.id)
}

const buildTool = (deps: PwrEopsToolDeps): Tool => {
  let indexCache: IndexCache | null = null

  const getIndex = async (): Promise<ReadonlyArray<string>> => {
    const now = Date.now()
    if (indexCache && now - indexCache.fetchedAt < INDEX_TTL_MS) return indexCache.ids
    const raw = await deps.source.fetchIndex()
    const ids = extractProcedureIds(raw)
    indexCache = { ids, fetchedAt: now }
    return ids
  }

  return {
    name: 'procedure_lookup',
    description:
      'Fetches an emergency operating procedure (EOP) from the pwr-eops wiki and returns a complete, ready-to-paste markdown response — step list, mermaid flowchart, source citation. ' +
      'Paste the returned `data` string verbatim into your reply. Do not summarize, rewrite, or substitute the source URL. ' +
      'Call with no `id` to list available procedures.',
    usage:
      'Pass `id` (e.g. "E-0", "ECA-0.0", "FR-S.1"). Omit `id` to get the index of available procedures. Procedures are pulled fresh from GitHub on each first call; repeats within ~5 min are cached.',
    returns: 'A markdown string ready to paste into chat.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Procedure id (case-sensitive — wiki uses canonical ids like E-0, ECA-0.0, FR-S.1). Omit to list available procedures.',
        },
      },
      additionalProperties: false,
    },
    execute: async (params): Promise<ToolResult> => {
      const rawId = typeof params.id === 'string' ? params.id.trim() : ''

      // No id → return the index
      if (!rawId) {
        try {
          const ids = await getIndex()
          return { success: true, data: renderIndex(ids, deps.wikiName, deps.wikiHomepage) }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { success: false, error: `Could not load procedure index from ${deps.wikiName}: ${msg}` }
        }
      }

      // Validate id against the known set (fetched fresh if cache cold)
      let ids: ReadonlyArray<string>
      try {
        ids = await getIndex()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { success: false, error: `Could not validate procedure id "${rawId}" — index fetch failed: ${msg}. Try again in a minute.` }
      }
      if (!ids.includes(rawId)) {
        const suggestions = fuzzyMatch(rawId, ids)
        const hint = suggestions.length > 0
          ? ` Did you mean: ${suggestions.join(', ')}?`
          : ` Available ids: ${ids.slice(0, 10).join(', ')}${ids.length > 10 ? `, ... (${ids.length} total)` : ''}.`
        return { success: false, error: `Procedure "${rawId}" not found in ${deps.wikiName}.${hint}` }
      }

      // Fetch the procedure markdown (buffered)
      let raw: string
      try {
        raw = await deps.source.fetchProcedure(rawId)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { success: false, error: `Could not fetch procedure "${rawId}" from GitHub: ${msg}. Try again in a minute.` }
      }

      // Parse + render
      const parsed = parseProcedure(raw)
      if ('error' in parsed) {
        // Parser failed — fall back to raw markdown with a visible "raw" notice
        // (degraded but never empty; user can see the procedure body).
        return {
          success: true,
          data: `> ⚠️ Could not parse procedure as procmd: ${parsed.error}. Showing raw source.\n\n${raw}\n\nSource: [${rawId}](${deps.source.citationUrl(rawId)})`,
        }
      }

      const rendered = renderProcedure(parsed, (procId) => deps.source.citationUrl(procId))
      return { success: true, data: rendered.markdown }
    },
  }
}

// Factory: takes the binding from the pack manifest, returns the tool.
export const createProcedureLookupTool = (
  binding: WikiSourceBinding,
  wikiName: string,
  wikiHomepage: string,
): Tool => buildTool({
  source: createWikiSource(binding),
  wikiName,
  wikiHomepage,
})
