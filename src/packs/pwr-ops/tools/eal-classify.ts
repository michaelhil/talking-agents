// eal_classify — fetches the wiki-authored EAL rule table and classifies a
// scenario (or an inline state + injections) against NEI 99-01 emergency
// classes. Phase F.1.

import type { Tool, ToolResult } from '../../../core/types/tool.ts'
import type { WikiSourceBinding } from '../../types.ts'
import { createWikiSource, type WikiSource } from '../../../wikis/wiki-fetcher.ts'
import {
  classifyEal,
  parseScenario,
  projectScenarioTimeline,
  type EalRulesFile,
  type ScenarioInjection,
} from '../../../procmd-core/index.ts'

interface EalDeps {
  readonly source: WikiSource
  readonly wikiName: string
  readonly telemetry?: (event: EalTelemetry) => void
}

export interface EalTelemetry {
  readonly tool: 'eal_classify'
  readonly ts: string
  readonly callerId: string
  readonly callerName: string
  readonly scenarioId: string | null
  readonly highestClass: string | null
  readonly matchingIc: string | null
  readonly durationMs: number
  readonly errorClass?: 'no-rules' | 'unknown-scenario' | 'parse-failed' | 'bad-state'
}

const defaultTelemetry = (event: EalTelemetry): void => {
  try { console.error('eal_classify_telemetry ' + JSON.stringify(event)) } catch { /* never crash */ }
}

interface RulesCache {
  rules: EalRulesFile
  fetchedAt: number
}
const RULES_TTL_MS = 5 * 60 * 1000

const isStateMap = (v: unknown): v is Record<string, string | number | boolean> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  for (const val of Object.values(v as Record<string, unknown>)) {
    if (typeof val !== 'string' && typeof val !== 'number' && typeof val !== 'boolean') return false
  }
  return true
}

const isInjectionArray = (v: unknown): v is ScenarioInjection[] => {
  if (!Array.isArray(v)) return false
  for (const item of v) {
    if (!item || typeof item !== 'object') return false
    const i = item as Record<string, unknown>
    if (typeof i.tag !== 'string') return false
    if (typeof i.value !== 'string' && typeof i.value !== 'number' && typeof i.value !== 'boolean') return false
    const at = (i.atTimeS ?? i['at-time-s'])
    if (typeof at !== 'number') return false
  }
  return true
}

const normalizeInjections = (raw: unknown): ScenarioInjection[] => {
  if (!Array.isArray(raw)) return []
  const out: ScenarioInjection[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const i = item as Record<string, unknown>
    const tag = i.tag
    const value = i.value
    const at = (i.atTimeS ?? i['at-time-s'])
    if (typeof tag !== 'string') continue
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue
    if (typeof at !== 'number') continue
    out.push({ tag, value, atTimeS: at })
  }
  return out
}

