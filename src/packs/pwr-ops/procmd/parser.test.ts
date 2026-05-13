import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseProcedure } from './parser.ts'

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, '..', 'fixtures', name), 'utf-8')

describe('parseProcedure — E-0 (real fixture from samsinn-wikis/pwr-ops)', () => {
  const result = parseProcedure(fixture('E-0.md'))
  if ('error' in result) throw new Error(`E-0 fixture failed to parse: ${result.error}`)
  const parsed = result

  test('frontmatter fields', () => {
    expect(parsed.frontmatter.procedureId).toBe('E-0')
    expect(parsed.frontmatter.title).toContain('Reactor Trip')
    expect(parsed.frontmatter.profile).toBe('nuclear-erg')
    expect(parsed.frontmatter.appliesTo).toContain('Westinghouse')
    expect(parsed.frontmatter.csfsMonitored.length).toBeGreaterThan(0)
    expect(parsed.frontmatter.entryTriggers.length).toBeGreaterThan(0)
  })

  test('multiple steps with ids', () => {
    expect(parsed.steps.length).toBeGreaterThanOrEqual(10)
    for (const s of parsed.steps) {
      expect(s.id).toMatch(/^[a-z0-9][a-z0-9-]*$/)
    }
  })

  test('first step is verify-reactor-trip with a Check line', () => {
    const s = parsed.steps[0]!
    expect(s.id).toBe('verify-reactor-trip')
    expect(s.checks.length).toBeGreaterThan(0)
  })

  test('branches resolve to intra-step + inter-procedure targets', () => {
    let intraCount = 0
    let interCount = 0
    for (const s of parsed.steps) {
      for (const b of s.branches) {
        if (b.target.kind === 'intra') intraCount += 1
        if (b.target.kind === 'inter') interCount += 1
      }
    }
    expect(intraCount).toBeGreaterThan(0)  // intra-procedure jumps
    expect(interCount).toBeGreaterThan(0)  // [[FR-S.1]], [[ECA-0.0]], etc
  })

  test('tag references extracted (e.g. PT-455, MSIV-A)', () => {
    const allTags = new Set<string>()
    for (const s of parsed.steps) for (const t of s.tagsReferenced) allTags.add(t)
    expect(allTags.size).toBeGreaterThan(0)
    // E-0 references at least some plant tags
    const hasUpperCaseDashed = [...allTags].some(t => /^[A-Z]+-[A-Z0-9]+/.test(t))
    expect(hasUpperCaseDashed).toBe(true)
  })

  test('no synthesised-id warnings (corpus uses explicit [id:])', () => {
    // The real wiki is consistent; warnings would indicate spec drift
    expect(parsed.warnings).toEqual([])
  })
})

describe('parseProcedure — FR-S.1', () => {
  test('parses without error', () => {
    const result = parseProcedure(fixture('FR-S.1.md'))
    if ('error' in result) throw new Error(`FR-S.1 failed: ${result.error}`)
    expect(result.frontmatter.procedureId).toBe('FR-S.1')
    expect(result.steps.length).toBeGreaterThan(0)
  })
})

describe('parseProcedure — error paths', () => {
  test('missing frontmatter → error', () => {
    const r = parseProcedure('# Just a title, no frontmatter')
    expect('error' in r).toBe(true)
  })

  test('frontmatter without required fields → error', () => {
    const r = parseProcedure('---\ntype: procedure\n---\n\n## Step 1 [id: x]\nCheck: foo\n')
    expect('error' in r).toBe(true)
  })

  test('frontmatter without any ## Step heading → error', () => {
    const r = parseProcedure('---\nprocedure-id: X\ntitle: Y\n---\n\nJust prose, no steps.\n')
    expect('error' in r).toBe(true)
  })
})

describe('parseProcedure — minimal hand-rolled procedure', () => {
  const src = `---
type: procedure
procedure-md: 0.6
procedure-id: TEST-1
title: Test Procedure
profile: nuclear-erg
applies-to: Test rig
csfs-monitored: [a, b]
entry-triggers: [trigger-x]
---

# TEST-1 — Test Procedure

Preamble paragraph.

## Step 1 [id: do-check]
Check: pump «P-1» pressure within range
Action: log result
Caution: do not exceed 100 psig
- OK → #next-step
- Out of range → [[OTHER-1]]
- Manual investigation → call shift supervisor

## Step 2 [id: next-step]
Check: complete
Note: this is the last step
`
  const r = parseProcedure(src)
  if ('error' in r) throw new Error(r.error)

  test('preamble captured', () => {
    expect(r.preamble).toContain('Preamble')
  })

  test('check / action / caution / note captured separately', () => {
    const s1 = r.steps[0]!
    expect(s1.checks).toContain('pump «P-1» pressure within range')
    expect(s1.actions).toContain('log result')
    expect(s1.cautions).toContain('do not exceed 100 psig')
    expect(s1.branches.length).toBe(3)
  })

  test('intra/inter/freeText branch targets recognised', () => {
    const branches = r.steps[0]!.branches
    expect(branches[0]!.target).toEqual({ kind: 'intra', stepId: 'next-step' })
    expect(branches[1]!.target).toEqual({ kind: 'inter', procedureId: 'OTHER-1' })
    expect(branches[2]!.target.kind).toBe('freeText')
  })

  test('tag references extracted', () => {
    expect(r.steps[0]!.tagsReferenced).toContain('P-1')
  })

  test('step 2 has note + no branches → not a decision', () => {
    expect(r.steps[1]!.notes).toContain('this is the last step')
    expect(r.steps[1]!.isDecision).toBe(false)
  })
})

