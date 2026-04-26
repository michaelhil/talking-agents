import { describe, test, expect } from 'bun:test'
import { parseScript } from './script-store.ts'

const valid = {
  title: 'Quarterly planning',
  prompt: 'Look at the goals doc and propose Q3 priorities',
  cast: [
    { name: 'Alex', persona: 'Senior PM', model: 'gemini:gemini-2.5-flash', starts: true },
    { name: 'Sam',  persona: 'Eng lead',  model: 'gemini:gemini-2.5-flash' },
  ],
  steps: [
    { title: 'Scan',   roles: { Alex: 'facilitator', Sam: 'challenger' } },
    { title: 'Narrow', roles: { Alex: 'decision-maker', Sam: 'reality-checker' } },
  ],
}

describe('parseScript', () => {
  test('happy path returns Script with id, name, title, cast, steps', () => {
    const s = parseScript('quarterly-planning', JSON.stringify(valid))
    expect(s.name).toBe('quarterly-planning')
    expect(s.title).toBe('Quarterly planning')
    expect(s.cast).toHaveLength(2)
    expect(s.cast[0]!.starts).toBe(true)
    expect(s.cast[1]!.starts).toBeUndefined()
    expect(s.steps).toHaveLength(2)
    expect(s.id).toBeDefined()
  })

  test('rejects malformed JSON', () => {
    expect(() => parseScript('x', '{')).toThrow(/invalid JSON/)
  })

  test('rejects missing title', () => {
    const { title: _, ...rest } = valid
    expect(() => parseScript('x', JSON.stringify(rest))).toThrow(/title/)
  })

  test('rejects cast count != 2', () => {
    const one = { ...valid, cast: [valid.cast[0]] }
    expect(() => parseScript('x', JSON.stringify(one))).toThrow(/exactly 2/)
    const three = { ...valid, cast: [...valid.cast, { name: 'C', persona: 'p', model: 'm' }] }
    expect(() => parseScript('x', JSON.stringify(three))).toThrow(/exactly 2/)
  })

  test('rejects 0 starts', () => {
    const noStart = { ...valid, cast: valid.cast.map(c => ({ ...c, starts: false })) }
    expect(() => parseScript('x', JSON.stringify(noStart))).toThrow(/starts: true/)
  })

  test('rejects 2 starts', () => {
    const twoStart = { ...valid, cast: valid.cast.map(c => ({ ...c, starts: true })) }
    expect(() => parseScript('x', JSON.stringify(twoStart))).toThrow(/starts: true/)
  })

  test('rejects duplicate cast names', () => {
    const dup = { ...valid, cast: [valid.cast[0], { ...valid.cast[1], name: 'Alex' }] }
    expect(() => parseScript('x', JSON.stringify(dup))).toThrow(/duplicate/)
  })

  test('rejects empty steps', () => {
    const empty = { ...valid, steps: [] }
    expect(() => parseScript('x', JSON.stringify(empty))).toThrow(/non-empty array/)
  })

  test('rejects step with role for unknown cast', () => {
    const bad = {
      ...valid,
      steps: [{ title: 'Scan', roles: { Alex: 'a', Sam: 's', Stranger: 'x' } }],
    }
    expect(() => parseScript('x', JSON.stringify(bad))).toThrow(/Stranger.*not in cast/)
  })

  test('rejects step missing role for present cast member', () => {
    const bad = {
      ...valid,
      steps: [{ title: 'Scan', roles: { Alex: 'a' } }],
    }
    expect(() => parseScript('x', JSON.stringify(bad))).toThrow(/Sam.*missing role/)
  })

  test('accepts contextOverrides with includePrompts.script', () => {
    const withCO = {
      ...valid,
      contextOverrides: {
        includePrompts: { persona: true, room: false, house: false, skills: false, script: true },
        includeContext: { participants: false, artifacts: false, activity: false, knownAgents: false },
        includeTools: false,
      },
    }
    const s = parseScript('x', JSON.stringify(withCO))
    expect(s.contextOverrides?.includePrompts?.script).toBe(true)
    expect(s.contextOverrides?.includeTools).toBe(false)
  })

  test('rejects contextOverrides with unknown includePrompts key', () => {
    const bad = { ...valid, contextOverrides: { includePrompts: { wat: true } } }
    expect(() => parseScript('x', JSON.stringify(bad))).toThrow(/wat.*unknown/)
  })

  test('rejects contextOverrides with non-boolean toggle', () => {
    const bad = { ...valid, contextOverrides: { includePrompts: { persona: 'yes' } } }
    expect(() => parseScript('x', JSON.stringify(bad))).toThrow(/persona.*boolean/)
  })

  test('cast tools accepted as string array', () => {
    const withTools = {
      ...valid,
      cast: valid.cast.map((c, i) => i === 0 ? { ...c, tools: ['list_rooms', 'get_time'] } : c),
    }
    const s = parseScript('x', JSON.stringify(withTools))
    expect(s.cast[0]!.tools).toEqual(['list_rooms', 'get_time'])
  })
})
