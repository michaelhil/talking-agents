// Bundled demo tool — pulls a procedure-md (procmd) procedure from the
// bundled PWR EOP corpus and returns structured output: a numbered step
// list, a mermaid flowchart, and a back-link to the upstream wiki.
//
// Scope: a MINIMAL procmd v0.5 parser, sufficient for the bundled E-0
// example. Not full v0.5 conformance — see docs/procedure-md.md for the
// full spec. Specifically supported:
//   - YAML frontmatter (type, procedure-id, title, applies-to)
//   - `## Step N: <title>` headings
//   - `Check: <...>` and `Action: <...>` body prefixes
//   - `→ <branch text>` decision branches
// Out of scope here: Plan/sub-step nesting, profile lookups, `[primitive]`
// tag overrides, entry-triggers/csfs taxonomy validation.
//
// The procedure content is bundled in-binary as a TS string constant. No
// `data/` subdir needed (pack scanner only recognizes tools/skills/etc).
// If/when more procedures are added, expand the PROCEDURES map below.

import type { Tool, ToolResult } from '../../../core/types/tool.ts'

// Public wiki URL declared by this bundled pack. Single source of truth —
// referenced both in the tool output and (when relevant) the demo
// scenario narration.
export const PWR_EOP_WIKI_URL = 'https://github.com/samsinn-wikis/pwr-eop'

interface Step {
  readonly n: number
  readonly title: string
  readonly check?: string
  readonly action?: string
  readonly branches: ReadonlyArray<string>
}

interface ParsedProcedure {
  readonly id: string
  readonly title: string
  readonly appliesTo?: string
  readonly steps: ReadonlyArray<Step>
}

// E-0 "Reactor Trip or Safety Injection" — diagnostic entry procedure for
// Westinghouse 4-loop PWRs. Generic public-domain content; not tied to any
// specific operator's actual EOP set. ~10 steps, faithful to the
// industry-standard structure (PROforma-style decisions + actions).
const E_0_SOURCE = `---
type: procedure
procedure-md: 0.5
procedure-id: E-0
title: Reactor Trip or Safety Injection
applies-to: Westinghouse 4-loop PWR
---

## Step 1: Verify Reactor Trip

Check: All control rod bottom lights LIT
Check: Reactor power dropping

→ If reactor not tripped: manually trip the reactor
→ If reactor tripped: continue to Step 2

## Step 2: Verify Turbine Trip

Check: All turbine stop valves CLOSED
Check: Generator output breakers OPEN

→ If turbine not tripped: manually trip the turbine
→ If turbine tripped: continue to Step 3

## Step 3: Verify AC Emergency Buses Energized

Check: At least one AC emergency bus energized

→ If no emergency bus energized: dispatch to ECA-0.0 (Loss of All AC Power)
→ If at least one emergency bus energized: continue to Step 4

## Step 4: Check If Safety Injection Is Actuated

Check: SI actuation signal status
Check: SI pumps running

→ If SI actuated: continue to Step 5
→ If SI not actuated and not required: dispatch to ES-0.1 (Reactor Trip Response)
→ If SI required but not actuated: manually actuate SI, continue to Step 5

## Step 5: Verify Feedwater Isolation

Check: Main feedwater isolation valves CLOSED
Check: Main feedwater pumps tripped

Action: Confirm AFW pumps running and supplying steam generators

## Step 6: Check RCS Temperature

Check: RCS hot-leg temperature trend
Check: RCS cold-leg temperature trend

→ If Tavg < 547 °F and dropping: continue to Step 7
→ If Tavg > 547 °F: dispatch to FR-H.1 (Loss of Secondary Heat Sink)

## Step 7: Check Steam Generator Levels

Check: Narrow-range level in each steam generator

Action: Maintain SG narrow-range level between 6% and 50%

→ If any SG level < 6%: dispatch to ES-1.2 (Post-LOCA Cooldown)
→ If all SG levels in band: continue to Step 8

## Step 8: Check Pressurizer Pressure and Level

Check: Pressurizer pressure
Check: Pressurizer level

Action: Confirm charging flow established

→ If pressure dropping uncontrolled: dispatch to E-1 (Loss of Reactor or Secondary Coolant)
→ If pressure stable: continue to Step 9

## Step 9: Check Containment Conditions

Check: Containment pressure
Check: Containment radiation levels

→ If containment pressure > 4 psig: dispatch to E-2 (Steam Line Break)
→ If containment radiation high: dispatch to E-3 (Steam Generator Tube Rupture)
→ If containment normal: continue to Step 10

## Step 10: Transition to Recovery Procedure

Check: All CSFs (Critical Safety Functions) status

Action: Hand off to the applicable recovery procedure based on CSF status tree
`

const PROCEDURES: Record<string, string> = {
  'E-0': E_0_SOURCE,
}

// === Minimal parser ========================================================

const parseFrontmatter = (raw: string): { fm: Record<string, string>; body: string } => {
  if (!raw.startsWith('---\n')) return { fm: {}, body: raw }
  const end = raw.indexOf('\n---', 4)
  if (end < 0) return { fm: {}, body: raw }
  const fmText = raw.slice(4, end)
  const body = raw.slice(end + 4).replace(/^\n+/, '')
  const fm: Record<string, string> = {}
  for (const line of fmText.split('\n')) {
    const m = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/)
    if (m) fm[m[1]!] = m[2]!.trim()
  }
  return { fm, body }
}

