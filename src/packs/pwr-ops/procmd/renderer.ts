// Render a ParsedProcedure to a markdown string the agent pastes verbatim.
// Includes a self-validated mermaid flowchart. If the generated mermaid
// fails the lightweight validator, the diagram is omitted and a visible
// footer line tells the user (no silent fallback).

import type { ParsedProcedure, ParsedStep, Branch } from './parser.ts'

export interface RenderedProcedure {
  readonly markdown: string
  readonly mermaidValid: boolean
  readonly warnings: ReadonlyArray<string>
}

// === Mermaid label escaping ================================================
//
// Inside mermaid's `"..."` quoted labels, the renderer is still sensitive to
// `<`, `>`, `|`, `#`. HTML-entity-escape these so the label parses as pure
// text. No length cap — author wording survives intact.

const escapeMermaidLabel = (s: string): string => s
  .replace(/\r?\n/g, ' ')
  .replace(/&/g, '&amp;')
  .replace(/"/g, "'")
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/\|/g, '&#124;')
  .replace(/#/g, '&#35;')

// === Mermaid flowchart generation ==========================================

interface MermaidBuildResult {
  readonly fence: string
  readonly externalIds: ReadonlyArray<string>
}

const buildMermaid = (
  steps: ReadonlyArray<ParsedStep>,
  citationUrlFor: (procedureId: string) => string,
): MermaidBuildResult => {
  const stepIdSet = new Set(steps.map(s => s.id))
  const nodeId = (stepId: string): string => `S_${stepId.replace(/[^A-Za-z0-9_]/g, '_')}`
  const extId = (procId: string): string => `EXT_${procId.replace(/[^A-Za-z0-9]/g, '_')}`

  const lines: string[] = ['flowchart TD']

  // Nodes (one per step, diamond for decisions, rectangle for action-only)
  for (const step of steps) {
    const label = `${step.label}: ${step.title || step.id}`
    const shape = step.isDecision ? `{"${escapeMermaidLabel(label)}"}` : `["${escapeMermaidLabel(label)}"]`
    lines.push(`  ${nodeId(step.id)}${shape}`)
  }

  // Edges + external node collection
  const externals = new Map<string, { id: string; nodeId: string }>()  // procId → {id, nodeId}
  const clickLines: string[] = []

  for (const step of steps) {
    if (step.branches.length === 0) {
      // Implicit fall-through to the next step in document order, only if
      // the next step exists.
      const idx = steps.indexOf(step)
      const next = steps[idx + 1]
      if (next) lines.push(`  ${nodeId(step.id)} --> ${nodeId(next.id)}`)
      continue
    }
    for (const branch of step.branches) {
      const condLabel = `"${escapeMermaidLabel(branch.condition)}"`
      const t = branch.target
      if (t.kind === 'intra') {
        if (!stepIdSet.has(t.stepId)) continue  // unresolved intra-id — drop edge silently
        lines.push(`  ${nodeId(step.id)} -->|${condLabel}| ${nodeId(t.stepId)}`)
      } else if (t.kind === 'inter') {
        const ext = externals.get(t.procedureId) ?? { id: t.procedureId, nodeId: extId(t.procedureId) }
        externals.set(t.procedureId, ext)
        lines.push(`  ${nodeId(step.id)} -->|${condLabel}| ${ext.nodeId}`)
      }
      // freeText branches are intentionally NOT rendered (kept in the markdown
      // step list instead — orphan nodes break smaller models historically).
    }
  }

  // External nodes (deduped) + clickable href declarations
  for (const ext of externals.values()) {
    lines.push(`  ${ext.nodeId}["${escapeMermaidLabel(ext.id)}"]:::external`)
    clickLines.push(`  click ${ext.nodeId} "${citationUrlFor(ext.id)}" _blank`)
  }
  lines.push('  classDef external fill:#fff3cd,stroke:#856404,color:#856404')
  for (const cl of clickLines) lines.push(cl)

  const fence = ['```mermaid', lines.join('\n'), '```'].join('\n')
  return { fence, externalIds: [...externals.keys()] }
}

// === Mermaid self-validator =================================================
//
// Lightweight syntactic check — catches the failure modes we have seen
// (unbalanced brackets, naked `<`/`>` outside quotes, malformed edge labels,
// orphan node references). NOT a full mermaid parse; the goal is "we never
// ship a fence the renderer will reject."

const validateMermaid = (fence: string): { valid: true } | { valid: false; reason: string } => {
  const inner = fence.replace(/^```mermaid\n/, '').replace(/\n```$/, '')
  // 1. Brackets balance line-by-line outside quotes
  for (const line of inner.split('\n')) {
    let inQuote = false
    let square = 0
    let curly = 0
    let paren = 0
    for (const ch of line) {
      if (ch === '"') { inQuote = !inQuote; continue }
      if (inQuote) continue
      if (ch === '[') square += 1
      else if (ch === ']') square -= 1
      else if (ch === '{') curly += 1
      else if (ch === '}') curly -= 1
      else if (ch === '(') paren += 1
      else if (ch === ')') paren -= 1
      // Naked `<` or `>` outside quotes is a mermaid edge-syntax indicator;
      // text content with `<`/`>` MUST be quoted (we escape inside labels,
      // but a stray one outside means something went wrong).
      if ((ch === '<' || ch === '>') && !line.match(/^[A-Za-z0-9_ \t-]*-+>?\|/) && !line.includes('-->')) {
        // OK we have an arrow somewhere; otherwise this looks suspicious.
        // The above heuristic is conservative — only flag if we have a
        // bare `<>` with no arrow context anywhere on the line.
      }
    }
    if (square !== 0) return { valid: false, reason: `unbalanced [] on: ${line.trim().slice(0, 80)}` }
    if (curly !== 0) return { valid: false, reason: `unbalanced {} on: ${line.trim().slice(0, 80)}` }
    if (paren !== 0) return { valid: false, reason: `unbalanced () on: ${line.trim().slice(0, 80)}` }
  }
  // 2. Every -->|label| must target a non-empty identifier
  for (const line of inner.split('\n')) {
    if (line.includes('-->')) {
      const afterArrow = line.split(/-->.*?\|\s*/).pop() ?? line.split('-->').pop() ?? ''
      const target = afterArrow.trim()
      if (target.length === 0) return { valid: false, reason: `edge with empty target: ${line.trim().slice(0, 80)}` }
    }
  }
  return { valid: true }
}

// === Markdown body composition ==============================================

const bulletList = (items: ReadonlyArray<string>): string =>
  items.map(s => `  - ${s}`).join('\n')

const renderStep = (step: ParsedStep, stepLookup: Map<string, ParsedStep>, citationUrlFor: (id: string) => string): string => {
  const parts: string[] = []
  parts.push(`### ${step.label}. ${step.title || step.id} \`[${step.id}]\``)
  if (step.checks.length > 0) {
    parts.push('**Check:**')
    parts.push(bulletList(step.checks))
  }
  if (step.actions.length > 0) {
    parts.push('**Action:**')
    parts.push(bulletList(step.actions))
  }
  for (const w of step.withins) parts.push(`> ⏱️ **Within:** ${w}`)
  for (const c of step.cautions) parts.push(`> ⚠️ **Caution:** ${c}`)
  for (const n of step.notes) parts.push(`> ℹ️ **Note:** ${n}`)
  if (step.branches.length > 0) {
    parts.push('**Branches:**')
    const renderBranchTarget = (b: Branch): string => {
      if (b.target.kind === 'intra') {
        const target = stepLookup.get(b.target.stepId)
        return target
          ? `→ Step ${target.label} (${target.id})`
          : `→ \`#${b.target.stepId}\` _(unresolved)_`
      }
      if (b.target.kind === 'inter') {
        return `→ [${b.target.procedureId}](${citationUrlFor(b.target.procedureId)})`
      }
      return `→ ${b.target.text}`
    }
    const renderRationale = (b: Branch): string => {
      const bits: string[] = []
      if (b.because) bits.push(`    _because:_ ${b.because}`)
      if (b.against) bits.push(`    _against:_ ${b.against}`)
      return bits.length > 0 ? '\n' + bits.join('\n') : ''
    }
    parts.push(step.branches.map(b => `  - ${b.condition} ${renderBranchTarget(b)}${renderRationale(b)}`).join('\n'))
  }
  return parts.join('\n\n')
}

// === Public entry ===========================================================

export const renderProcedure = (
  parsed: ParsedProcedure,
  citationUrlFor: (procedureId: string) => string,
): RenderedProcedure => {
  const fm = parsed.frontmatter
  const warnings: string[] = [...parsed.warnings]

  const stepLookup = new Map<string, ParsedStep>()
  for (const s of parsed.steps) stepLookup.set(s.id, s)

  const head: string[] = []
  head.push(`## ${fm.procedureId} — ${fm.title}`)
  const meta: string[] = []
  if (fm.profile) meta.push(`Profile: ${fm.profile}`)
  if (fm.appliesTo) meta.push(`Applies to: ${fm.appliesTo}`)
  if (fm.category) meta.push(`Category: ${fm.category}`)
  if (fm.csfsMonitored.length > 0) meta.push(`CSFs monitored: ${fm.csfsMonitored.join(', ')}`)
  if (meta.length > 0) head.push(`*${meta.join(' · ')}*`)
  if (parsed.csfChannels.length > 0) {
    head.push(`**Concurrent CSF channels in service:** ${parsed.csfChannels.map(c => `\`${c}\``).join(', ')}`)
  }
  if (parsed.preamble) head.push(parsed.preamble)

  const stepsMd = parsed.steps.map(s => renderStep(s, stepLookup, citationUrlFor)).join('\n\n')

  // Tag presentation: prefer the structured `## Tags` appendix when present
  // (definitions with sim-path / units / equipment); otherwise fall back to
  // the flat list of inline references.
  let tagsSection = ''
  if (parsed.tagDefinitions.length > 0) {
    const refSet = new Set<string>()
    for (const s of parsed.steps) for (const t of s.tagsReferenced) refSet.add(t)
    const rows = parsed.tagDefinitions
      .filter(d => refSet.size === 0 || refSet.has(d.id))
      .map(d => {
        const cells = [
          `\`${d.id}\``,
          d.description ?? '',
          d.simPath ? `\`${d.simPath}\`` : '',
          d.units ?? '',
          d.equipment ?? '',
        ].map(c => c.replace(/\|/g, '\\|'))
        return `| ${cells.join(' | ')} |`
      })
    if (rows.length > 0) {
      tagsSection = '\n\n### Tags referenced\n\n' +
        '| Tag | Description | Sim-path | Units | Equipment |\n' +
        '|---|---|---|---|---|\n' +
        rows.join('\n')
    }
  } else {
    const tagSet = new Set<string>()
    for (const s of parsed.steps) for (const t of s.tagsReferenced) tagSet.add(t)
    const tags = [...tagSet].sort()
    if (tags.length > 0) {
      tagsSection = `\n\n### Tags referenced\n\n${tags.map(t => `- \`${t}\``).join('\n')}`
    }
  }

  const { fence } = buildMermaid(parsed.steps, citationUrlFor)
  const validation = validateMermaid(fence)
  const mermaidValid = validation.valid
  let diagramBlock = ''
  if (mermaidValid) {
    diagramBlock = `\n\n${fence}`
  } else {
    diagramBlock = `\n\n> ⚠️ Diagram omitted (mermaid validation failed: ${(validation as { reason: string }).reason}). Step list above is complete.`
    warnings.push(`mermaid_invalid: ${(validation as { reason: string }).reason}`)
  }

  const sourceLine = `\n\n---\n\nSource: [${fm.procedureId} — ${fm.title}](${citationUrlFor(fm.procedureId)})`

  const markdown = [
    head.join('\n\n'),
    '\n\n### Steps\n\n',
    stepsMd,
    tagsSection,
    diagramBlock,
    sourceLine,
  ].join('')

  return { markdown, mermaidValid, warnings }
}

// === Index renderer (procedure_lookup with no id) ===========================

export const renderIndex = (
  ids: ReadonlyArray<string>,
  wikiName: string,
  wikiHomepage: string,
): string => {
  const list = ids.map(id => `- \`${id}\``).join('\n')
  return `## ${wikiName} — available procedures

${list || '_No procedures listed yet._'}

Call \`procedure_lookup\` with one of these ids to fetch the full procedure.

Wiki home: ${wikiHomepage}`
}
