import { describe, expect, test } from 'bun:test'
import { parseScenario, ScenarioParseError } from './parser.ts'

const wrap = (body: string): string =>
  `---\ntitle: Test\n---\n\n${body}\n`

describe('scenario parser — frontmatter', () => {
  test('rejects missing fence', () => {
    expect(() => parseScenario('p', 'n', 'no frontmatter')).toThrow(ScenarioParseError)
  })
  test('rejects unterminated fence', () => {
    expect(() => parseScenario('p', 'n', '---\ntitle: T\n')).toThrow(/without closing/)
  })
  test('rejects missing title', () => {
    expect(() => parseScenario('p', 'n', '---\ndescription: x\n---\n')).toThrow(/title/)
  })
  test('extracts title + description', () => {
    const s = parseScenario('p', 'n', '---\ntitle: Hello\ndescription: World\n---\n')
    expect(s.title).toBe('Hello')
    expect(s.description).toBe('World')
    expect(s.id).toBe('p/n')
  })
})

// Each op now carries a `line` field (see "line tracking" describe). Tests
// that don't care about the line use toMatchObject so the shape stays
// readable when only the load-bearing fields matter.

describe('scenario parser — ops (inline forms)', () => {
  test('inline string arg', () => {
    const s = parseScenario('p', 'n', wrap('```scenario\n- install-pack: foo/bar\n```'))
    expect(s.ops).toMatchObject([{ kind: 'install-pack', source: 'foo/bar' }])
  })
  test('inline object arg', () => {
    const s = parseScenario('p', 'n', wrap('```scenario\n- create-room: { name: "Cafe" }\n```'))
    expect(s.ops).toMatchObject([{ kind: 'create-room', name: 'Cafe' }])
  })
  test('inline object with optional field', () => {
    const s = parseScenario('p', 'n', wrap('```scenario\n- create-room: { name: Cafe, roomPrompt: "be nice" }\n```'))
    expect(s.ops).toMatchObject([{ kind: 'create-room', name: 'Cafe', roomPrompt: 'be nice' }])
  })
})

describe('scenario parser — ops (block form)', () => {
  test('block-form fields with block scalar', () => {
    const src = wrap([
      '```scenario',
      '- create-room:',
      '    name: Cafe',
      '- spawn-agent:',
      '    room: Cafe',
      '    name: AI',
      '    model: gpt-4',
      '    persona: |',
      '      You are AI.',
      '      Be friendly.',
      '```',
    ].join('\n'))
    const s = parseScenario('p', 'n', src)
    expect(s.ops).toMatchObject([
      { kind: 'create-room', name: 'Cafe' },
      { kind: 'spawn-agent', room: 'Cafe', name: 'AI', model: 'gpt-4', persona: 'You are AI.\nBe friendly.' },
    ])
  })
})

describe('scenario parser — name resolution', () => {
  test('rejects post-message to undeclared room', () => {
    const src = wrap('```scenario\n- post-message: { room: Ghost, as: system, body: hi }\n```')
    expect(() => parseScenario('p', 'n', src)).toThrow(/undeclared room "Ghost"/)
  })
  test('rejects post-message from undeclared sender', () => {
    const src = wrap([
      '```scenario',
      '- create-room: { name: R }',
      '- post-message: { room: R, as: Mystery, body: hi }',
      '```',
    ].join('\n'))
    expect(() => parseScenario('p', 'n', src)).toThrow(/undeclared sender "Mystery"/)
  })
  test('accepts system as sender without spawn', () => {
    const src = wrap([
      '```scenario',
      '- create-room: { name: R }',
      '- post-message: { room: R, as: system, body: hi }',
      '```',
    ].join('\n'))
    const s = parseScenario('p', 'n', src)
    expect(s.ops).toHaveLength(2)
  })
  test('accepts agent declared earlier', () => {
    const src = wrap([
      '```scenario',
      '- create-room: { name: R }',
      '- spawn-human: { room: R, name: Alex }',
      '- post-message: { room: R, as: Alex, body: hi }',
      '```',
    ].join('\n'))
    const s = parseScenario('p', 'n', src)
    expect(s.ops).toHaveLength(3)
  })
})

describe('scenario parser — narration + multiple blocks', () => {
  test('multiple ```scenario blocks concatenate', () => {
    const src = wrap([
      'first block:',
      '```scenario',
      '- create-room: { name: R }',
      '```',
      'second block:',
      '```scenario',
      '- post-message: { room: R, as: system, body: hi }',
      '```',
      'trailing narration',
    ].join('\n'))
    const s = parseScenario('p', 'n', src)
    expect(s.ops).toHaveLength(2)
    expect(s.narration).toContain('first block')
    expect(s.narration).toContain('trailing narration')
    expect(s.narration).not.toContain('create-room')
  })
})

