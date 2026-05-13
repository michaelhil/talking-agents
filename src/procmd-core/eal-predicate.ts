// EAL predicate parser + evaluator (Phase F.1).
//
// Predicate grammar (v1):
//
//   expr      := term (('AND' | 'OR') term)*
//   term      := atom | '(' expr ')'
//   atom      := tag op value [duration]
//   tag       := '«' [A-Z][A-Z0-9-]* '»'
//   op        := '<' | '>' | '<=' | '>=' | '==' | '!='
//   value     := number | quoted-string | bareword
//   duration  := 'for' ('>=' | '>') number unit
//   unit      := 's' | 'min' | 'h'
//
// Single-tag predicates only for v1. Boolean-state ops use string equality
// against the value (`«TAG» == OPEN`). Tag-vs-tag comparison and set-of-
// conditions deferred to F.5.
//
// Evaluation is time-series aware: a predicate with a DURATION clause is
// true at time T only if the underlying tag-op-value comparison has been
// continuously satisfied from (T - duration) through T inclusive.

import type { EalClass } from './types.ts'

export type PredicateOp = '<' | '>' | '<=' | '>=' | '==' | '!='

export interface PredicateAtom {
  readonly kind: 'atom'
  readonly tag: string
  readonly op: PredicateOp
  readonly value: string | number
  /** Duration constraint in seconds; if set, the atom must be satisfied
   *  continuously for at least this long. */
  readonly durationS?: number
}

export interface PredicateBoolean {
  readonly kind: 'bool'
  readonly op: 'AND' | 'OR'
  readonly children: ReadonlyArray<Predicate>
}

export type Predicate = PredicateAtom | PredicateBoolean

export interface PredicateParseError {
  readonly error: string
  readonly position: number
}

export type PredicateParseResult = Predicate | PredicateParseError

// === Lexer ================================================================

type Token =
  | { kind: 'tag'; value: string; pos: number }
  | { kind: 'op'; value: PredicateOp; pos: number }
  | { kind: 'number'; value: number; pos: number }
  | { kind: 'word'; value: string; pos: number }
  | { kind: 'string'; value: string; pos: number }
  | { kind: 'and' | 'or' | 'for' | 'lparen' | 'rparen'; pos: number }

const tokenize = (input: string): { tokens: Token[] } | PredicateParseError => {
  const tokens: Token[] = []
  let i = 0
  while (i < input.length) {
    const ch = input[i]!
    if (/\s/.test(ch)) { i++; continue }
    if (ch === '(') { tokens.push({ kind: 'lparen', pos: i }); i++; continue }
    if (ch === ')') { tokens.push({ kind: 'rparen', pos: i }); i++; continue }
    if (ch === '«') {
      const end = input.indexOf('»', i)
      if (end === -1) return { error: "unterminated tag (missing '»')", position: i }
      const tag = input.slice(i + 1, end)
      if (!/^[A-Z][A-Z0-9-]*$/.test(tag)) return { error: `bad tag id '${tag}'`, position: i }
      tokens.push({ kind: 'tag', value: tag, pos: i })
      i = end + 1
      continue
    }
    if (ch === '"' || ch === "'") {
      const quote = ch
      const end = input.indexOf(quote, i + 1)
      if (end === -1) return { error: 'unterminated string', position: i }
      tokens.push({ kind: 'string', value: input.slice(i + 1, end), pos: i })
      i = end + 1
      continue
    }
    // Operators
    const two = input.slice(i, i + 2)
    if (two === '<=' || two === '>=' || two === '==' || two === '!=') {
      tokens.push({ kind: 'op', value: two as PredicateOp, pos: i })
      i += 2
      continue
    }
    if (ch === '<' || ch === '>') {
      tokens.push({ kind: 'op', value: ch as PredicateOp, pos: i })
      i++
      continue
    }
    // Number (allow negative + decimal)
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(input[i + 1] ?? ''))) {
      const m = input.slice(i).match(/^-?\d+(\.\d+)?/)
      if (!m) return { error: 'malformed number', position: i }
      tokens.push({ kind: 'number', value: parseFloat(m[0]), pos: i })
      i += m[0].length
      continue
    }
    // Word: AND / OR / FOR / bareword
    const m = input.slice(i).match(/^[A-Za-z_][A-Za-z0-9_-]*/)
    if (m) {
      const w = m[0]
      const up = w.toUpperCase()
      if (up === 'AND') tokens.push({ kind: 'and', pos: i })
      else if (up === 'OR') tokens.push({ kind: 'or', pos: i })
      else if (up === 'FOR') tokens.push({ kind: 'for', pos: i })
      else tokens.push({ kind: 'word', value: w, pos: i })
      i += w.length
      continue
    }
    return { error: `unexpected character '${ch}'`, position: i }
  }
  return { tokens }
}

// === Parser (left-to-right, explicit parens; no precedence) ==============