const parseSteps = (body: string): ReadonlyArray<Step> => {
  const out: Step[] = []
  const lines = body.split('\n')
  let current: { n: number; title: string; check: string[]; action: string[]; branches: string[] } | null = null

  const flush = (): void => {
    if (!current) return
    const step: Step = {
      n: current.n,
      title: current.title,
      ...(current.check.length ? { check: current.check.join('; ') } : {}),
      ...(current.action.length ? { action: current.action.join('; ') } : {}),
      branches: current.branches,
    }
    out.push(step)
    current = null
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    const stepM = line.match(/^##\s+Step\s+(\d+):\s+(.+)$/i)
    if (stepM) {
      flush()
      current = { n: Number(stepM[1]!), title: stepM[2]!, check: [], action: [], branches: [] }
      continue
    }
    if (!current) continue
    if (line.startsWith('Check:')) current.check.push(line.slice('Check:'.length).trim())
    else if (line.startsWith('Action:')) current.action.push(line.slice('Action:'.length).trim())
    else if (line.startsWith('→')) current.branches.push(line.slice('→'.length).trim())
  }
  flush()
  return out
}

const parseProcedure = (source: string): ParsedProcedure => {
  const { fm, body } = parseFrontmatter(source)
  return {
    id: fm['procedure-id'] ?? 'unknown',
    title: fm['title'] ?? 'Untitled procedure',
    ...(fm['applies-to'] ? { appliesTo: fm['applies-to'] } : {}),
    steps: parseSteps(body),
  }
}

// === Renderers =============================================================

const renderStepsMarkdown = (proc: ParsedProcedure): string => {
  const lines: string[] = []
  lines.push(`### ${proc.title}`)
  if (proc.appliesTo) lines.push(`_Applies to: ${proc.appliesTo}_`)
  lines.push('')
  for (const step of proc.steps) {
    lines.push(`**Step ${step.n}: ${step.title}**`)
    if (step.check) lines.push(`- Check: ${step.check}`)
    if (step.action) lines.push(`- Action: ${step.action}`)
    for (const branch of step.branches) lines.push(`  - → ${branch}`)
    lines.push('')
  }
  return lines.join('\n')
}

// Sanitize a string for use as a mermaid node label. Mermaid is picky about
// quotes / parens inside `["..."]` labels — replace doubles with singles
// and strip control characters.
const escapeLabel = (s: string): string => s.replace(/"/g, "'").replace(/[\r\n]+/g, ' ').slice(0, 80)

const renderMermaid = (proc: ParsedProcedure): string => {
  const lines: string[] = ['flowchart TD']
  for (const step of proc.steps) {
    const isDecision = step.branches.length > 0
    const label = `Step ${step.n}: ${escapeLabel(step.title)}`
    const shape = isDecision ? `{"${label}"}` : `["${label}"]`
    lines.push(`  S${step.n}${shape}`)
  }
  for (const step of proc.steps) {
    if (step.branches.length === 0) {
      const next = proc.steps.find(s => s.n === step.n + 1)
      if (next) lines.push(`  S${step.n} --> S${next.n}`)
      continue
    }
    for (const branch of step.branches) {
      const continueM = branch.match(/continue to Step\s+(\d+)/i)
      const dispatchM = branch.match(/dispatch to\s+(\S+)/i)
      if (continueM) {
        lines.push(`  S${step.n} -->|"${escapeLabel(branch)}"| S${continueM[1]}`)
      } else if (dispatchM) {
        const target = `EXT_${dispatchM[1]!.replace(/[^A-Za-z0-9]/g, '_')}`
        lines.push(`  ${target}["${escapeLabel(dispatchM[1]!)}"]:::external`)
        lines.push(`  S${step.n} -->|"${escapeLabel(branch)}"| ${target}`)
      } else {
        // Unhandled branch shape — render as a self-comment edge so the
        // information isn't lost.
        const target = `T${step.n}_${proc.steps.indexOf(step)}_${Math.abs(branch.length)}`
        lines.push(`  ${target}["${escapeLabel(branch)}"]`)
        lines.push(`  S${step.n} --> ${target}`)
      }
    }
  }
  lines.push('  classDef external fill:#fff3cd,stroke:#856404,color:#856404')
  return lines.join('\n')
}

// === Tool ==================================================================

export const procedureLookupTool: Tool = {
  name: 'procedure_lookup',
  description:
    'Looks up a procedure by id from the bundled PWR EOP corpus and returns structured fields: a markdown step list, a mermaid flowchart source, and the upstream wiki URL. ' +
    "Format the agent's reply as exactly:\n" +
    '<stepsMarkdown>\n\n```mermaid\n<mermaidSource>\n```\n\nSource: <wikiUrl>',
  usage: 'Pass `id` (e.g. "E-0"). Available ids are listed when an unknown id is requested.',
  returns: 'Object: { stepsMarkdown, mermaidSource, wikiUrl }',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Procedure id (case-insensitive). E.g. "E-0".',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
  execute: async (params): Promise<ToolResult> => {
    const requested = typeof params.id === 'string' ? params.id.trim() : ''
    // Case-insensitive lookup against the keys.
    const matchKey = Object.keys(PROCEDURES).find(k => k.toLowerCase() === requested.toLowerCase())
    if (!matchKey) {
      const available = Object.keys(PROCEDURES).join(', ')
      return {
        success: false,
        error: `Procedure "${requested}" not found in the PWR EOP bundle. Available: ${available}`,
      }
    }
    const source = PROCEDURES[matchKey]!
    const proc = parseProcedure(source)
    if (proc.steps.length === 0) {
      return { success: false, error: `Procedure "${matchKey}" parsed but contained no steps — bundle is corrupt` }
    }
    return {
      success: true,
      data: {
        stepsMarkdown: renderStepsMarkdown(proc),
        mermaidSource: renderMermaid(proc),
        wikiUrl: `${PWR_EOP_WIKI_URL}/blob/main/${matchKey}.md`,
      },
    }
  },
}
