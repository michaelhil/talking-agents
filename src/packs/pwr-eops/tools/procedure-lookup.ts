// procedure_lookup — fetch a Westinghouse PWR EOP from the samsinn-wikis
// pwr-eops wiki, parse procmd, render a ready-to-paste markdown reply OR
// a structured JSON shape for agents that reason over the procedure.
//
// Fetch policy: fresh from raw.githubusercontent.com on every "first" call,
// with a process-level 5-minute in-memory buffer for repeats.

import type { Tool, ToolResult } from '../../../core/types/tool.ts'
import type { WikiSourceBinding } from '../../types.ts'
import { createWikiSource, extractProcedureIds, type WikiSource, type WikiManifest } from '../../../wikis/wiki-fetcher.ts'
import { parseProcedure } from '../procmd/parser.ts'
import type { ParsedProcedure, ParsedStep } from '../procmd/parser.ts'
import { renderProcedure, renderIndex } from '../procmd/renderer.ts'

interface PwrEopsToolDeps {
  readonly source: WikiSource
  readonly wikiName: string
  readonly wikiHomepage: string
  /**
   * Optional telemetry sink. One call per tool invocation. Default is a
   * stderr JSONL line tagged `procedure_lookup_telemetry` so an operator
   * can `tail -F` the process log and see usage. When the broader
   * ToolContext.logEvent hook lands (planned), bootstrap will pass a real
   * sink-bound callback here.
   */
  readonly telemetry?: (event: ProcedureLookupTelemetry) => void
}

export interface ProcedureLookupTelemetry {
  readonly tool: 'procedure_lookup'
  readonly ts: string
  readonly callerId: string
  readonly callerName: string
  readonly id: string | null
  readonly format: 'markdown' | 'json'
  readonly mode: 'full' | 'summary'
  readonly step: string | null
  readonly success: boolean
  readonly durationMs: number
  readonly indexSource: 'manifest' | 'regex' | 'none'
  readonly parseWarnings: number
  readonly errorClass?: 'unknown-id' | 'unknown-step' | 'fetch-failed' | 'parse-failed' | 'index-failed'
}

const defaultTelemetry = (event: ProcedureLookupTelemetry): void => {
  // Single stderr line, JSON. Operators tail; samsinn-side aggregator can
  // grep for `procedure_lookup_telemetry`. No PII; no content; just
  // ids, durations, and classification of outcome.
  try {
    console.error('procedure_lookup_telemetry ' + JSON.stringify(event))
  } catch { /* never crash a tool over a log line */ }
}