const parseTokens = (tokens: Token[]): PredicateParseResult => {
  let pos = 0
  const peek = (): Token | undefined => tokens[pos]
  const consume = (): Token | undefined => tokens[pos++]

  const parseAtom = (): PredicateParseResult => {
    const tagTok = consume()
    if (!tagTok || tagTok.kind !== 'tag') {
      return { error: 'expected «TAG» at start of atom', position: tagTok?.pos ?? 0 }
    }
    const opTok = consume()
    if (!opTok || opTok.kind !== 'op') {
      return { error: 'expected comparison operator after tag', position: opTok?.pos ?? 0 }
    }
    const valTok = consume()
    if (!valTok) return { error: 'expected value after operator', position: 0 }
    let value: string | number
    if (valTok.kind === 'number') value = valTok.value
    else if (valTok.kind === 'string') value = valTok.value
    else if (valTok.kind === 'word') value = valTok.value
    else return { error: 'expected number, string, or bareword as value', position: valTok.pos }

    // Optional duration clause: FOR >= N UNIT  (FOR > N UNIT also accepted)
    let durationS: number | undefined
    if (peek()?.kind === 'for') {
      consume() // for
      const opT = consume()
      if (!opT || opT.kind !== 'op' || (opT.value !== '>=' && opT.value !== '>')) {
        return { error: "expected '>=' or '>' after 'for'", position: opT?.pos ?? 0 }
      }
      const numT = consume()
      if (!numT || numT.kind !== 'number') return { error: 'expected duration number', position: numT?.pos ?? 0 }
      const unitT = consume()
      if (!unitT || unitT.kind !== 'word') return { error: "expected duration unit ('s', 'min', 'h')", position: unitT?.pos ?? 0 }
      const unit = unitT.value.toLowerCase()
      const mult = unit === 's' ? 1 : unit === 'min' ? 60 : unit === 'h' ? 3600 : 0
      if (mult === 0) return { error: `unknown duration unit '${unit}'`, position: unitT.pos }
      durationS = numT.value * mult
    }
    return { kind: 'atom', tag: tagTok.value, op: opTok.value, value, ...(durationS !== undefined ? { durationS } : {}) }
  }

  const parseTerm = (): PredicateParseResult => {
    const t = peek()
    if (!t) return { error: 'unexpected end of predicate', position: 0 }
    if (t.kind === 'lparen') {
      consume()
      const inner = parseExpr()
      if ('error' in inner) return inner
      const close = consume()
      if (!close || close.kind !== 'rparen') return { error: "expected ')'", position: close?.pos ?? 0 }
      return inner
    }
    return parseAtom()
  }

  const parseExpr = (): PredicateParseResult => {
    let left = parseTerm()
    if ('error' in left) return left
    while (true) {
      const next = peek()
      if (!next || (next.kind !== 'and' && next.kind !== 'or')) break
      const op = next.kind === 'and' ? 'AND' : 'OR'
      consume()
      const right = parseTerm()
      if ('error' in right) return right
      // Flatten consecutive same-op into a single n-ary node
      if (left.kind === 'bool' && left.op === op) {
        left = { kind: 'bool', op, children: [...left.children, right] }
      } else {
        left = { kind: 'bool', op, children: [left, right] }
      }
    }
    return left
  }

  const result = parseExpr()
  if ('error' in result) return result
  if (pos !== tokens.length) {
    const extra = tokens[pos]
    return { error: `trailing tokens after expression (starting near position ${extra?.pos ?? 0})`, position: extra?.pos ?? 0 }
  }
  return result
}

export const parsePredicate = (input: string): PredicateParseResult => {
  const lex = tokenize(input.trim())
  if ('error' in lex) return lex
  if (lex.tokens.length === 0) return { error: 'empty predicate', position: 0 }
  return parseTokens(lex.tokens)
}

// === Evaluation ===========================================================

export interface ProjectedSample {
  readonly atTimeS: number
  readonly state: Readonly<Record<string, string | number | boolean>>
}

const cmp = (a: unknown, op: PredicateOp, b: string | number): boolean => {
  // Numeric comparison when both can be coerced to number; otherwise string.
  if (typeof a === 'number' && typeof b === 'number') {
    switch (op) {
      case '<': return a < b
      case '>': return a > b
      case '<=': return a <= b
      case '>=': return a >= b
      case '==': return a === b
      case '!=': return a !== b
    }
  }
  const aStr = String(a)
  const bStr = String(b)
  switch (op) {
    case '==': return aStr === bStr
    case '!=': return aStr !== bStr
    // Lexicographic ordering for strings — unusual but defined; predicates
    // that mix string values with </> are author error.
    case '<': return aStr < bStr
    case '>': return aStr > bStr
    case '<=': return aStr <= bStr
    case '>=': return aStr >= bStr
  }
}