describe('scenario parser — guide ops', () => {
  test('guide-tooltip with click waitFor', () => {
    const src = wrap([
      '```scenario',
      '- guide-tooltip:',
      '    selector: "[data-room-id]"',
      '    body: "Click here"',
      '    waitFor: { type: click }',
      '```',
    ].join('\n'))
    const s = parseScenario('p', 'n', src)
    expect(s.ops[0]).toMatchObject({
      kind: 'guide-tooltip',
      selector: '[data-room-id]',
      body: 'Click here',
      waitFor: { type: 'click' },
    })
  })
})

describe('scenario parser — line tracking', () => {
  test('every op carries the source line of its `- <kind>:` introducer', () => {
    const src = [
      '---',
      'title: T',
      '---',
      '',
      '```scenario',
      '- create-room: { name: R }',
      '- spawn-human: { room: R, name: H }',
      '```',
    ].join('\n')
    const s = parseScenario('p', 'n', src)
    expect(s.ops[0]!.line).toBe(6)
    expect(s.ops[1]!.line).toBe(7)
  })

  test('name-validation errors carry the offending op line', () => {
    const src = [
      '---',
      'title: T',
      '---',
      '',
      '```scenario',
      '- create-room: { name: R }',
      '- post-message: { room: Ghost, as: system, body: hi }',
      '```',
    ].join('\n')
    expect(() => parseScenario('p', 'n', src)).toThrow(/line 7:.*Ghost/)
  })
})

describe('scenario parser — op id (Phase C named labels)', () => {
  test('accepts op with id label', () => {
    const src = wrap([
      '```scenario',
      '- create-room: { name: Cafe, id: setup-room }',
      '```',
    ].join('\n'))
    const s = parseScenario('p', 'n', src)
    expect(s.ops[0]!.id).toBe('setup-room')
  })

  test('rejects malformed id', () => {
    const src = wrap([
      '```scenario',
      '- create-room: { name: Cafe, id: "Bad ID" }',
      '```',
    ].join('\n'))
    expect(() => parseScenario('p', 'n', src)).toThrow(/op id/)
  })

  test('omitting id leaves it undefined', () => {
    const src = wrap('```scenario\n- create-room: { name: Cafe }\n```')
    const s = parseScenario('p', 'n', src)
    expect(s.ops[0]!.id).toBeUndefined()
  })
})

describe('scenario parser — branch-on-llm-decision (Phase C branching)', () => {
  test('parses with branches + fallback', () => {
    const src = wrap([
      '```scenario',
      '- create-room: { name: Cafe, id: room1 }',
      '- branch-on-llm-decision:',
      '    prompt: "Did the user understand?"',
      '    fallback: room1',
      '    branches: { yes: room1, no: room1 }',
      '```',
    ].join('\n'))
    const s = parseScenario('p', 'n', src)
    expect(s.ops[1]!.kind).toBe('branch-on-llm-decision')
    expect(s.ops[1]).toMatchObject({
      kind: 'branch-on-llm-decision',
      prompt: 'Did the user understand?',
      fallback: 'room1',
    })
  })

  test('rejects fewer than 2 branches', () => {
    const src = wrap([
      '```scenario',
      '- create-room: { name: Cafe, id: room1 }',
      '- branch-on-llm-decision:',
      '    prompt: "yes only"',
      '    fallback: room1',
      '    branches: { yes: room1 }',
      '```',
    ].join('\n'))
    expect(() => parseScenario('p', 'n', src)).toThrow(/at least 2 branches/)
  })

  test('rejects missing fallback', () => {
    const src = wrap([
      '```scenario',
      '- create-room: { name: Cafe, id: room1 }',
      '- branch-on-llm-decision:',
      '    prompt: "ask"',
      '    branches: { yes: room1, no: room1 }',
      '```',
    ].join('\n'))
    expect(() => parseScenario('p', 'n', src)).toThrow(/fallback/)
  })
})

describe('scenario parser — inline-script op', () => {
  test('parses inline-script with block-scalar source', () => {
    const src = wrap([
      '```scenario',
      '- create-room: { name: Cafe }',
      '- inline-script:',
      '    room: Cafe',
      '    source: |',
      '      # SCRIPT: Tiny exchange',
      '      ## Cast',
      '      ### Alice',
      '      - model: x',
      '      - persona: |',
      '          friendly',
      '      ### Bob',
      '      - model: x',
      '      - persona: |',
      '          curious',
      '      ## Step 1 — Hello',
      '      - alice: greet bob',
      '      - bob: respond',
      '```',
    ].join('\n'))
    const s = parseScenario('p', 'n', src)
    expect(s.ops).toHaveLength(2)
    const inline = s.ops[1]!
    expect(inline.kind).toBe('inline-script')
    expect(inline).toMatchObject({ kind: 'inline-script', room: 'Cafe' })
  })

  test('rejects inline-script referencing undeclared room', () => {
    const src = wrap([
      '```scenario',
      '- inline-script:',
      '    room: Ghost',
      '    source: |',
      '      # SCRIPT: x',
      '```',
    ].join('\n'))
    expect(() => parseScenario('p', 'n', src)).toThrow(/inline-script.*Ghost/)
  })
})