const buildTool = (deps: EalDeps): Tool => {
  let rulesCache: RulesCache | null = null

  const getRules = async (): Promise<EalRulesFile | null> => {
    const now = Date.now()
    if (rulesCache && now - rulesCache.fetchedAt < RULES_TTL_MS) return rulesCache.rules
    let raw: string
    try {
      raw = await deps.source.fetchPage('wiki/_eal-rules.json')
    } catch {
      return null
    }
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!parsed || typeof parsed !== 'object') return null
      const f = parsed as Partial<EalRulesFile>
      if (f.version !== 1 || !Array.isArray(f.rules)) return null
      rulesCache = { rules: f as EalRulesFile, fetchedAt: now }
      return f as EalRulesFile
    } catch {
      return null
    }
  }

  return {
    name: 'eal_classify',
    description:
      'Classifies a scenario or an inline plant state against the wiki-authored NEI 99-01 EAL rule table, ' +
      'returning the highest emergency class reached (Unusual Event / Alert / Site Area Emergency / General Emergency), ' +
      'the moment it was first triggered, and the matching IC code with its NEI 99-01 source. ' +
      'Call with `scenarioId` to classify a wiki scenario, or pass `initialState` + `injections` for an ad-hoc state trajectory.',
    usage:
      'Pass either `scenarioId: "sb-loca"` OR (`initialState: { "PT-455": 2235 }` plus optional `injections: [{ tag, value, "at-time-s": <seconds> }]`). ' +
      'The tool builds a time-series, evaluates every rule with DURATION-clause awareness, and returns the highest class reached.',
    returns: 'A markdown string explaining the classification result, with IC code + source citation.',
    parameters: {
      type: 'object',
      properties: {
        scenarioId: {
          type: 'string',
          description: 'Wiki scenario id (e.g. "sb-loca"). When set, initialState/injections are ignored.',
        },
        initialState: {
          type: 'object',
          description: 'Inline plant state at scenario start. Keys are tag ids, values are string|number|boolean.',
          additionalProperties: true,
        },
        injections: {
          type: 'array',
          description: 'Inline injection list: [{ tag, value, "at-time-s" }, ...].',
          items: { type: 'object', additionalProperties: true },
        },
      },
      additionalProperties: false,
    },
    execute: async (params, context): Promise<ToolResult> => {
      const t0 = Date.now()
      const scenarioId = typeof params.scenarioId === 'string' ? params.scenarioId.trim() : ''
      const emit = deps.telemetry ?? defaultTelemetry
      const fire = (scenarioIdVal: string | null, highestClass: string | null, matchingIc: string | null, errorClass?: EalTelemetry['errorClass']): void => {
        emit({
          tool: 'eal_classify',
          ts: new Date().toISOString(),
          callerId: context.callerId,
          callerName: context.callerName,
          scenarioId: scenarioIdVal,
          highestClass,
          matchingIc,
          durationMs: Date.now() - t0,
          ...(errorClass ? { errorClass } : {}),
        })
      }

      const rulesFile = await getRules()
      if (!rulesFile) {
        fire(scenarioId || null, null, null, 'no-rules')
        return { success: false, error: `${deps.wikiName} EAL rules are unavailable. The wiki must publish _eal-rules.json (built from wiki/eal/classification-rules.md).` }
      }

      let initialState: Record<string, string | number | boolean>
      let injections: ScenarioInjection[]
      let resolvedScenarioId: string | null = null
      let expectedClass: string | null = null

      if (scenarioId) {
        // Fetch + parse the scenario
        let raw: string
        try {
          raw = await deps.source.fetchPage(`wiki/scenarios/${scenarioId}.md`)
        } catch (err) {
          fire(scenarioId, null, null, 'unknown-scenario')
          return { success: false, error: `Could not fetch scenario '${scenarioId}': ${(err as Error).message}` }
        }
        const parsed = parseScenario(raw)
        if ('error' in parsed) {
          fire(scenarioId, null, null, 'parse-failed')
          return { success: false, error: `Scenario '${scenarioId}' failed to parse: ${parsed.error}` }
        }
        initialState = { ...parsed.initialState }
        injections = [...parsed.injections]
        resolvedScenarioId = parsed.scenarioId
        expectedClass = parsed.expectedEalClass
      } else {
        if (!isStateMap(params.initialState)) {
          fire(null, null, null, 'bad-state')
          return { success: false, error: 'When scenarioId is omitted, initialState must be an object mapping tag ids to string|number|boolean values.' }
        }
        initialState = { ...params.initialState }
        injections = isInjectionArray(params.injections) ? params.injections : normalizeInjections(params.injections)
      }

      const samples = projectScenarioTimeline(initialState, injections)
      const result = classifyEal(rulesFile.rules, samples)
      fire(resolvedScenarioId, result.highestClass, result.matchingIc)

      // Render
      const lines: string[] = []
      if (resolvedScenarioId) lines.push(`## EAL classification — \`${resolvedScenarioId}\``)
      else lines.push('## EAL classification — ad-hoc state')

      if (result.highestClass === null) {
        lines.push('')
        lines.push('**No emergency class triggered** by any rule in the table over the scenario timeline.')
        if (expectedClass) {
          lines.push('')
          lines.push(`⚠️ The scenario declared \`expected-eal-class: ${expectedClass}\` but no rule fired. Either the scenario state misses an IC threshold or the rule table omits this IC.`)
        }
      } else {
        lines.push('')
        lines.push(`**Highest class reached:** ${result.highestClass}`)
        lines.push(`**First reached at:** t = ${result.firstReachedAtS} s`)
        lines.push(`**Matching IC:** \`${result.matchingIc}\``)
        lines.push(`**Source:** ${result.matchingSource}`)
        if (expectedClass && result.highestClass !== expectedClass) {
          lines.push('')
          lines.push(`⚠️ Scenario declared \`expected-eal-class: ${expectedClass}\` but classification returned ${result.highestClass}. One of them is wrong.`)
        }
      }
      lines.push('')
      lines.push(`*${rulesFile.rules.length} rules evaluated against ${samples.length} time-series samples.*`)
      return { success: true, data: lines.join('\n') }
    },
  }
}

export const createEalClassifyTool = (
  binding: WikiSourceBinding,
  wikiName: string,
  telemetry?: (event: EalTelemetry) => void,
): Tool => buildTool({
  source: createWikiSource(binding),
  wikiName,
  ...(telemetry ? { telemetry } : {}),
})
