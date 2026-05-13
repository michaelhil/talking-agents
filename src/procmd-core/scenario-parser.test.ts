import { describe, expect, test } from 'bun:test'
import { parseScenario } from './scenario-parser.ts'

const SB_LOCA = `---
type: scenario
scenario-id: sb-loca
title: Small-break LOCA (3-inch cold-leg break)
---

Reactor at 100% power; a 3-inch cold-leg break in loop 1 develops over 30 s.
Crew enters E-0 on safety injection.

## Initial state
\`\`\`json
{ "PT-455": 2235, "SG-A-LVL-NR": 50, "RCS-TEMP-HOT": 612 }
\`\`\`

## Injections
\`\`\`json
[
  { "tag": "PT-455", "value": 1600, "at-time-s": 30 },
  { "tag": "RCS-TEMP-HOT", "value": 575, "at-time-s": 60 }
]
\`\`\`

## Expected traversal
\`\`\`json
[
  "E-0#verify-reactor-trip",
  "E-0#check-si-status",
  "E-1#start-hhsi"
]
\`\`\`

## Expected terminal state
\`\`\`json
{ "HHSI-PUMP-A": "RUN", "PT-455": 1600 }
\`\`\`
`

describe('parseScenario', () => {
  test('happy path parses all four structured sections', () => {
    const r = parseScenario(SB_LOCA)
    if ('error' in r) throw new Error(r.error)
    expect(r.scenarioId).toBe('sb-loca')
    expect(r.title).toMatch(/Small-break LOCA/)
    expect(r.initialState['PT-455']).toBe(2235)
    expect(r.initialState['SG-A-LVL-NR']).toBe(50)
    expect(r.injections).toHaveLength(2)
    expect(r.injections[0]!.tag).toBe('PT-455')
    expect(r.injections[0]!.atTimeS).toBe(30)
    expect(r.expectedTraversal).toEqual([
      'E-0#verify-reactor-trip',
      'E-0#check-si-status',
      'E-1#start-hhsi',
    ])
    expect(r.expectedTerminalState['HHSI-PUMP-A']).toBe('RUN')
    expect(r.warnings).toEqual([])
  })

  test('rejects wrong frontmatter type', () => {
    const r = parseScenario(`---\ntype: procedure\nscenario-id: x\n---\n`)
    expect('error' in r).toBe(true)
  })

  test('rejects missing scenario-id', () => {
    const r = parseScenario(`---\ntype: scenario\n---\n`)
    expect('error' in r).toBe(true)
  })

  test('malformed JSON in a section becomes a warning, not a parse error', () => {
    const r = parseScenario(`---
type: scenario
scenario-id: x
---

## Initial state
\`\`\`json
{ this is not json }
\`\`\`
`)
    if ('error' in r) throw new Error(r.error)
    expect(r.warnings.some(w => w.includes('Initial state'))).toBe(true)
    expect(r.initialState).toEqual({})
  })

  test('traversal entry shape is validated', () => {
    const r = parseScenario(`---
type: scenario
scenario-id: x
---

## Expected traversal
\`\`\`json
["E-0#verify-reactor-trip", "malformed-no-hash"]
\`\`\`
`)
    if ('error' in r) throw new Error(r.error)
    expect(r.expectedTraversal).toHaveLength(2)
    expect(r.warnings.some(w => w.includes('malformed-no-hash'))).toBe(true)
  })

  test('injection with non-number at-time-s is dropped with a warning', () => {
    const r = parseScenario(`---
type: scenario
scenario-id: x
---

## Injections
\`\`\`json
[{ "tag": "X", "value": 1, "at-time-s": "soon" }]
\`\`\`
`)
    if ('error' in r) throw new Error(r.error)
    expect(r.injections).toHaveLength(0)
    expect(r.warnings.some(w => w.includes('at-time-s'))).toBe(true)
  })

  test('camelCase atTimeS is also accepted on input', () => {
    const r = parseScenario(`---
type: scenario
scenario-id: x
---

## Injections
\`\`\`json
[{ "tag": "X", "value": 1, "atTimeS": 5 }]
\`\`\`
`)
    if ('error' in r) throw new Error(r.error)
    expect(r.injections).toHaveLength(1)
    expect(r.injections[0]!.atTimeS).toBe(5)
  })
})
