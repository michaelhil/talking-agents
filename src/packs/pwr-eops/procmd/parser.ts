// procmd v0.6 parser — minimal subset that backs the renderer.
//
// Handles (per docs/procedure-md.md):
//   - YAML frontmatter (type, procedure-id, procedure-md, title, profile,
//     applies-to, category, csfs-monitored, entry-triggers)
//   - `## Step <label> [id: <kebab>]` headings — id required
//   - body lines: `Check:`, `Action:`, `Caution:`, `Note:`
//   - branches: `- <condition> → #intra-id` / `→ [[INTER-ID]]` / free text
//   - inline `«TAG»` references, extracted as a flat list (no appendix metadata)
//
// Deferred (no consumer yet): When:/Until:/Abort-if:, Because:/Against:,
// sub-steps (`### Step`), Concurrent:/CSF:, [primitive] override,
// `## Tags` appendix metadata, profile-vocabulary validation.

export interface ParsedFrontmatter {
  readonly procedureId: string
  readonly title: string
  readonly procedureMd?: string
  readonly profile?: string
  readonly appliesTo?: string
  readonly category?: string
  readonly csfsMonitored: ReadonlyArray<string>
  readonly entryTriggers: ReadonlyArray<string>
}

export type BranchTarget =
  | { readonly kind: 'intra'; readonly stepId: string }
  | { readonly kind: 'inter'; readonly procedureId: string }
  | { readonly kind: 'freeText'; readonly text: string }

export interface Branch {
  readonly condition: string
  readonly target: BranchTarget
}

export interface ParsedStep {
  readonly id: string
  readonly label: string                       // presentation: "1", "3.a", etc
  readonly title: string                       // free text after `## Step <label>` (the keyword chain's first prose line, if any)
  readonly checks: ReadonlyArray<string>
  readonly actions: ReadonlyArray<string>
  readonly cautions: ReadonlyArray<string>
  readonly notes: ReadonlyArray<string>
  readonly tagsReferenced: ReadonlyArray<string>
  readonly branches: ReadonlyArray<Branch>
  readonly isDecision: boolean                 // has at least one branch
}

export interface ParsedProcedure {
  readonly frontmatter: ParsedFrontmatter
  readonly preamble: string
  readonly steps: ReadonlyArray<ParsedStep>
  readonly warnings: ReadonlyArray<string>
}

// === Frontmatter ============================================================

const parseFrontmatter = (raw: string): { fm: ParsedFrontmatter | null; body: string } => {
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
    },
    body,
  }
}

// === Tag extraction =========================================================

// Inline tag refs are «UPPER-CASE» per spec. Skip occurrences inside fenced
// code blocks or inline code spans — same convention as the spec demands.
const TAG_RE = /«([A-Z][A-Z0-9-]*)»/g

const extractTags = (text: string): ReadonlyArray<string> => {
  // Strip fenced code blocks first to avoid false positives in examples.
  const noFences = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]+`/g, '')
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = TAG_RE.exec(noFences)) !== null) {
    seen.add(m[1]!)
  }
  return [...seen]
}

// === Branch parsing =========================================================

// Recognised branch shapes (per spec):
//   - <condition> → #intra-step-id
//   - <condition> → [[INTER-ID]]
//   - <condition> → free text  (unparsed, kept as freeText target)
const BRANCH_RE = /^[-*]\s+(.+?)\s*→\s*(.+?)\s*$/

const parseBranch = (line: string): Branch | null => {
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

// `## Step <label>` or `## Step <label> [id: <kebab>]` or `## Step [id: <kebab>]`.
// Label is optional in the spec; id is required (we warn if missing).
const STEP_HEADING_RE = /^##\s+Step(?:\s+(\S+?))?(?:\s+\[(?<meta>[^\]]+)\])?\s*$/

const parseStepMeta = (meta: string | undefined): { id?: string } => {
  if (!meta) return {}
  const parts = meta.split(',').map(p => p.trim())
  for (const p of parts) {
    const m = p.match(/^id:\s*([a-z0-9][a-z0-9-]*)$/)
    if (m) return { id: m[1]! }
  }
  return {}
}

