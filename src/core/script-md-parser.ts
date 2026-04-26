// ============================================================================
// Markdown script parser.
//
// Grammar (strict — see docs/scripts.md):
//
//   # SCRIPT: <title>                ← required, exactly one
//   Premise: <one-line text>         ← optional
//
//   ## Cast                          ← required
//   ### <CastName> [(starts)]
//   - model: <model-id>
//   - tools: <csv> | [a,b,c]         ← optional
//   - includeTools: true|false       ← optional
//   - persona: |                     ← required, multiline
//       <text>
//       <text>
//
//   ---                              ← required separator
//
//   ## Step <N> — <title>
//   Goal: <one-line text>            ← optional
//   Roles:
//     <CastName> — <role>            ← em-dash, en-dash, "--", or "-" all OK
//
// AST-driven, no string substitution. Fails loudly with line context.
// ============================================================================

import type { Script, CastMember, Step } from './types/script.ts'

export const VALID_NAME = /^[a-z0-9][a-z0-9_-]*$/

const CAST_BULLET_KEYS = new Set([
  'model', 'tools', 'persona', 'includePrompts', 'includeContext', 'includeTools',
])

// Accept em-dash, en-dash, double-hyphen, or single-hyphen as a role separator.
const ROLE_SEP = /\s+(?:—|–|--|-)\s+/

function fail(line: number, message: string): never {
  const err = new Error(`line ${line}: ${message}`)
  ;(err as Error & { line?: number }).line = line
  throw err
}

