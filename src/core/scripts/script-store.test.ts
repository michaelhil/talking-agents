import { describe, test, expect } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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

  test('rejects reserved cast name "Stage"', () => {
    const src = VALID.replace('### Alex (starts)', '### Stage (starts)')
    expect(() => parseScriptMd('x', src)).toThrow(/reserved sender name/)
  })

  test('rejects reserved cast name "Director"', () => {
    const src = VALID.replace('### Alex (starts)', '### Director (starts)')
    expect(() => parseScriptMd('x', src)).toThrow(/reserved sender name/)
  })

  test('rejects cast name with leading digit', () => {
    const src = VALID.replace('### Alex (starts)', '### 1Alex (starts)')
    expect(() => parseScriptMd('x', src)).toThrow(/VALID_CAST_NAME|alphanumeric/)
  })

  test('rejects cast name with whitespace', () => {
    const src = VALID.replace('### Alex (starts)', '### Has Space (starts)')
    expect(() => parseScriptMd('x', src)).toThrow(/VALID_CAST_NAME|alphanumeric/)
  })

  test('rejects cast name longer than 40 chars', () => {
    const long = 'A'.repeat(41)
    const src = VALID.replace('### Alex (starts)', `### ${long} (starts)`)
    expect(() => parseScriptMd('x', src)).toThrow(/VALID_CAST_NAME|alphanumeric/)
  })

  test('accepts hyphen, underscore, digits in cast name', () => {
    const src = `# SCRIPT: Test
## Cast

### Alex-Jr_99 (starts)
- model: m
- persona: lead

### Sam2
- model: m
- persona: critic

---

## Step 1 — Open
Roles:
  Alex-Jr_99 — propose
  Sam2 — challenge
`
    const s = parseScriptMd('x', src)
    expect(s.cast.map(c => c.name)).toEqual(['Alex-Jr_99', 'Sam2'])
  })
})

describe('ScriptStore.upsert size cap', () => {
  test('rejects source larger than MAX_SCRIPT_SOURCE_BYTES', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'samsinn-scripts-'))
    try {
      const store = createScriptStore({ baseDir: dir })
      await store.reload()
      const oversized = '# SCRIPT: x\n' + 'x'.repeat(MAX_SCRIPT_SOURCE_BYTES + 100)
      await expect(store.upsert('big', oversized)).rejects.toThrow(/too large/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('refuses to start when same name appears in baseDir and an extra source dir', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'samsinn-scripts-'))
    const extraDir = await mkdtemp(join(tmpdir(), 'samsinn-extra-'))
    try {
      await writeFile(join(baseDir, 'quarterly-planning.md'), VALID, 'utf-8')
      await writeFile(join(extraDir, 'quarterly-planning.md'), VALID, 'utf-8')
      const store = createScriptStore({ baseDir, extraSourceDirs: [extraDir] })
      await expect(store.reload()).rejects.toThrow(/name collision for "quarterly-planning"/)
    } finally {
      await rm(baseDir, { recursive: true, force: true })
      await rm(extraDir, { recursive: true, force: true })
    }
  })

  test('merges baseDir + extraSourceDirs without conflict', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'samsinn-scripts-'))
    const extraDir = await mkdtemp(join(tmpdir(), 'samsinn-extra-'))
    try {
      await writeFile(join(baseDir, 'user-script.md'), VALID, 'utf-8')
      await writeFile(join(extraDir, 'bundled-script.md'), VALID, 'utf-8')
      const store = createScriptStore({ baseDir, extraSourceDirs: [extraDir] })
      const names = await store.reload()
      expect([...names].sort()).toEqual(['bundled-script', 'user-script'])
    } finally {
      await rm(baseDir, { recursive: true, force: true })
      await rm(extraDir, { recursive: true, force: true })
    }
  })

  test('packDirs tag scripts with their owning pack namespace', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'samsinn-scripts-'))
    const aviationDir = await mkdtemp(join(tmpdir(), 'samsinn-pack-aviation-'))
    try {
      await writeFile(join(baseDir, 'standalone.md'), VALID, 'utf-8')
      await writeFile(join(aviationDir, 'pack-script.md'), VALID, 'utf-8')
      const store = createScriptStore({
        baseDir,
        resolvePackDirs: async () => [{ pack: 'aviation', dir: aviationDir }],
      })
      await store.reload()
      const standalone = store.get('standalone')
      const packed = store.get('pack-script')
      expect(standalone?.pack).toBeUndefined()
      expect(packed?.pack).toBe('aviation')
    } finally {
      await rm(baseDir, { recursive: true, force: true })
      await rm(aviationDir, { recursive: true, force: true })
    }
  })

  test('packDirs collide with baseDir → throws', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'samsinn-scripts-'))
    const packDir = await mkdtemp(join(tmpdir(), 'samsinn-pack-'))
    try {
      await writeFile(join(baseDir, 'shared-name.md'), VALID, 'utf-8')
      await writeFile(join(packDir, 'shared-name.md'), VALID, 'utf-8')
      const store = createScriptStore({
        baseDir,
        resolvePackDirs: async () => [{ pack: 'aviation', dir: packDir }],
      })
      await expect(store.reload()).rejects.toThrow(/name collision for "shared-name"/)
    } finally {
      await rm(baseDir, { recursive: true, force: true })
      await rm(packDir, { recursive: true, force: true })
    }
  })

  test('accepts source at exactly the cap (when otherwise valid)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'samsinn-scripts-'))
    try {
      const store = createScriptStore({ baseDir: dir })
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

  test('B2: concurrent upserts of distinct names all land', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'samsinn-scripts-'))
    try {
      const store = createScriptStore({ baseDir: dir })
      await store.reload()
      // Build 10 valid scripts with distinct names; fire upserts concurrently.
      const names = Array.from({ length: 10 }, (_, i) => `concurrent-${i}`)
      const sources = names.map(n => VALID.replace('Quarterly Planning', `Plan ${n}`))
      const results = await Promise.all(
        names.map((n, i) => store.upsert(n, sources[i]!)),
      )
      // Each result corresponds to its own input.
      for (let i = 0; i < names.length; i++) {
        expect(results[i]!.name).toBe(names[i])
        expect(results[i]!.title).toBe(`Plan ${names[i]}`)
      }
      // All 10 are present in the store after.
      for (const n of names) expect(store.get(n)?.name).toBe(n)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('B2: concurrent upserts of the same name produce a coherent final state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'samsinn-scripts-'))
    try {
      const store = createScriptStore({ baseDir: dir })
      await store.reload()
      // 5 concurrent upserts of "shared". Filesystem write order is
      // serialised by the chain — last-submitted wins, and each upsert's
      // returned Script matches its own promise (no cross-pollution).
      const sources = Array.from({ length: 5 }, (_, i) =>
        VALID.replace('Quarterly Planning', `Variant ${i}`),
      )
      const results = await Promise.all(
        sources.map(s => store.upsert('shared', s)),
      )
      // Each promise resolved to ITS OWN input parsed shape.
      for (let i = 0; i < 5; i++) {
        expect(results[i]!.title).toBe(`Variant ${i}`)
      }
      // Final store state matches the last-submitted input.
      const final = store.get('shared')
      expect(final?.title).toBe('Variant 4')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