const evalAtomInstant = (atom: PredicateAtom, state: Readonly<Record<string, unknown>>): boolean => {
  const v = state[atom.tag]
  if (v === undefined) return false
  return cmp(v, atom.op, atom.value)
}

/**
 * Evaluate a predicate against a time-series of projected samples. Returns
 * the earliest sample time at which the predicate is satisfied (with any
 * DURATION dwell completed), or null if never satisfied within the series.
 */
export const evalPredicateOverTimeSeries = (
  pred: Predicate,
  samples: ReadonlyArray<ProjectedSample>,
): number | null => {
  if (samples.length === 0) return null
  if (pred.kind === 'atom') {
    let firstSatisfiedAt: number | null = null
    for (const s of samples) {
      const sat = evalAtomInstant(pred, s.state)
      if (sat) {
        if (firstSatisfiedAt === null) firstSatisfiedAt = s.atTimeS
        const required = pred.durationS ?? 0
        if (s.atTimeS - firstSatisfiedAt >= required) return firstSatisfiedAt + required
      } else {
        firstSatisfiedAt = null
      }
    }
    return null
  }
  // Boolean composition: evaluate each child's first-satisfied time, then
  // combine. AND: max of all child times if all non-null. OR: min of any.
  const childTimes = pred.children.map(c => evalPredicateOverTimeSeries(c, samples))
  if (pred.op === 'AND') {
    if (childTimes.some(t => t === null)) return null
    return Math.max(...(childTimes as number[]))
  }
  const nonNull = childTimes.filter((t): t is number => t !== null)
  return nonNull.length === 0 ? null : Math.min(...nonNull)
}

// === Predicate tag enumeration ===========================================

/** Walk a parsed predicate and return every tag id it references. */
export const tagsInPredicate = (pred: Predicate): ReadonlyArray<string> => {
  const out: string[] = []
  const walk = (p: Predicate): void => {
    if (p.kind === 'atom') out.push(p.tag)
    else for (const c of p.children) walk(c)
  }
  walk(pred)
  return [...new Set(out)]
}

// === EAL classification ===================================================

export interface EalRule {
  readonly ic: string
  readonly predicate: string
  readonly class: EalClass
  readonly source: string
}

export interface EalRulesFile {
  readonly version: 1
  readonly wiki: string
  readonly rules: ReadonlyArray<EalRule>
}

export interface EalClassificationResult {
  readonly highestClass: EalClass | null
  readonly firstReachedAtS: number | null
  readonly matchingIc: string | null
  readonly matchingSource: string | null
}

const CLASS_RANK: Record<EalClass, number> = { UE: 1, Alert: 2, SAE: 3, GE: 4 }

/**
 * Classify a scenario by evaluating every EAL rule against the projected
 * time-series, returning the highest class reached (with the IC code and
 * source citation for traceability).
 */
export const classifyEal = (
  rules: ReadonlyArray<EalRule>,
  samples: ReadonlyArray<ProjectedSample>,
): EalClassificationResult => {
  let best: { cls: EalClass; t: number; ic: string; source: string } | null = null
  for (const rule of rules) {
    const parsed = parsePredicate(rule.predicate)
    if ('error' in parsed) continue  // malformed rule — skip; validator catches at build time
    const firstAt = evalPredicateOverTimeSeries(parsed, samples)
    if (firstAt === null) continue
    if (best === null || CLASS_RANK[rule.class] > CLASS_RANK[best.cls] ||
        (CLASS_RANK[rule.class] === CLASS_RANK[best.cls] && firstAt < best.t)) {
      best = { cls: rule.class, t: firstAt, ic: rule.ic, source: rule.source }
    }
  }
  if (best === null) {
    return { highestClass: null, firstReachedAtS: null, matchingIc: null, matchingSource: null }
  }
  return { highestClass: best.cls, firstReachedAtS: best.t, matchingIc: best.ic, matchingSource: best.source }
}

// === Scenario projection ==================================================

/** Build a time-series of projected states from a scenario's initial state
 *  + injection list. The series includes t=0, every injection time, and an
 *  implicit final sample at `lastInjection + 60s`. */
export const projectScenarioTimeline = (
  initialState: Readonly<Record<string, string | number | boolean>>,
  injections: ReadonlyArray<{ tag: string; value: string | number | boolean; atTimeS: number }>,
): ProjectedSample[] => {
  const sorted = [...injections].sort((a, b) => a.atTimeS - b.atTimeS)
  const samples: ProjectedSample[] = []
  let cur: Record<string, string | number | boolean> = { ...initialState }
  samples.push({ atTimeS: 0, state: { ...cur } })
  for (const inj of sorted) {
    cur = { ...cur, [inj.tag]: inj.value }
    samples.push({ atTimeS: inj.atTimeS, state: { ...cur } })
  }
  const tail = sorted.length > 0 ? sorted[sorted.length - 1]!.atTimeS + 60 : 60
  samples.push({ atTimeS: tail, state: { ...cur } })
  return samples
}