describe('parseProcedure — v0.6 promoted keywords', () => {
  const src = `---
type: procedure
procedure-md: 0.6
procedure-id: TEST-2
title: Test Promotions
profile: nuclear-erg
applies-to: Westinghouse 4-loop PWR
custom-key: custom-value
csfs-monitored: [subcriticality, core-cooling]
entry-triggers: [reactor-trip-signal]
---

# TEST-2 — Test Promotions

Preamble paragraph.

CSF: subcriticality

CSF: core-cooling

## Step 1 [id: do-thing]
Check: pump «P-1» pressure within range
Within: 30 seconds
Caution: do not exceed 100 psig
- OK → #wrap-up
  Because: pressure within band confirms pump health
  Against: but readings can drift if instrument drift detected
- Fault → [[OTHER-1]]
  Because: pump fault requires escalation

## Step 2 [id: wrap-up]
Action: log completion

## Tags

- id: P-1
  description: primary charging pump
  sim-path: cvcs.charging_pump.a.status
  units: enum[STOPPED,RUNNING,FAULT]
  equipment: charging-system
  range: [0, 1]

- id: P-2
  description: backup charging pump
  sim-path: cvcs.charging_pump.b.status
  units: enum[STOPPED,RUNNING,FAULT]
  equipment: charging-system
`
  const r = parseProcedure(src)
  if ('error' in r) throw new Error(r.error)

  test('frontmatter passthrough captures unknown keys', () => {
    expect(r.frontmatter.extra['custom-key']).toBe('custom-value')
    expect(r.frontmatter.extra['title']).toBeUndefined()
    expect(r.frontmatter.extra['procedure-id']).toBeUndefined()
  })

  test('CSF channels parsed from preamble standalone lines', () => {
    expect(r.csfChannels).toEqual(['subcriticality', 'core-cooling'])
  })

  test('Within: captured as step-level time constraint', () => {
    expect(r.steps[0]!.withins).toContain('30 seconds')
  })

  test('Because: attaches to the preceding branch as rationale', () => {
    const b0 = r.steps[0]!.branches[0]!
    expect(b0.because).toContain('within band confirms pump health')
    const b1 = r.steps[0]!.branches[1]!
    expect(b1.because).toContain('pump fault requires escalation')
  })

  test('Against: attaches to the preceding branch as counter-rationale', () => {
    const b0 = r.steps[0]!.branches[0]!
    expect(b0.against).toContain('readings can drift')
  })

  test('## Tags appendix parsed into structured TagDefinition entries', () => {
    expect(r.tagDefinitions.length).toBe(2)
    const p1 = r.tagDefinitions[0]!
    expect(p1.id).toBe('P-1')
    expect(p1.description).toContain('primary charging pump')
    expect(p1.simPath).toBe('cvcs.charging_pump.a.status')
    expect(p1.units).toBe('enum[STOPPED,RUNNING,FAULT]')
    expect(p1.equipment).toBe('charging-system')
    expect(p1.extra['range']).toBe('[0, 1]')
  })

  test('Tags appendix does NOT leak into the last step body', () => {
    expect(r.steps[1]!.actions.length).toBe(1)
    expect(r.steps[1]!.tagsReferenced).toEqual([])
  })

  test('accepted procedure-md version emits no warning', () => {
    expect(r.warnings.filter(w => w.includes('procedure-md'))).toEqual([])
  })
})

describe('parseProcedure — version handshake', () => {
  test('unknown procedure-md version emits a warning but still parses', () => {
    const src = `---
type: procedure
procedure-md: 99.9
procedure-id: TEST-3
title: Future Spec
profile: nuclear-erg
applies-to: anywhere
---

## Step 1 [id: x]
Check: something
- ok → #x
`
    const r = parseProcedure(src)
    if ('error' in r) throw new Error(r.error)
    expect(r.warnings.some(w => w.includes('99.9'))).toBe(true)
  })

  test('omitted procedure-md is fine', () => {
    const src = `---
type: procedure
procedure-id: TEST-4
title: No version
profile: nuclear-erg
applies-to: anywhere
---

## Step 1 [id: x]
Check: something
`
    const r = parseProcedure(src)
    expect('error' in r).toBe(false)
  })
})

describe('parseProcedure — E-0 fixture exercises v0.6 features', () => {
  const r = parseProcedure(fixture('E-0.md'))
  if ('error' in r) throw new Error(`E-0 fixture failed: ${r.error}`)

  test('E-0 declares its CSF channels in preamble', () => {
    expect(r.csfChannels.length).toBeGreaterThanOrEqual(6)
    expect(r.csfChannels).toContain('subcriticality')
    expect(r.csfChannels).toContain('core-cooling')
    expect(r.csfChannels).toContain('containment')
  })

  test('E-0 step branches carry Because: rationales', () => {
    let withBecause = 0
    for (const s of r.steps) for (const b of s.branches) if (b.because) withBecause += 1
    expect(withBecause).toBeGreaterThan(0)
  })

  test('E-0 ## Tags appendix produces structured tag definitions', () => {
    expect(r.tagDefinitions.length).toBeGreaterThan(10)
    const trip = r.tagDefinitions.find(t => t.id === 'TRIP-BKR-A')
    expect(trip).toBeDefined()
    expect(trip!.simPath).toContain('trip_breaker')
    expect(trip!.equipment).toBe('reactor-protection-system')
  })

  test('E-0 monitor-csfs is the last real step (Tags appendix does not override it)', () => {
    const lastStep = r.steps[r.steps.length - 1]!
    expect(lastStep.id).toBe('monitor-csfs')
  })
})
