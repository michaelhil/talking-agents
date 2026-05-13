// procmd-core — v0.6 parser.
//
// Spec: docs/procedure-md.md. Handles:
//   - YAML frontmatter with unknown-key passthrough (fm.extra)
//   - `## Step <label> [id: <kebab>]` step headings (id required, warn if missing)
//   - body keywords: `Check:`, `Action:`, `Caution:`, `Note:`, `Within:`
//   - branches: `- <condition> → #intra-id` / `→ [[INTER-ID]]` / free text
//   - branch rationale: `Because:` / `Against:` continuation lines
//   - inline `«TAG»` references
//   - standalone `CSF: <channel>` declarations in preamble
//   - `## Tags` appendix — structured tag definitions
//   - `procedure-md:` version handshake (0.6 only; unknown → warning, parses)
//
// Deferred to future spec increments: When:/Until:/Abort-if:, sub-steps
// (`### Step`), [primitive] override, profile-vocabulary validation, the
// v0.7 `Decision:` keyword.

import {
  ACCEPTED_PROCMD_VERSIONS,
  type BranchTarget,
  type ParseResult,
  type ParsedFrontmatter,
  type ParsedProcedure,
  type ParsedStep,
  type TagDefinition,
} from './types.ts'

// === Frontmatter ============================================================

const KNOWN_FM_KEYS = new Set([
  'type', 'procedure-md', 'procedure-id', 'title', 'profile',
  'applies-to', 'category', 'csfs-monitored', 'entry-triggers',
])

const parseFrontmatter = (raw: string): { fm: ParsedFrontmatter | null; body: string; warning?: string } => {
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) {
    return { fm: null, body: raw }
  }
  const end = raw.indexOf('\n---', 4)
  if (end < 0) return { fm: null, body: raw }
  const fmText = raw.slice(4, end)
  const body = raw.slice(end + 4).replace(/^\r?\n+/, '')
  const map: Record<string, string> = {}
  for (const line of fmText.split('\n')) {
    const m = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/)
    if (m) map[m[1]!] = m[2]!.trim()
  }
  if (!map['procedure-id'] || !map['title']) return { fm: null, body }

  const parseList = (s: string | undefined): ReadonlyArray<string> => {
    if (!s) return []
    const trimmed = s.trim()
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      return trimmed.slice(1, -1).split(',').map(x => x.trim()).filter(Boolean)
    }
    return [trimmed].filter(Boolean)
  }

  const extra: Record<string, string> = {}
  for (const [k, v] of Object.entries(map)) {
    if (!KNOWN_FM_KEYS.has(k)) extra[k] = v
  }

  let warning: string | undefined
  const version = map['procedure-md']
  if (version && !ACCEPTED_PROCMD_VERSIONS.has(version)) {
    warning = `procedure-md ${version} declared; parser supports ${[...ACCEPTED_PROCMD_VERSIONS].join(', ')} — output may be degraded`
  }

  return {
    fm: {
      procedureId: map['procedure-id']!,
      title: map['title']!,
      ...(map['procedure-md'] ? { procedureMd: map['procedure-md'] } : {}),
      ...(map['profile'] ? { profile: map['profile'] } : {}),
      ...(map['applies-to'] ? { appliesTo: map['applies-to'] } : {}),
      ...(map['category'] ? { category: map['category'] } : {}),
      csfsMonitored: parseList(map['csfs-monitored']),
      entryTriggers: parseList(map['entry-triggers']),
      extra,
    },
    body,
    ...(warning ? { warning } : {}),
  }
}

// === Inline tag extraction ==================================================

const TAG_RE = /«([A-Z][A-Z0-9-]*)»/g

