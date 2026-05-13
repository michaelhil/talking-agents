import { describe, expect, test } from 'bun:test'
import {
  parsePredicate,
  evalPredicateOverTimeSeries,
  projectScenarioTimeline,
  classifyEal,
  tagsInPredicate,
} from './eal-predicate.ts'
import type { EalRule, ProjectedSample } from './eal-predicate.ts'

describe('parsePredicate — atoms', () => {
  test('single-tag numeric comparison', () => {
    const r = parsePredicate('«PT-455» < 1815')
    if ('error' in r) throw new Error(r.error)
    expect(r.kind).toBe('atom')
    if (r.kind === 'atom') {
      expect(r.tag).toBe('PT-455')
      expect(r.op).toBe('<')
      expect(r.value).toBe(1815)
      expect(r.durationS).toBeUndefined()
    }
  })

  test('string equality (e.g. valve state)', () => {
    const r = parsePredicate('«BUS-A-EMERG» == DEAD')
    if ('error' in r) throw new Error(r.error)
    if (r.kind === 'atom') expect(r.value).toBe('DEAD')
  })

  test('duration clause in seconds', () => {
    const r = parsePredicate('«BUS-A-EMERG» == DEAD for >= 900 s')
    if ('error' in r) throw new Error(r.error)
    if (r.kind === 'atom') expect(r.durationS).toBe(900)
  })

  test('duration clause in minutes', () => {
    const r = parsePredicate('«CET-AVG» >= 1200 for >= 15 min')
    if ('error' in r) throw new Error(r.error)
    if (r.kind === 'atom') expect(r.durationS).toBe(15 * 60)
  })

  test('duration clause in hours', () => {
    const r = parsePredicate('«PT-455» < 100 for > 1 h')
    if ('error' in r) throw new Error(r.error)
    if (r.kind === 'atom') expect(r.durationS).toBe(3600)
  })

  test('rejects unknown operator', () => {
    const r = parsePredicate('«PT-455» ~ 1000')
    expect('error' in r).toBe(true)
  })

  test('rejects bad tag id', () => {
    const r = parsePredicate('«lowercase» < 1')
    expect('error' in r).toBe(true)
  })

  test('rejects unterminated tag', () => {
    const r = parsePredicate('«PT-455 < 1000')
    expect('error' in r).toBe(true)
  })

  test('rejects unknown duration unit', () => {
    const r = parsePredicate('«PT-455» < 100 for >= 1 day')
    expect('error' in r).toBe(true)
  })
})

describe('parsePredicate — boolean composition', () => {
  test('AND of two atoms', () => {
    const r = parsePredicate('«PT-455» < 1815 AND «SG-A-LVL-NR» < 17')
    if ('error' in r) throw new Error(r.error)
    expect(r.kind).toBe('bool')
    if (r.kind === 'bool') {
      expect(r.op).toBe('AND')
      expect(r.children).toHaveLength(2)
    }
  })

  test('OR of two atoms', () => {
    const r = parsePredicate('«PT-455» < 1815 OR «SUB-MARGIN» < 0')
    if ('error' in r) throw new Error(r.error)
    if (r.kind === 'bool') expect(r.op).toBe('OR')
  })

  test('flattens consecutive same-op into one n-ary node', () => {
    const r = parsePredicate('«A» > 1 AND «B» > 2 AND «C» > 3')
    if ('error' in r) throw new Error(r.error)
    if (r.kind === 'bool') {
      expect(r.op).toBe('AND')
      expect(r.children).toHaveLength(3)
    }
  })

  test('explicit parens nest different operators', () => {
    const r = parsePredicate('(«A» > 1 OR «B» > 2) AND «C» > 3')
    if ('error' in r) throw new Error(r.error)
    if (r.kind === 'bool') {
      expect(r.op).toBe('AND')
      expect(r.children).toHaveLength(2)
      expect(r.children[0]!.kind).toBe('bool')
    }
  })

  test('rejects unbalanced parens', () => {
    const r = parsePredicate('(«A» > 1 AND «B» > 2')
    expect('error' in r).toBe(true)
  })
})

