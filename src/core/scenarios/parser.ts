// ============================================================================
// Scenario markdown parser — top-level orchestration.
//
// Format:
//   ---
//   title: <string>
//   description: <string>           ← optional
//   ---
//   <free narration markdown>
//
//   ```scenario
//   - <op-name>: <inline-arg>       ← single string arg, OR
//   - <op-name>: { k: v, k: "v" }   ← inline object, OR
//   - <op-name>:                    ← block object
//       key: value
//       body: |
//         multi
//         line
//   ```
//
// Multiple ```scenario blocks in one file are concatenated. Non-fenced
// markdown becomes `narration` (rendered in the consent dialog).
//
// Implementation is split across:
//   - errors.ts       — ScenarioParseError
//   - yaml-mini.ts    — generic YAML-subset parsing (inline obj, block obj)
//   - op-builder.ts   — args→typed-op + parse-time name resolution
//   - parser.ts (this file) — frontmatter + body splitting + entry walk
// ============================================================================

import type { Scenario, ScenarioFrontmatter, ScenarioOp } from './types.ts'
import { ScenarioParseError } from './errors.ts'
import { parseInlineObject, parseBlockObject, unquote } from './yaml-mini.ts'
import { buildOp, validateNameReferences } from './op-builder.ts'

export { ScenarioParseError } from './errors.ts'

export const VALID_NAME = /^[a-z0-9][a-z0-9_-]*$/

// === Top-level entry ===

export const parseScenario = (
  pack: string,
  name: string,
  source: string,
): Scenario => {
  const { frontmatter, body, frontmatterEndLine } = parseFrontmatter(source)
  if (!frontmatter.title) {
    throw new ScenarioParseError('frontmatter must declare title', 1)
  }
  const { narration, ops } = parseBody(body, frontmatterEndLine + 1)
  validateNameReferences(ops)
  return {
    id: `${pack}/${name}`,
    pack,
    name,
    title: frontmatter.title,
    ...(frontmatter.description ? { description: frontmatter.description } : {}),
    ...(frontmatter.category ? { category: frontmatter.category } : {}),
    source,
    narration,
    ops,
  }
}

// === Frontmatter ===

const parseFrontmatter = (
  source: string,
): { frontmatter: ScenarioFrontmatter; body: string; frontmatterEndLine: number } => {
  const lines = source.split('\n')
  if (lines[0]?.trim() !== '---') {
    throw new ScenarioParseError('scenario must begin with --- frontmatter fence', 1)
  }
  const endIdx = lines.indexOf('---', 1)
  if (endIdx === -1) {
    throw new ScenarioParseError('opening --- without closing ---', 1)
  }
  let title: string | undefined
  let description: string | undefined
  let category: 'demo' | 'tutorial' | 'onboarding' | undefined
  for (let i = 1; i < endIdx; i++) {
    const line = lines[i] ?? ''
    if (line.trim() === '') continue
    const m = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/)
    if (!m) throw new ScenarioParseError(`invalid frontmatter line: "${line}"`, i + 1)
    const key = m[1]!
    const val = unquote(m[2]!.trim())
    if (key === 'title') title = val
    else if (key === 'description') description = val
    else if (key === 'category') {
      if (val !== 'demo' && val !== 'tutorial' && val !== 'onboarding') {
        throw new ScenarioParseError(`invalid category "${val}" — must be demo, tutorial, or onboarding`, i + 1)
      }
      category = val
    }
    // Unknown keys are silently ignored — forwards-compatible.
  }
  if (!title) throw new ScenarioParseError('frontmatter must declare title', 1)
  const body = lines.slice(endIdx + 1).join('\n')
  const frontmatter: ScenarioFrontmatter = {
    title,
    ...(description ? { description } : {}),
    ...(category ? { category } : {}),
  }
  return {
    frontmatter,
    body,
    frontmatterEndLine: endIdx + 1,
  }
}

// === Body: narration + ```scenario blocks ===

