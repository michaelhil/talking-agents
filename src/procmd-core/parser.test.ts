import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseProcedure, PARSER_PROCMD_VERSION, ACCEPTED_PROCMD_VERSIONS } from './parser.ts'

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8')

describe('procmd-core — version constants', () => {
  test('PARSER_PROCMD_VERSION is the current spec version', () => {
    expect(PARSER_PROCMD_VERSION).toBe('0.6')
  })
  test('ACCEPTED_PROCMD_VERSIONS is exactly 0.6 (no back-compat)', () => {
    expect([...ACCEPTED_PROCMD_VERSIONS]).toEqual(['0.6'])
  })
})

describe('procmd-core — E-0 fixture (v0.6)', () => {
  const result = parseProcedure(fixture('E-0.md'))
  if ('error' in result) throw new Error(`E-0 failed: ${result.error}`)
  const r = result

  test('frontmatter version handshake clean (no warning for v0.6 content)', () => {
    expect(r.warnings.filter(w => w.includes('procedure-md'))).toEqual([])
  })

  test('all v0.6 fields populated from real fixture', () => {
    expect(r.frontmatter.procedureId).toBe('E-0')
    expect(r.csfChannels.length).toBeGreaterThanOrEqual(6)
    expect(r.tagDefinitions.length).toBeGreaterThan(20)
    let withBecause = 0
    for (const s of r.steps) for (const b of s.branches) if (b.because) withBecause += 1
    expect(withBecause).toBeGreaterThan(0)
  })
})

describe('procmd-core — version handshake rejects unknown versions with a warning, still parses', () => {
  test('v0.5 (legacy) triggers warning, no error', () => {
    const src = `---
procedure-md: 0.5
procedure-id: LEGACY-1
title: Legacy
---
## Step 1 [id: x]
Check: ok
`
    const r = parseProcedure(src)
    if ('error' in r) throw new Error(r.error)
    expect(r.warnings.some(w => w.includes('0.5'))).toBe(true)
    expect(r.steps.length).toBe(1)
  })

  test('v99.9 (future) triggers warning, no error', () => {
    const src = `---
procedure-md: 99.9
procedure-id: FUTURE-1
title: Future
---
## Step 1 [id: x]
Check: ok
`
    const r = parseProcedure(src)
    if ('error' in r) throw new Error(r.error)
    expect(r.warnings.some(w => w.includes('99.9'))).toBe(true)
  })

  test('omitted procedure-md is fine', () => {
    const src = `---
procedure-id: NOVER-1
title: No version
---
## Step 1 [id: x]
Check: ok
`
    expect('error' in parseProcedure(src)).toBe(false)
  })
})