interface StepBuilder {
  id: string
  label: string
  title: string
  checks: string[]
  actions: string[]
  cautions: string[]
  notes: string[]
  branches: Branch[]
  bodyText: string[]            // accumulator for tag extraction
}

const flushStep = (b: StepBuilder | null, out: ParsedStep[]): void => {
  if (!b) return
  const tagSource = [...b.checks, ...b.actions, ...b.cautions, ...b.notes, ...b.bodyText, ...b.branches.map(br => br.condition)].join('\n')
  const tagsReferenced = extractTags(tagSource)
  out.push({
    id: b.id,
    label: b.label,
    title: b.title,
    checks: b.checks,
    actions: b.actions,
    cautions: b.cautions,
    notes: b.notes,
    tagsReferenced,
    branches: b.branches,
    isDecision: b.branches.length > 0,
  })
}

const parseBody = (body: string): { preamble: string; steps: ReadonlyArray<ParsedStep>; warnings: ReadonlyArray<string> } => {
  const lines = body.split('\n')
  const steps: ParsedStep[] = []
  const warnings: string[] = []
  const preambleLines: string[] = []
  let current: StepBuilder | null = null
  let inFence = false
  let stepIndex = 0

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    // Track fenced code blocks at the line level — keywords inside fences
    // are content, not directives.
    if (/^\s*```/.test(raw)) {
      inFence = !inFence
      if (current) current.bodyText.push(raw)
      else preambleLines.push(raw)
      continue
    }
    if (inFence) {
      if (current) current.bodyText.push(raw)
      else preambleLines.push(raw)
      continue
    }

    const stepM = raw.match(STEP_HEADING_RE)
    if (stepM) {
      flushStep(current, steps)
      stepIndex += 1
      const meta = parseStepMeta(stepM.groups?.['meta'])
      const label = stepM[1] ?? String(stepIndex)
      const id = meta.id ?? label.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
      if (!meta.id) {
        warnings.push(`Step "${label}" has no [id: ...] — synthesised "${id}" for cross-references`)
      }
      current = {
        id,
        label,
        title: '',
        checks: [],
        actions: [],
        cautions: [],
        notes: [],
        branches: [],
        bodyText: [],
      }
      continue
    }

    if (!current) {
      preambleLines.push(raw)
      continue
    }

    const line = raw.trim()
    if (!line) continue

    // Body keyword dispatch
    if (/^check:/i.test(line)) {
      current.checks.push(line.replace(/^check:\s*/i, ''))
      continue
    }
    if (/^action:/i.test(line)) {
      current.actions.push(line.replace(/^action:\s*/i, ''))
      continue
    }
    if (/^caution:/i.test(line)) {
      current.cautions.push(line.replace(/^caution:\s*/i, ''))
      continue
    }
    if (/^note:/i.test(line)) {
      current.notes.push(line.replace(/^note:\s*/i, ''))
      continue
    }
    // Branch?
    if (/^[-*]\s+.*→/.test(line)) {
      const b = parseBranch(line)
      if (b) current.branches.push(b)
      else current.bodyText.push(line)
      continue
    }
    // Section header within step body — ignore (e.g. `## Tags` appendix kicks
    // us out of the last step; handled by the heading match above when it's
    // an H2). For sub-content we just capture as bodyText so tag extraction
    // sees it.
    if (!current.title && !line.startsWith('#')) {
      // First non-keyword line becomes the step title (free-text intro).
      current.title = line
      continue
    }
    current.bodyText.push(line)
  }

  flushStep(current, steps)

  return {
    preamble: preambleLines.join('\n').trim(),
    steps,
    warnings,
  }
}

// === Public entry ============================================================

export const parseProcedure = (raw: string): ParsedProcedure | { readonly error: string } => {
  const { fm, body } = parseFrontmatter(raw)
  if (!fm) return { error: 'invalid frontmatter — `procedure-id` and `title` are required' }
  const { preamble, steps, warnings } = parseBody(body)
  if (steps.length === 0) {
    return { error: `no \`## Step\` headings found in ${fm.procedureId}` }
  }
  return {
    frontmatter: fm,
    preamble,
    steps,
    warnings,
  }
}