const SCENARIO_FENCE_OPEN = /^```scenario\s*$/
const FENCE_CLOSE = /^```\s*$/

const parseBody = (
  body: string,
  bodyStartLine: number,
): { narration: string; ops: ReadonlyArray<ScenarioOp> } => {
  const lines = body.split('\n')
  const narrationLines: string[] = []
  const ops: ScenarioOp[] = []

  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (SCENARIO_FENCE_OPEN.test(line)) {
      const blockStart = i + 1
      let j = blockStart
      while (j < lines.length && !FENCE_CLOSE.test(lines[j]!)) j++
      if (j >= lines.length) {
        throw new ScenarioParseError('unterminated ```scenario block', bodyStartLine + i)
      }
      const blockLines = lines.slice(blockStart, j)
      const blockOps = parseScenarioBlock(blockLines, bodyStartLine + blockStart)
      ops.push(...blockOps)
      i = j + 1
    } else {
      narrationLines.push(line)
      i++
    }
  }

  return { narration: narrationLines.join('\n').trim(), ops }
}

// === ```scenario block parser ===
//
// Each top-level entry begins with `- <op>:`. Indentation under an entry
// belongs to that op's block-form fields. We split into entries by scanning
// for lines that match LIST_ENTRY at the base indent (the indent of the
// first `- `).

const LIST_ENTRY = /^(\s*)-\s+([a-z][a-z0-9-]*):\s*(.*)$/

const parseScenarioBlock = (
  blockLines: ReadonlyArray<string>,
  startAbsLine: number,
): ScenarioOp[] => {
  // Find base indent from first non-empty line.
  let baseIndent = 0
  let firstIdx = -1
  for (let i = 0; i < blockLines.length; i++) {
    const l = blockLines[i]!
    if (l.trim() === '') continue
    const m = l.match(LIST_ENTRY)
    if (!m) {
      throw new ScenarioParseError(
        `expected "- <op>: ..." at start of block, got "${l}"`,
        startAbsLine + i,
      )
    }
    baseIndent = m[1]!.length
    firstIdx = i
    break
  }
  if (firstIdx === -1) return []   // empty block — fine

  const ops: ScenarioOp[] = []
  let i = firstIdx
  while (i < blockLines.length) {
    const line = blockLines[i]!
    if (line.trim() === '') { i++; continue }
    const m = line.match(LIST_ENTRY)
    if (!m || m[1]!.length !== baseIndent) {
      throw new ScenarioParseError(
        `expected list entry at indent ${baseIndent}, got "${line}"`,
        startAbsLine + i,
      )
    }
    const opName = m[2]!
    const rest = m[3]!.trim()
    // Determine entry span: include all subsequent lines indented MORE than
    // baseIndent (block fields belong to this entry).
    let j = i + 1
    while (j < blockLines.length) {
      const nl = blockLines[j]!
      if (nl.trim() === '') { j++; continue }
      const nm = nl.match(/^(\s*)/)
      const ind = nm?.[1]?.length ?? 0
      if (ind <= baseIndent) break
      j++
    }
    const entryFollowLines = blockLines.slice(i + 1, j)
    const op = parseEntry(opName, rest, entryFollowLines, startAbsLine + i)
    ops.push(op)
    i = j
  }
  return ops
}

// === One op-entry: dispatches to inline-string / inline-object / block-object ===

const parseEntry = (
  opName: string,
  inlineRest: string,
  followLines: ReadonlyArray<string>,
  absLine: number,
): ScenarioOp => {
  // Three forms:
  //   inline string arg:   - install-pack: samsinn-packs/aviation
  //   inline object:       - create-room: { name: "X" }
  //   block object:        - post-message:\n    room: X\n    body: |\n      ...
  const args = inlineRest.startsWith('{')
    ? parseInlineObject(inlineRest, absLine)
    : inlineRest === ''
      ? parseBlockObject(followLines, absLine + 1)
      : { __single: inlineRest }   // bare string, op-specific handling in buildOp

  return buildOp(opName, args, absLine)
}