describe('tagsInPredicate', () => {
  test('deduplicates and flattens', () => {
    const p = parsePredicate('«A» > 1 AND «B» > 2 AND «A» < 5')
    if ('error' in p) throw new Error(p.error)
    expect([...tagsInPredicate(p)].sort()).toEqual(['A', 'B'])
  })
})

describe('evalPredicateOverTimeSeries — atoms', () => {
  test('rising threshold satisfied at first sample crossing', () => {
    const p = parsePredicate('«PT-455» < 1815')
    if ('error' in p) throw new Error(p.error)
    const samples: ProjectedSample[] = [
      { atTimeS: 0, state: { 'PT-455': 2235 } },
      { atTimeS: 30, state: { 'PT-455': 1600 } },
      { atTimeS: 60, state: { 'PT-455': 1500 } },
    ]
    expect(evalPredicateOverTimeSeries(p, samples)).toBe(30)
  })

  test('returns null when never satisfied', () => {
    const p = parsePredicate('«PT-455» < 500')
    if ('error' in p) throw new Error(p.error)
    const samples: ProjectedSample[] = [
      { atTimeS: 0, state: { 'PT-455': 2235 } },
      { atTimeS: 30, state: { 'PT-455': 1600 } },
    ]
    expect(evalPredicateOverTimeSeries(p, samples)).toBeNull()
  })

  test('DURATION: dwell completes after the required time', () => {
    const p = parsePredicate('«BUS-A» == DEAD for >= 900 s')
    if ('error' in p) throw new Error(p.error)
    const samples: ProjectedSample[] = [
      { atTimeS: 0, state: { 'BUS-A': 'LIVE' } },
      { atTimeS: 100, state: { 'BUS-A': 'DEAD' } },
      { atTimeS: 1000, state: { 'BUS-A': 'DEAD' } },
    ]
    // First satisfied at t=100; dwell completes at t=1000 (since 1000-100=900≥900)
    expect(evalPredicateOverTimeSeries(p, samples)).toBe(1000)
  })

  test('DURATION: dwell broken resets the clock', () => {
    const p = parsePredicate('«BUS-A» == DEAD for >= 900 s')
    if ('error' in p) throw new Error(p.error)
    const samples: ProjectedSample[] = [
      { atTimeS: 0, state: { 'BUS-A': 'LIVE' } },
      { atTimeS: 100, state: { 'BUS-A': 'DEAD' } },
      { atTimeS: 500, state: { 'BUS-A': 'LIVE' } }, // restored
      { atTimeS: 800, state: { 'BUS-A': 'DEAD' } }, // dead again, restart clock
      { atTimeS: 1600, state: { 'BUS-A': 'DEAD' } }, // still dead, 800s into new dwell — not yet 900
    ]
    expect(evalPredicateOverTimeSeries(p, samples)).toBeNull()
  })

  test('missing tag in state is treated as not-satisfied (no exception)', () => {
    const p = parsePredicate('«MISSING» > 0')
    if ('error' in p) throw new Error(p.error)
    expect(evalPredicateOverTimeSeries(p, [{ atTimeS: 0, state: {} }])).toBeNull()
  })
})

describe('evalPredicateOverTimeSeries — boolean composition', () => {
  test('AND returns max of children first-satisfied times', () => {
    const p = parsePredicate('«A» > 1 AND «B» > 2')
    if ('error' in p) throw new Error(p.error)
    const samples: ProjectedSample[] = [
      { atTimeS: 0, state: { A: 0, B: 0 } },
      { atTimeS: 10, state: { A: 5, B: 0 } },  // A satisfied at 10
      { atTimeS: 30, state: { A: 5, B: 5 } },  // B satisfied at 30; AND = max(10,30) = 30
    ]
    expect(evalPredicateOverTimeSeries(p, samples)).toBe(30)
  })

  test('OR returns min of children first-satisfied times', () => {
    const p = parsePredicate('«A» > 1 OR «B» > 2')
    if ('error' in p) throw new Error(p.error)
    const samples: ProjectedSample[] = [
      { atTimeS: 0, state: { A: 0, B: 0 } },
      { atTimeS: 10, state: { A: 5, B: 0 } },
      { atTimeS: 30, state: { A: 5, B: 5 } },
    ]
    expect(evalPredicateOverTimeSeries(p, samples)).toBe(10)
  })

  test('AND returns null when any child never satisfied', () => {
    const p = parsePredicate('«A» > 1 AND «B» > 100')
    if ('error' in p) throw new Error(p.error)
    const samples: ProjectedSample[] = [
      { atTimeS: 0, state: { A: 0, B: 0 } },
      { atTimeS: 10, state: { A: 5, B: 5 } },
    ]
    expect(evalPredicateOverTimeSeries(p, samples)).toBeNull()
  })
})