interface IndexCache {
  ids: ReadonlyArray<string>
  manifest: WikiManifest | null
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

const renderStepFragment = (parsed: ParsedProcedure, step: ParsedStep, citationUrl: string): string => {
  const parts: string[] = []
  parts.push(`### ${parsed.frontmatter.procedureId} step ${step.label}. ${step.title || step.id} \`[${step.id}]\``)
  if (step.checks.length > 0) parts.push('**Check:**', step.checks.map(c => `  - ${c}`).join('\n'))
  if (step.actions.length > 0) parts.push('**Action:**', step.actions.map(a => `  - ${a}`).join('\n'))
  for (const w of step.withins) parts.push(`> ⏱️ **Within:** ${w}`)
  for (const c of step.cautions) parts.push(`> ⚠️ **Caution:** ${c}`)
  for (const n of step.notes) parts.push(`> ℹ️ **Note:** ${n}`)
  if (step.branches.length > 0) {
    parts.push('**Branches:**')
    const lines: string[] = []
    for (const b of step.branches) {
      const t = b.target.kind === 'intra' ? `→ \`#${b.target.stepId}\``
        : b.target.kind === 'inter' ? `→ [${b.target.procedureId}]`
        : `→ ${b.target.text}`
      lines.push(`  - ${b.condition} ${t}`)
      if (b.because) lines.push(`    _because:_ ${b.because}`)
      if (b.against) lines.push(`    _against:_ ${b.against}`)
    }
    parts.push(lines.join('\n'))
  }
  parts.push(`\n---\nFrom: [${parsed.frontmatter.procedureId} — ${parsed.frontmatter.title}](${citationUrl})`)
  return parts.join('\n\n')
}

const renderSummaryFragment = (parsed: ParsedProcedure, citationUrl: string): string => {
  const fm = parsed.frontmatter
  const lines: string[] = []
  lines.push(`## ${fm.procedureId} — ${fm.title} (summary)`)
  const meta: string[] = []
  if (fm.profile) meta.push(`Profile: ${fm.profile}`)
  if (fm.appliesTo) meta.push(`Applies to: ${fm.appliesTo}`)
  if (fm.category) meta.push(`Category: ${fm.category}`)
  if (meta.length > 0) lines.push(`*${meta.join(' · ')}*`)
  if (fm.entryTriggers.length > 0) lines.push(`**Entry triggers:** ${fm.entryTriggers.map(t => `\`${t}\``).join(', ')}`)
  if (fm.csfsMonitored.length > 0) lines.push(`**CSFs monitored:** ${fm.csfsMonitored.join(', ')}`)
  if (parsed.csfChannels.length > 0) lines.push(`**Concurrent CSF channels:** ${parsed.csfChannels.join(', ')}`)
  if (parsed.preamble) lines.push(parsed.preamble)
  lines.push(`**Steps (${parsed.steps.length}):** ${parsed.steps.map(s => `\`${s.id}\``).join(' → ')}`)
  if (parsed.tagDefinitions.length > 0) lines.push(`**Tag definitions:** ${parsed.tagDefinitions.length} (request full mode for details).`)
  lines.push(`\nSource: [${fm.procedureId}](${citationUrl})`)
  return lines.join('\n\n')
}

const buildTool = (deps: PwrEopsToolDeps): Tool => {
  let indexCache: IndexCache | null = null

  const refreshIndex = async (): Promise<IndexCache> => {
    const manifest = await deps.source.fetchManifest()
    if (manifest && manifest.procedures.length > 0) {
      const ids = manifest.procedures.map(p => p.id)
      return { ids, manifest, fetchedAt: Date.now() }
    }
    const raw = await deps.source.fetchIndex()
    return { ids: extractProcedureIds(raw), manifest: null, fetchedAt: Date.now() }
  }

  const getIndex = async (): Promise<{ ids: ReadonlyArray<string>; source: 'manifest' | 'regex' }> => {
    const now = Date.now()
    if (!indexCache || now - indexCache.fetchedAt >= INDEX_TTL_MS) {
      indexCache = await refreshIndex()
    }
    return { ids: indexCache.ids, source: indexCache.manifest ? 'manifest' : 'regex' }
  }

  return {
    name: 'procedure_lookup',
    description:
      'Fetches an emergency operating procedure (EOP) from the pwr-eops wiki. ' +
      'Default returns a complete, ready-to-paste markdown response — step list, mermaid flowchart, source citation. ' +
      'Paste the markdown `data` verbatim into your reply unless you set `format: "json"`, in which case `data` is structured and is for your own reasoning, not for pasting. ' +
      'Call with no `id` to list available procedures.',
    usage:
      'Pass `id` (e.g. "E-0", "ECA-0.0", "FR-S.1"). ' +
      'Optional: `format: "json"` returns the parsed shape for reasoning; `step: "<step-id>"` returns only that step; `mode: "summary"` returns frontmatter + entry conditions + step-id list only. ' +
      'Omit `id` to get the index. Cached ~5 min after first fetch.',
    returns: 'A markdown string (default) or a JSON object (when `format: "json"`).',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Procedure id (case-sensitive — canonical ids like E-0, ECA-0.0, FR-S.1). Omit to list available procedures.',
        },
        format: {
          type: 'string',
          enum: ['markdown', 'json'],
          description: 'Output shape. "markdown" (default) is paste-ready prose + mermaid; "json" returns the structured ParsedProcedure for agent reasoning.',
        },
        step: {
          type: 'string',
          description: 'Optional step id (kebab-case, e.g. "verify-reactor-trip"). Returns only that step. Combine with `format: "json"` for the structured object.',
        },
        mode: {
          type: 'string',
          enum: ['full', 'summary'],
          description: 'Optional output mode. "summary" returns frontmatter, CSF channels, entry triggers, and step-id list — no step bodies. Ignored when `step` is set.',
        },
      },
      additionalProperties: false,
    },
    execute: async (params, context): Promise<ToolResult> => {
      const t0 = Date.now()
      const rawId = typeof params.id === 'string' ? params.id.trim() : ''
      const format = params.format === 'json' ? 'json' : 'markdown'
      const mode = params.mode === 'summary' ? 'summary' : 'full'
      const stepId = typeof params.step === 'string' ? params.step.trim() : ''
      let indexSource: 'manifest' | 'regex' | 'none' = 'none'
      let parseWarnings = 0
      const emit = deps.telemetry ?? defaultTelemetry
      const fire = (success: boolean, errorClass?: ProcedureLookupTelemetry['errorClass']): void => {
        emit({
          tool: 'procedure_lookup',
          ts: new Date().toISOString(),
          callerId: context.callerId,
          callerName: context.callerName,
          id: rawId || null,
          format,
          mode,
          step: stepId || null,
          success,
          durationMs: Date.now() - t0,
          indexSource,
          parseWarnings,
          ...(errorClass ? { errorClass } : {}),
        })
      }

      if (!rawId) {
        try {
          const idx = await getIndex()
          indexSource = idx.source
          if (format === 'json') {
            fire(true)
            return { success: true, data: { kind: 'index', wikiName: deps.wikiName, wikiHomepage: deps.wikiHomepage, ids: idx.ids } }
          }
          fire(true)
          return { success: true, data: renderIndex(idx.ids, deps.wikiName, deps.wikiHomepage) }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          fire(false, 'index-failed')
          return { success: false, error: `Could not load procedure index from ${deps.wikiName}: ${msg}` }
        }
      }

      let ids: ReadonlyArray<string>
      try {
        const idx = await getIndex()
        ids = idx.ids
        indexSource = idx.source
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        fire(false, 'index-failed')
        return { success: false, error: `Could not validate procedure id "${rawId}" — index fetch failed: ${msg}. Try again in a minute.` }
      }
      if (!ids.includes(rawId)) {
        const suggestions = fuzzyMatch(rawId, ids)
        const hint = suggestions.length > 0
          ? ` Did you mean: ${suggestions.join(', ')}?`
          : ` Available ids: ${ids.slice(0, 10).join(', ')}${ids.length > 10 ? `, ... (${ids.length} total)` : ''}.`
        fire(false, 'unknown-id')
        return { success: false, error: `Procedure "${rawId}" not found in ${deps.wikiName}.${hint}` }
      }

      let raw: string
      try {
        raw = await deps.source.fetchProcedure(rawId)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        fire(false, 'fetch-failed')
        return { success: false, error: `Could not fetch procedure "${rawId}" from GitHub: ${msg}. Try again in a minute.` }
      }

      const parsed = parseProcedure(raw)
      if ('error' in parsed) {
        if (format === 'json') {
          fire(false, 'parse-failed')
          return { success: false, error: `Could not parse "${rawId}" as procmd: ${parsed.error}` }
        }
        fire(true, 'parse-failed')  // raw fallback IS a success from the user's POV
        return {
          success: true,
          data: `> ⚠️ Could not parse procedure as procmd: ${parsed.error}. Showing raw source.\n\n${raw}\n\nSource: [${rawId}](${deps.source.citationUrl(rawId)})`,
        }
      }
      parseWarnings = parsed.warnings.length

      if (stepId) {
        const step = parsed.steps.find(s => s.id === stepId)
        if (!step) {
          const stepIds = parsed.steps.map(s => s.id)
          const hints = fuzzyMatch(stepId, stepIds)
          const hint = hints.length > 0 ? ` Did you mean: ${hints.join(', ')}?` : ` Available step ids: ${stepIds.slice(0, 8).join(', ')}${stepIds.length > 8 ? `, ...` : ''}.`
          fire(false, 'unknown-step')
          return { success: false, error: `Step "${stepId}" not found in ${rawId}.${hint}` }
        }
        fire(true)
        if (format === 'json') {
          return { success: true, data: { kind: 'step', procedureId: rawId, step, citationUrl: deps.source.citationUrl(rawId) } }
        }
        return { success: true, data: renderStepFragment(parsed, step, deps.source.citationUrl(rawId)) }
      }

      if (mode === 'summary') {
        fire(true)
        if (format === 'json') {
          return { success: true, data: {
            kind: 'summary',
            procedureId: parsed.frontmatter.procedureId,
            title: parsed.frontmatter.title,
            profile: parsed.frontmatter.profile,
            appliesTo: parsed.frontmatter.appliesTo,
            category: parsed.frontmatter.category,
            csfsMonitored: parsed.frontmatter.csfsMonitored,
            entryTriggers: parsed.frontmatter.entryTriggers,
            csfChannels: parsed.csfChannels,
            stepIds: parsed.steps.map(s => s.id),
            tagDefinitionCount: parsed.tagDefinitions.length,
            citationUrl: deps.source.citationUrl(rawId),
          } }
        }
        return { success: true, data: renderSummaryFragment(parsed, deps.source.citationUrl(rawId)) }
      }
      fire(true)

      if (format === 'json') {
        return { success: true, data: {
          kind: 'procedure',
          procedureId: rawId,
          parsed,
          citationUrl: deps.source.citationUrl(rawId),
        } }
      }
      const rendered = renderProcedure(parsed, (procId) => deps.source.citationUrl(procId))
      return { success: true, data: rendered.markdown }
    },
  }
}

export const createProcedureLookupTool = (
  binding: WikiSourceBinding,
  wikiName: string,
  wikiHomepage: string,
  telemetry?: (event: ProcedureLookupTelemetry) => void,
): Tool => buildTool({
  source: createWikiSource(binding),
  wikiName,
  wikiHomepage,
  ...(telemetry ? { telemetry } : {}),
})