const extractTags = (text: string): ReadonlyArray<string> => {
  const noFences = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]+`/g, '')
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = TAG_RE.exec(noFences)) !== null) seen.add(m[1]!)
  return [...seen]
}

// === Branch parsing =========================================================

const BRANCH_RE = /^[-*]\s+(.+?)\s*→\s*(.+?)\s*$/

const parseBranchLine = (line: string): { condition: string; target: BranchTarget } | null => {
  const m = line.match(BRANCH_RE)
  if (!m) return null
  const condition = m[1]!.trim()
  const targetRaw = m[2]!.trim()
  const intra = targetRaw.match(/^#([a-z0-9][a-z0-9-]*)$/)
  if (intra) return { condition, target: { kind: 'intra', stepId: intra[1]! } }
  const inter = targetRaw.match(/^\[\[([A-Z][A-Z0-9.-]*)\]\]$/)
  if (inter) return { condition, target: { kind: 'inter', procedureId: inter[1]! } }
  return { condition, target: { kind: 'freeText', text: targetRaw } }
}

// === Step parsing ===========================================================

const STEP_HEADING_RE = /^##\s+Step(?:\s+(\S+?))?(?:\s+\[(?<meta>[^\]]+)\])?\s*$/
const OTHER_H2_RE = /^##\s+(?!Step\b)(\S.*)$/
const TAGS_HEADING_RE = /^##\s+Tags\s*$/i

const parseStepMeta = (meta: string | undefined): { id?: string } => {
  if (!meta) return {}
  for (const p of meta.split(',').map(p => p.trim())) {
    const m = p.match(/^id:\s*([a-z0-9][a-z0-9-]*)$/)
    if (m) return { id: m[1]! }
  }
  return {}
}

interface BranchBuilder {
  condition: string
  target: BranchTarget
  because?: string
  against?: string
}

interface StepBuilder {
  id: string
  label: string
  title: string
  checks: string[]
  actions: string[]
  cautions: string[]
  notes: string[]
  withins: string[]
  branches: BranchBuilder[]
  bodyText: string[]
}

const flushStep = (b: StepBuilder | null, out: ParsedStep[]): void => {
  if (!b) return
  const tagSource = [
    ...b.checks, ...b.actions, ...b.cautions, ...b.notes, ...b.withins,
    ...b.bodyText,
    ...b.branches.flatMap(br => [br.condition, br.because ?? '', br.against ?? '']),
  ].join('\n')
  out.push({
    id: b.id,
    label: b.label,
    title: b.title,
    checks: b.checks,
    actions: b.actions,
    cautions: b.cautions,
    notes: b.notes,
    withins: b.withins,
    tagsReferenced: extractTags(tagSource),
    branches: b.branches.map(br => ({
      condition: br.condition,
      target: br.target,
      ...(br.because ? { because: br.because } : {}),
      ...(br.against ? { against: br.against } : {}),
    })),
    isDecision: b.branches.length > 0,
  })
}

// === Tags appendix parsing ==================================================

const TAG_DEF_KNOWN_KEYS = new Set(['id', 'description', 'sim-path', 'units', 'equipment'])

const parseTagsAppendix = (block: string): ReadonlyArray<TagDefinition> => {
  const lines = block.split('\n')
  const out: TagDefinition[] = []
  let current: { id: string; map: Record<string, string> } | null = null

  const flush = (): void => {
    if (!current) return
    const m = current.map
    const extra: Record<string, string> = {}
    for (const [k, v] of Object.entries(m)) {
      if (!TAG_DEF_KNOWN_KEYS.has(k) && k !== 'id') extra[k] = v
    }
    out.push({
      id: current.id,
      ...(m['description'] ? { description: m['description'] } : {}),
      ...(m['sim-path'] ? { simPath: m['sim-path'] } : {}),
      ...(m['units'] ? { units: m['units'] } : {}),
      ...(m['equipment'] ? { equipment: m['equipment'] } : {}),
      extra,
    })
    current = null
  }

  for (const raw of lines) {
    const startMatch = raw.match(/^-\s+id:\s*([A-Z][A-Z0-9-]*)\s*$/)
    if (startMatch) {
      flush()
      current = { id: startMatch[1]!, map: {} }
      continue
    }
    if (!current) continue
    const contMatch = raw.match(/^\s+([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/)
    if (contMatch) {
      current.map[contMatch[1]!] = contMatch[2]!.trim()
      continue
    }
    if (raw.trim() === '') continue
    flush()
  }
  flush()
  return out
}

// === Body parsing ===========================================================

interface BodyResult {
  readonly preamble: string
  readonly csfChannels: ReadonlyArray<string>
  readonly steps: ReadonlyArray<ParsedStep>
  readonly tagDefinitions: ReadonlyArray<TagDefinition>
  readonly warnings: ReadonlyArray<string>
}

const parseBody = (body: string): BodyResult => {
  const lines = body.split('\n')
  const steps: ParsedStep[] = []
  const warnings: string[] = []
  const preambleLines: string[] = []
  const csfChannels: string[] = []
  let current: StepBuilder | null = null
  let inFence = false
  let stepIndex = 0
  let tagsAppendixLines: string[] | null = null
  let inTagsAppendix = false

  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence
      if (inTagsAppendix) tagsAppendixLines!.push(raw)
      else if (current) current.bodyText.push(raw)
      else preambleLines.push(raw)
      continue
    }
    if (inFence) {
      if (inTagsAppendix) tagsAppendixLines!.push(raw)
      else if (current) current.bodyText.push(raw)
      else preambleLines.push(raw)
      continue
    }

    if (TAGS_HEADING_RE.test(raw)) {
      flushStep(current, steps)
      current = null
      inTagsAppendix = true
      tagsAppendixLines = []
      continue
    }

    const stepM = raw.match(STEP_HEADING_RE)
    if (stepM) {
      if (inTagsAppendix) inTagsAppendix = false
      flushStep(current, steps)
      stepIndex += 1
      const meta = parseStepMeta(stepM.groups?.['meta'])
      const label = stepM[1] ?? String(stepIndex)
      const id = meta.id ?? label.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
      if (!meta.id) {
        warnings.push(`Step "${label}" has no [id: ...] — synthesised "${id}" for cross-references`)
      }
      current = {
        id, label, title: '',
        checks: [], actions: [], cautions: [], notes: [], withins: [],
        branches: [], bodyText: [],
      }
      continue
    }

    if (OTHER_H2_RE.test(raw) && current) {
      flushStep(current, steps)
      current = null
      preambleLines.push(raw)
      continue
    }

    if (inTagsAppendix) {
      tagsAppendixLines!.push(raw)
      continue
    }

    if (!current) {
      const csfMatch = raw.match(/^\s*CSF:\s*([a-z0-9][a-z0-9-]*)\s*$/i)
      if (csfMatch) {
        csfChannels.push(csfMatch[1]!.toLowerCase())
        continue
      }
      preambleLines.push(raw)
      continue
    }

    const line = raw.trim()
    if (!line) continue

    if (/^check:/i.test(line)) { current.checks.push(line.replace(/^check:\s*/i, '')); continue }
    if (/^action:/i.test(line)) { current.actions.push(line.replace(/^action:\s*/i, '')); continue }
    if (/^caution:/i.test(line)) { current.cautions.push(line.replace(/^caution:\s*/i, '')); continue }
    if (/^note:/i.test(line)) { current.notes.push(line.replace(/^note:\s*/i, '')); continue }
    if (/^within:/i.test(line)) { current.withins.push(line.replace(/^within:\s*/i, '')); continue }

    const becauseMatch = line.match(/^because:\s*(.+)$/i)
    if (becauseMatch && current.branches.length > 0) {
      const last = current.branches[current.branches.length - 1]!
      last.because = (last.because ? last.because + ' ' : '') + becauseMatch[1]!.trim()
      continue
    }
    const againstMatch = line.match(/^against:\s*(.+)$/i)
    if (againstMatch && current.branches.length > 0) {
      const last = current.branches[current.branches.length - 1]!
      last.against = (last.against ? last.against + ' ' : '') + againstMatch[1]!.trim()
      continue
    }
    if (/^[-*]\s+.*→/.test(line)) {
      const b = parseBranchLine(line)
      if (b) current.branches.push({ condition: b.condition, target: b.target })
      else current.bodyText.push(line)
      continue
    }
    if (!current.title && !line.startsWith('#')) {
      current.title = line
      continue
    }
    current.bodyText.push(line)
  }

  flushStep(current, steps)
  const tagDefinitions = inTagsAppendix && tagsAppendixLines
    ? parseTagsAppendix(tagsAppendixLines.join('\n'))
    : []

  return {
    preamble: preambleLines.join('\n').trim(),
    csfChannels,
    steps,
    tagDefinitions,
    warnings,
  }
}

// === Public entry ============================================================

export const parseProcedure = (raw: string): ParseResult => {
  const { fm, body, warning: fmWarning } = parseFrontmatter(raw)
  if (!fm) return { error: 'invalid frontmatter — `procedure-id` and `title` are required' }
  const { preamble, csfChannels, steps, tagDefinitions, warnings } = parseBody(body)
  if (steps.length === 0) return { error: `no \`## Step\` headings found in ${fm.procedureId}` }
  const allWarnings = fmWarning ? [fmWarning, ...warnings] : warnings
  const result: ParsedProcedure = {
    frontmatter: fm,
    preamble,
    csfChannels,
    steps,
    tagDefinitions,
    warnings: allWarnings,
  }
  return result
}

// Re-export types for downstream consumers.
export type {
  Branch,
  BranchTarget,
  ParsedFrontmatter,
  ParsedProcedure,
  ParsedStep,
  ParseResult,
  TagDefinition,
} from './types.ts'
export { PARSER_PROCMD_VERSION, ACCEPTED_PROCMD_VERSIONS } from './types.ts'
