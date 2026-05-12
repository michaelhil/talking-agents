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

// Source-citation URI for the bundled procedure corpus. Uses the `samsinn://`
// scheme to signal "this lives inside the Samsinn binary, not at an external
// authority." Why not a real public URL: there's no canonical public location
// for industry-generic Westinghouse PWR EOP procedures, and using a fictional
// github.com URL (the previous `samsinn-wikis/pwr-eop` placeholder) invited
// model hallucination — strong models would substitute plausible-looking
// NRC URLs over a placeholder they could tell wasn't real. A samsinn:// URI
// is unambiguously local; the model has nothing to "fix."
export const PWR_EOP_SOURCE_URL = 'samsinn://pack/pwr-eop/E-0'
export const PWR_EOP_SOURCE_LABEL = 'Bundled procedure (samsinn-pack-pwr-eop)'

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

// === Mermaid renderer ======================================================
//
// The tool server-renders a complete ```mermaid…``` fenced block which the
// agent pastes into its reply verbatim. This mirrors how `norway_platforms`
// returns a ```map fence and matches the established UI post-render
// processor convention (src/ui/modules/mermaid/index.ts:34). Asking the
// agent to assemble mermaid from raw step structure invites paraphrasing
// of node-id labels which breaks the diagram syntactically — this happens
// even with strong models when given a fill-in-template prompt.

// Sanitize a string for use as a mermaid node label. Mermaid is picky about
// quotes / parens inside `["..."]` labels — replace doubles with singles
// and strip control characters.
const escapeLabel = (s: string): string => s.replace(/"/g, "'").replace(/[\r\n]+/g, ' ').slice(0, 80)

// Render a compact mermaid flowchart:
//   - one node per step (rectangle for action/check-only, diamond for decisions)
//   - "continue to Step N" branches become labeled edges between step nodes
//   - "dispatch to X" branches become single named external nodes (one per
//     unique X, deduped — previously we emitted EXT_* per branch which
//     duplicated targets and blew up the diagram)
//   - "manual" / other free-text branches are dropped from the diagram and
//     surfaced in the step body's list (the markdown side) instead. They
//     aren't graph transitions and rendering them as orphan nodes was the
//     source of the T-node bloat that smaller models truncated mid-output.
const renderMermaid = (proc: ParsedProcedure): string => {
  const lines: string[] = ['flowchart TD']
  // Nodes (one per step)
  for (const step of proc.steps) {
    const isDecision = step.branches.length > 0
    const label = `Step ${step.n}: ${escapeLabel(step.title)}`
    const shape = isDecision ? `{"${label}"}` : `["${label}"]`
    lines.push(`  S${step.n}${shape}`)
  }
  // Dedup external dispatch targets across all branches.
  const externals = new Map<string, string>()  // id → label
  // Edges
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
        const targetName = dispatchM[1]!
        const targetId = `EXT_${targetName.replace(/[^A-Za-z0-9]/g, '_')}`
        externals.set(targetId, targetName)
        lines.push(`  S${step.n} -->|"${escapeLabel(branch)}"| ${targetId}`)
      }
      // Other shapes (manual recovery, free-text) are intentionally not
      // rendered in the diagram. They remain visible in the step body list.
    }
  }
  // Emit external nodes after the edges so the diagram declares them in one place.
  for (const [id, label] of externals) {
    lines.push(`  ${id}["${escapeLabel(label)}"]:::external`)
  }
  lines.push('  classDef external fill:#fff3cd,stroke:#856404,color:#856404')
  return lines.join('\n')
}

// Wrap the mermaid source in a complete fenced block. The agent pastes this
// string verbatim into its reply — same contract as norway_platforms' map
// fence. The eval-loop trailer ("include fenced code blocks intact") plus
// the persona-level "paste diagramFence verbatim" instruction together
// keep the brittle mermaid syntax from being rewritten.
const buildDiagramFence = (proc: ParsedProcedure): string =>
  ['```mermaid', renderMermaid(proc), '```'].join('\n')

// === Tool ==================================================================

// Structured return shape: the agent writes the natural-language step list
// from `steps[]` (its value-add — composing prose from data), but pastes
// `diagramFence` verbatim (because mermaid syntax is brittle and the post-
// render processor expects a complete block). `source` is a real-feeling
// reference the agent cites without rewriting; the `samsinn://` scheme
// signals self-contained content.
export interface ProcedureLookupResult {
  readonly procedureId: string
  readonly title: string
  readonly appliesTo?: string
  readonly steps: ReadonlyArray<Step>
  readonly diagramFence: string
  readonly source: { readonly label: string; readonly url: string }
}

export const procedureLookupTool: Tool = {
  name: 'procedure_lookup',
  description:
    'Looks up a procedure by id from the bundled PWR EOP corpus. Returns the procedure as structured data — title, applies-to, an array of steps (each with check/action/branches), a ready-to-paste ```mermaid fenced block as `diagramFence`, and a `source` reference. ' +
    'In your reply: synthesize a clean numbered step summary from `steps` in your own words (1-2 lines per step). Preserve technical terms verbatim — do not rephrase Check:/Action: prose. After the summary, paste `diagramFence` exactly as returned (it renders as an inline flowchart — paraphrasing breaks the diagram). End with one citation line: `Source: [<source.label>](<source.url>)`. Do not substitute the source URL.',
  usage: 'Pass `id` (e.g. "E-0"). Available ids are listed when an unknown id is requested.',
  returns: 'A pre-formatted markdown string ready to paste into chat.',
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
    const result: ProcedureLookupResult = {
      procedureId: proc.id,
      title: proc.title,
      ...(proc.appliesTo ? { appliesTo: proc.appliesTo } : {}),
      steps: proc.steps,
      diagramFence: buildDiagramFence(proc),
      source: { label: PWR_EOP_SOURCE_LABEL, url: PWR_EOP_SOURCE_URL },
    }
    return { success: true, data: result }
  },
}