describe('projectScenarioTimeline', () => {
  test('builds samples at t=0, each injection, and tail = last+60', () => {
    const samples = projectScenarioTimeline(
      { A: 1, B: 'x' },
      [
        { tag: 'A', value: 5, atTimeS: 30 },
        { tag: 'B', value: 'y', atTimeS: 100 },
      ],
    )
    expect(samples.map(s => s.atTimeS)).toEqual([0, 30, 100, 160])
    expect(samples[0]!.state).toEqual({ A: 1, B: 'x' })
    expect(samples[2]!.state).toEqual({ A: 5, B: 'y' })
  })

  test('no injections produces t=0 and t=60 only', () => {
    const samples = projectScenarioTimeline({ A: 1 }, [])
    expect(samples.map(s => s.atTimeS)).toEqual([0, 60])
  })

  test('out-of-order injections are sorted by time', () => {
    const samples = projectScenarioTimeline(
      { A: 0 },
      [
        { tag: 'A', value: 2, atTimeS: 100 },
        { tag: 'A', value: 1, atTimeS: 30 },
      ],
    )
    expect(samples.map(s => s.atTimeS)).toEqual([0, 30, 100, 160])
    expect(samples[1]!.state.A).toBe(1)
    expect(samples[2]!.state.A).toBe(2)
  })
})

describe('classifyEal', () => {
  const RULES: EalRule[] = [
    { ic: 'SU4', predicate: '«PT-455» < 1815', class: 'UE', source: 'NEI 99-01 SU4' },
    { ic: 'SA5', predicate: '«PT-455» < 1500', class: 'Alert', source: 'NEI 99-01 SA5' },
    { ic: 'SS3', predicate: '«CET-AVG» >= 1200 for >= 15 min', class: 'SAE', source: 'NEI 99-01 SS3' },
  ]

  test('returns highest class reached in the time series', () => {
    const samples: ProjectedSample[] = [
      { atTimeS: 0, state: { 'PT-455': 2235 } },
      { atTimeS: 30, state: { 'PT-455': 1600 } },  // UE triggers (<1815)
      { atTimeS: 60, state: { 'PT-455': 1400 } },  // Alert triggers (<1500)
    ]
    const r = classifyEal(RULES, samples)
    expect(r.highestClass).toBe('Alert')
    expect(r.firstReachedAtS).toBe(60)
    expect(r.matchingIc).toBe('SA5')
  })

  test('returns nulls when no rule fires', () => {
    const samples: ProjectedSample[] = [
      { atTimeS: 0, state: { 'PT-455': 2235 } },
    ]
    const r = classifyEal(RULES, samples)
    expect(r.highestClass).toBeNull()
  })

  test('SAE requires DURATION dwell to elapse', () => {
    const samples: ProjectedSample[] = [
      { atTimeS: 0, state: { 'CET-AVG': 800 } },
      { atTimeS: 100, state: { 'CET-AVG': 1250 } },
      { atTimeS: 1100, state: { 'CET-AVG': 1250 } },  // 1000s elapsed, > 900s required
    ]
    const r = classifyEal(RULES, samples)
    expect(r.highestClass).toBe('SAE')
    expect(r.matchingIc).toBe('SS3')
    // First-reached is the moment dwell completes (100 + 900 = 1000)
    expect(r.firstReachedAtS).toBe(1000)
  })
})