export const parseScriptMd = (name: string, source: string): Script => {
  if (!VALID_NAME.test(name)) {
    throw new Error(`script name "${name}" must match ${VALID_NAME}`)
  }

  const lines = source.split(/\r?\n/)
  let i = 0
  const peek = (): string | undefined => lines[i]
  const consume = (): string | undefined => lines[i++]
  const lineNo = (): number => i + 1

  // --- Header: # SCRIPT: <title>
  let title = ''
  while (i < lines.length) {
    const ln = peek() ?? ''
    if (ln.trim() === '') { i++; continue }
    const m = /^#\s+SCRIPT:\s*(.+?)\s*$/.exec(ln)
    if (!m) fail(lineNo(), `expected "# SCRIPT: <title>" header`)
    title = m![1]!.trim()
    if (!title) fail(lineNo(), `script title is empty`)
    consume()
    break
  }
  if (!title) throw new Error('missing "# SCRIPT: <title>" header')

  // --- Premise: optional single line
  let premise: string | undefined
  while (i < lines.length) {
    const ln = peek() ?? ''
    if (ln.trim() === '') { i++; continue }
    const m = /^Premise:\s*(.+?)\s*$/.exec(ln)
    if (m) {
      premise = m[1]!.trim()
      consume()
    }
    break
  }

  // --- ## Cast
  while (i < lines.length && (peek() ?? '').trim() === '') i++
  const castHeader = peek() ?? ''
  if (!/^##\s+Cast\s*$/.test(castHeader)) {
    fail(lineNo(), `expected "## Cast" section`)
  }
  consume()

  // --- Cast members
  const cast: CastMember[] = []
  while (i < lines.length) {
    const ln = peek() ?? ''
    if (ln.trim() === '') { i++; continue }
    if (ln.trim() === '---') break
    if (/^##\s/.test(ln)) break
    if (!/^###\s/.test(ln)) fail(lineNo(), `expected "### <CastName>" or "---" separator`)
    cast.push(parseCastMember(lines, () => i, (n) => { i = n }))
  }

  if (cast.length < 2) throw new Error(`cast: need at least 2 members (got ${cast.length})`)
  const startsCount = cast.filter(c => c.starts).length
  if (startsCount !== 1) {
    throw new Error(`cast: exactly one member must have "(starts)" marker (got ${startsCount})`)
  }
  const seen = new Set<string>()
  for (const c of cast) {
    if (seen.has(c.name)) throw new Error(`cast: duplicate name "${c.name}"`)
    seen.add(c.name)
  }

  // --- separator ---
  while (i < lines.length && (peek() ?? '').trim() === '') i++
  if ((peek() ?? '').trim() !== '---') {
    fail(lineNo(), `expected "---" separator between Cast and Steps`)
  }
  consume()

  // --- Steps
  const castNames = new Set(cast.map(c => c.name))
  const steps: Step[] = []
  while (i < lines.length) {
    const ln = peek() ?? ''
    if (ln.trim() === '') { i++; continue }
    if (!/^##\s+Step\s+\d+/.test(ln)) {
      fail(lineNo(), `expected "## Step <N> — <title>"`)
    }
    steps.push(parseStep(lines, () => i, (n) => { i = n }, steps.length, castNames))
  }
  if (steps.length === 0) throw new Error('steps: at least one step required')

  // Verify contiguous numbering 1..N
  // (parseStep already validates the number; this is a belt-and-suspenders check.)

  return {
    id: crypto.randomUUID(),
    name,
    title,
    ...(premise ? { premise } : {}),
    cast,
    steps,
    source,
  }
}

const parseCastMember = (
  lines: string[],
  getI: () => number,
  setI: (n: number) => void,
): CastMember => {
  let i = getI()
  const lineNo = (): number => i + 1
  const head = lines[i] ?? ''
  const m = /^###\s+([^\s(].*?)(?:\s+\(starts\))?\s*$/.exec(head)
  if (!m) fail(lineNo(), `bad cast heading: "${head}"`)
  const name = m![1]!.trim()
  const starts = /\(starts\)\s*$/.test(head)
  if (!name) fail(lineNo(), `cast name missing`)
  i++

  let model = ''
  let persona = ''
  let tools: ReadonlyArray<string> | undefined
  let includeTools: boolean | undefined

  while (i < lines.length) {
    const ln = lines[i] ?? ''
    if (ln.trim() === '') { i++; continue }
    if (/^###\s/.test(ln) || /^##\s/.test(ln) || ln.trim() === '---') break
    const bullet = /^-\s+([a-zA-Z]+):\s*(.*)$/.exec(ln)
    if (!bullet) {
      fail(i + 1, `expected "- key: value" bullet (got "${ln.slice(0, 60)}…")`)
    }
    const key = bullet![1]!
    const rest = bullet![2] ?? ''
    if (!CAST_BULLET_KEYS.has(key)) {
      fail(i + 1, `unknown cast key "${key}" (allowed: ${[...CAST_BULLET_KEYS].join(', ')})`)
    }
    if (key === 'model') {
      model = rest.trim()
      i++
    } else if (key === 'tools') {
      tools = parseToolList(rest, i + 1)
      i++
    } else if (key === 'includeTools') {
      const v = rest.trim()
      if (v !== 'true' && v !== 'false') fail(i + 1, `includeTools must be true|false`)
      includeTools = v === 'true'
      i++
    } else if (key === 'persona') {
      // Multiline if "|" present, otherwise inline.
      if (rest.trim() === '|') {
        i++
        const block: string[] = []
        while (i < lines.length) {
          const pl = lines[i] ?? ''
          if (pl === '') { block.push(''); i++; continue }
          if (/^\s{2,}/.test(pl)) {
            block.push(pl.replace(/^\s{2,}/, ''))
            i++
            continue
          }
          break
        }
        persona = block.join('\n').trim()
      } else {
        persona = rest.trim()
        i++
      }
    } else {
      // includePrompts / includeContext — bullet expects inline JSON object
      // (advanced usage; not documented in the simple grammar but supported)
      fail(i + 1, `${key} not yet supported in markdown form — omit for now`)
    }
  }

  if (!model) fail(getI() + 1, `cast "${name}": model required`)
  if (!persona) fail(getI() + 1, `cast "${name}": persona required`)

  setI(i)
  const out: { -readonly [K in keyof CastMember]: CastMember[K] } = {
    name, persona, model,
  }
  if (starts) out.starts = true
  if (tools) out.tools = tools
  if (includeTools !== undefined) out.includeTools = includeTools
  return out
}

const parseToolList = (raw: string, line: number): ReadonlyArray<string> => {
  const trimmed = raw.trim()
  if (trimmed === '') return []
  // [a, b, c] form
  const bracket = /^\[(.*)\]$/.exec(trimmed)
  const body = bracket ? bracket[1]! : trimmed
  const parts = body.split(',').map(s => s.trim()).filter(s => s.length > 0)
  for (const p of parts) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(p)) {
      fail(line, `tool name "${p}" invalid`)
    }
  }
  return parts
}

const parseStep = (
  lines: string[],
  getI: () => number,
  setI: (n: number) => void,
  expectedIndex: number,
  castNames: ReadonlySet<string>,
): Step => {
  let i = getI()
  const head = lines[i] ?? ''
  const m = /^##\s+Step\s+(\d+)(?:\s+(?:—|–|--|-)\s+(.+?))?\s*$/.exec(head)
  if (!m) fail(i + 1, `bad step heading: "${head}"`)
  const num = Number(m![1])
  if (num !== expectedIndex + 1) {
    fail(i + 1, `expected "## Step ${expectedIndex + 1}" (got ${num})`)
  }
  const title = (m![2] ?? '').trim()
  if (!title) fail(i + 1, `step ${num}: title required after separator`)
  i++

  let goal: string | undefined
  const roles: Record<string, string> = {}
  let inRolesBlock = false

  while (i < lines.length) {
    const ln = lines[i] ?? ''
    if (ln.trim() === '') { i++; continue }
    if (/^##\s/.test(ln)) break

    if (!inRolesBlock) {
      const goalM = /^Goal:\s*(.+?)\s*$/.exec(ln)
      if (goalM) { goal = goalM[1]!.trim(); i++; continue }
      if (/^Roles:\s*$/.test(ln)) { inRolesBlock = true; i++; continue }
      fail(i + 1, `step ${num}: expected "Goal:", "Roles:", or next "## Step"`)
    } else {
      // Roles lines: indented "<CastName> — <role>"
      const indented = /^\s+(.+?)\s*$/.exec(ln)
      if (!indented) {
        // Unindented non-step line ends the Roles block
        break
      }
      const body = indented[1]!
      const sep = body.match(ROLE_SEP)
      if (!sep || sep.index === undefined) {
        fail(i + 1, `step ${num}: expected "<CastName> — <role>" (got "${body}")`)
      }
      const sepIdx = sep.index
      const castName = body.slice(0, sepIdx).trim()
      const role = body.slice(sepIdx + sep[0].length).trim()
      if (!castNames.has(castName)) {
        fail(i + 1, `step ${num}: cast name "${castName}" not in cast`)
      }
      if (!role) fail(i + 1, `step ${num}: role for "${castName}" is empty`)
      if (roles[castName]) fail(i + 1, `step ${num}: duplicate role for "${castName}"`)
      roles[castName] = role
      i++
    }
  }

  // Default missing roles to empty (renderer shows "—").
  for (const c of castNames) {
    if (!(c in roles)) roles[c] = ''
  }

  setI(i)
  return {
    index: expectedIndex,
    title,
    ...(goal ? { goal } : {}),
    roles,
  }
}

// === Test exports ===
export const __test = { parseToolList }
