import { describe, test, expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseScriptMd } from './script-md-parser.ts'
import { createScriptStore, MAX_SCRIPT_SOURCE_BYTES } from './script-store.ts'

const VALID = `# SCRIPT: Quarterly Planning
Premise: Q3 priorities for the platform team.

## Cast

### Alex (starts)
- model: gemini:gemini-2.5-flash
- persona: |
    You are Alex, a senior PM. Decisive, focused on impact.

### Sam
- model: gemini:gemini-2.5-flash
- persona: |
    You are Sam, the eng lead. Asks hard questions about feasibility.

---

## Step 1 — Scan
Goal: Surface 4-6 candidates without judging yet.
Roles:
  Alex — facilitator; propose initial options
  Sam — challenger; surface concerns

## Step 2 — Narrow
Goal: Pick top 1-2.
Roles:
  Alex — decision-maker
  Sam — reality-checker
`

describe('parseScriptMd', () => {
  test('happy path returns Script with id, name, title, premise, cast, steps, source', () => {
    const s = parseScriptMd('quarterly-planning', VALID)
    expect(s.name).toBe('quarterly-planning')
    expect(s.title).toBe('Quarterly Planning')
    expect(s.premise).toBe('Q3 priorities for the platform team.')
    expect(s.cast).toHaveLength(2)
    expect(s.cast[0]!.name).toBe('Alex')
    expect(s.cast[0]!.starts).toBe(true)
    expect(s.cast[1]!.starts).toBeUndefined()
    expect(s.cast[0]!.persona).toContain('senior PM')
    expect(s.steps).toHaveLength(2)
    expect(s.steps[0]!.title).toBe('Scan')
    expect(s.steps[0]!.goal).toContain('Surface')
    expect(s.steps[0]!.roles.Alex).toContain('facilitator')
    expect(s.steps[1]!.index).toBe(1)
    expect(s.id).toBeDefined()
    expect(s.source).toBe(VALID)
  })

  test('rejects missing SCRIPT header', () => {
    expect(() => parseScriptMd('x', '## Cast\n')).toThrow(/SCRIPT/)
  })

  test('rejects 0 starts markers', () => {
    const noStart = VALID.replace(' (starts)', '')
    expect(() => parseScriptMd('x', noStart)).toThrow(/exactly one/)
  })

  test('rejects 2 starts markers', () => {
    const twoStart = VALID.replace('### Sam\n', '### Sam (starts)\n')
    expect(() => parseScriptMd('x', twoStart)).toThrow(/exactly one/)
  })

  test('rejects duplicate cast names', () => {
    const dup = VALID.replace('### Sam', '### Alex')
    expect(() => parseScriptMd('x', dup)).toThrow(/duplicate/)
  })

  test('rejects step number gap', () => {
    const gap = VALID.replace('## Step 2', '## Step 3')
    expect(() => parseScriptMd('x', gap)).toThrow(/Step 2/)
  })

  test('rejects unknown cast role', () => {
    const bad = VALID.replace('  Sam — challenger', '  Stranger — challenger')
    expect(() => parseScriptMd('x', bad)).toThrow(/Stranger.*not in cast/)
  })

  test('accepts en-dash, hyphen, double-hyphen as role separator', () => {
    for (const sep of ['—', '–', '--', '-']) {
      const text = VALID.replace(/Alex — facilitator/g, `Alex ${sep} facilitator`)
      const s = parseScriptMd('x', text)
      expect(s.steps[0]!.roles.Alex).toContain('facilitator')
    }
  })

  test('parses inline persona (no |)', () => {
    const inline = VALID.replace(
      '- persona: |\n    You are Alex, a senior PM. Decisive, focused on impact.\n',
      '- persona: You are Alex, terse.\n',
    )
    const s = parseScriptMd('x', inline)
    expect(s.cast[0]!.persona).toBe('You are Alex, terse.')
  })

  test('parses tools as csv and as bracketed list', () => {
    const csv = VALID.replace('- model: gemini:gemini-2.5-flash\n- persona', '- model: gemini:gemini-2.5-flash\n- tools: list_rooms, get_time\n- persona')
    const s = parseScriptMd('x', csv)
    expect(s.cast[0]!.tools).toEqual(['list_rooms', 'get_time'])

    const brackets = VALID.replace('- model: gemini:gemini-2.5-flash\n- persona', '- model: gemini:gemini-2.5-flash\n- tools: [list_rooms, get_time]\n- persona')
    const s2 = parseScriptMd('x', brackets)
    expect(s2.cast[0]!.tools).toEqual(['list_rooms', 'get_time'])
  })

  test('rejects bad cast name', () => {
    expect(() => parseScriptMd('Bad-NAME', VALID)).toThrow(/match/)
  })
})

describe('ScriptStore.upsert size cap', () => {
  test('rejects source larger than MAX_SCRIPT_SOURCE_BYTES', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'samsinn-scripts-'))
    try {
      const store = createScriptStore(dir)
      await store.reload()
      const oversized = '# SCRIPT: x\n' + 'x'.repeat(MAX_SCRIPT_SOURCE_BYTES + 100)
      await expect(store.upsert('big', oversized)).rejects.toThrow(/too large/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('accepts source at exactly the cap (when otherwise valid)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'samsinn-scripts-'))
    try {
      const store = createScriptStore(dir)
      await store.reload()
      // Pad VALID with whitespace until exactly at the cap.
      const padding = ' '.repeat(MAX_SCRIPT_SOURCE_BYTES - VALID.length)
      const padded = VALID + padding
      expect(padded.length).toBe(MAX_SCRIPT_SOURCE_BYTES)
      const s = await store.upsert('quarterly-planning', padded)
      expect(s.name).toBe('quarterly-planning')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
