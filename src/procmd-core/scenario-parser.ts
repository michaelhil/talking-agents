// procmd-core scenario parser (Phase F.0).
//
// Parses `wiki/scenarios/*.md` files. Frontmatter is simple key:value
// (re-uses the same shape as procedures); structured data lives in fenced
// JSON code blocks under canonical section headings. See ParsedScenario
// in types.ts for the file layout.

import type { ParsedScenario, ScenarioInjection, ScenarioParseResult } from './types.ts'

const SECTION_HEADINGS = {
  initialState: 'Initial state',
  injections: 'Injections',
  expectedTraversal: 'Expected traversal',
  expectedTerminalState: 'Expected terminal state',
} as const

interface FrontmatterResult {
  readonly fields: Record<string, string>
  readonly body: string
  readonly errors: ReadonlyArray<string>
}

const parseFrontmatter = (source: string): FrontmatterResult => {
  const errors: string[] = []
  if (!source.startsWith('---\n') && !source.startsWith('---\r\n')) {
    return { fields: {}, body: source, errors: ['missing frontmatter block'] }
  }
  const lines = source.split('\n')
  let endIdx = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { endIdx = i; break }
  }
  if (endIdx === -1) {
    errors.push('frontmatter block not closed')
    return { fields: {}, body: source, errors }
  }
  const fields: Record<string, string> = {}
  for (let i = 1; i < endIdx; i++) {
    const ln = lines[i] ?? ''
    if (!ln.trim()) continue
    const m = ln.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!m) { errors.push(`frontmatter line ${i + 1}: cannot parse '${ln}'`); continue }
    fields[m[1]!] = m[2]!.trim()
  }
  return { fields, body: lines.slice(endIdx + 1).join('\n'), errors }
}

/**
 * Extract the first ```json fenced block under `## <heading>`. Returns the
 * raw JSON string, or null if no such block exists.
 */
const extractJsonSection = (body: string, heading: string): string | null => {
  const lines = body.split('\n')
  let inSection = false
  let inFence = false
  const collected: string[] = []
  for (const ln of lines) {
    if (/^##\s+/.test(ln)) {
      const isOurs = ln.replace(/^##\s+/, '').trim().toLowerCase() === heading.toLowerCase()
      if (isOurs) { inSection = true; continue }
      if (inSection) break // next ## ends our section
      continue
    }
    if (!inSection) continue
    if (/^```json\b/.test(ln)) { inFence = true; continue }
    if (/^```/.test(ln) && inFence) { inFence = false; break }
    if (inFence) collected.push(ln)
  }
  return inFence === false && collected.length === 0 ? null : collected.join('\n').trim() || null
}

const safeParseJson = <T>(raw: string | null, section: string, warnings: string[]): T | null => {
  if (raw === null) return null
  try {
    return JSON.parse(raw) as T
  } catch (err) {
    warnings.push(`section '${section}' is not valid JSON: ${(err as Error).message}`)
    return null
  }
}

const validateStateMap = (
  value: unknown,
  section: string,
  warnings: string[],
): Record<string, string | number | boolean> => {
  if (value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    warnings.push(`section '${section}' must be a JSON object (got ${Array.isArray(value) ? 'array' : typeof value})`)
    return {}
  }
  const out: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v
    } else {
      warnings.push(`section '${section}' key '${k}' must be string|number|boolean (got ${typeof v}); dropped`)
    }
  }
  return out
}

const validateInjections = (
  value: unknown,
  warnings: string[],
): ScenarioInjection[] => {
  if (value === null) return []
  if (!Array.isArray(value)) {
    warnings.push(`section 'Injections' must be a JSON array (got ${typeof value})`)
    return []
  }
  const out: ScenarioInjection[] = []
  for (let i = 0; i < value.length; i++) {
    const item = value[i] as Record<string, unknown>
    if (!item || typeof item !== 'object') {
      warnings.push(`injection ${i}: must be an object`)
      continue
    }
    const tag = item.tag
    const v = item.value
    const at = (item['at-time-s'] ?? item.atTimeS) as unknown
    if (typeof tag !== 'string' || !tag) {
      warnings.push(`injection ${i}: missing or non-string 'tag'`)
      continue
    }
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      warnings.push(`injection ${i}: 'value' must be string|number|boolean`)
      continue
    }
    if (typeof at !== 'number') {
      warnings.push(`injection ${i}: 'at-time-s' must be a number (seconds since scenario start)`)
      continue
    }
    out.push({ tag, value: v, atTimeS: at })
  }
  return out
}

const validateTraversal = (value: unknown, warnings: string[]): string[] => {
  if (value === null) return []
  if (!Array.isArray(value)) {
    warnings.push(`section 'Expected traversal' must be a JSON array of "<procedure-id>#<step-id>" strings`)
    return []
  }
  const out: string[] = []
  for (let i = 0; i < value.length; i++) {
    const v = value[i]
    if (typeof v !== 'string') {
      warnings.push(`traversal entry ${i}: must be a string`)
      continue
    }
    if (!/^[A-Z][A-Z0-9.-]*#[a-z0-9][a-z0-9-]*$/.test(v)) {
      warnings.push(`traversal entry ${i} '${v}': expected '<procedure-id>#<step-id>'`)
    }
    out.push(v)
  }
  return out
}

export const parseScenario = (source: string): ScenarioParseResult => {
  const fm = parseFrontmatter(source)
  if (fm.errors.length > 0) return { error: fm.errors.join('; ') }
  const type = fm.fields['type'] ?? ''
  if (type !== 'scenario') return { error: `expected frontmatter type 'scenario', got '${type}'` }
  const scenarioId = fm.fields['scenario-id'] ?? ''
  if (!scenarioId) return { error: 'missing frontmatter scenario-id' }
  const title = fm.fields['title'] ?? scenarioId

  const warnings: string[] = []

  // Preamble: prose between frontmatter end and first `## ` heading
  const preambleLines: string[] = []
  for (const ln of fm.body.split('\n')) {
    if (/^##\s+/.test(ln)) break
    preambleLines.push(ln)
  }
  const preamble = preambleLines.join('\n').trim()

  const initialState = validateStateMap(
    safeParseJson<unknown>(extractJsonSection(fm.body, SECTION_HEADINGS.initialState), SECTION_HEADINGS.initialState, warnings),
    SECTION_HEADINGS.initialState,
    warnings,
  )
  const injections = validateInjections(
    safeParseJson<unknown>(extractJsonSection(fm.body, SECTION_HEADINGS.injections), SECTION_HEADINGS.injections, warnings),
    warnings,
  )
  const expectedTraversal = validateTraversal(
    safeParseJson<unknown>(extractJsonSection(fm.body, SECTION_HEADINGS.expectedTraversal), SECTION_HEADINGS.expectedTraversal, warnings),
    warnings,
  )
  const expectedTerminalState = validateStateMap(
    safeParseJson<unknown>(extractJsonSection(fm.body, SECTION_HEADINGS.expectedTerminalState), SECTION_HEADINGS.expectedTerminalState, warnings),
    SECTION_HEADINGS.expectedTerminalState,
    warnings,
  )

  const parsed: ParsedScenario = {
    scenarioId,
    title,
    preamble,
    initialState,
    injections,
    expectedTraversal,
    expectedTerminalState,
    warnings,
  }
  return parsed
}
