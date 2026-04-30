import { test, expect, describe } from 'bun:test'
import { buildContext, buildSystemSections, __strategyTestSeam, type BuildContextDeps } from './context-builder.ts'
import type { AgentHistory, Message, RoomProfile } from '../core/types/messaging.ts'

const mkProfile = (id: string, name: string, roomPrompt?: string): RoomProfile => ({
  id, name, roomPrompt, createdAt: Date.now(), createdBy: 'test',
})

const mkHistory = (roomId: string, name: string, prompt?: string, messages: Message[] = []): AgentHistory => ({
  rooms: new Map([[roomId, {
    profile: mkProfile(roomId, name, prompt),
    history: messages,
    lastActiveAt: Date.now(),
  }]]),
  incoming: [],
  agentProfiles: new Map(),
})

const mkDeps = (overrides: Partial<BuildContextDeps> = {}): BuildContextDeps => ({
  agentId: 'agent-1',
  persona: 'You are Alpha.',
  housePrompt: 'Be concise.',
  responseFormat: 'Reply in plain text.',
  history: mkHistory('room-1', 'General', 'Topic: weather.'),
  historyLimit: 10,
  resolveName: (id) => id,
  ...overrides,
})

describe('context-builder includePrompts', () => {
  test('all sections included by default (undefined includePrompts)', () => {
    const result = buildContext(mkDeps(), 'room-1')
    const sys = result.messages[0]!.content
    expect(sys).toContain('<samsinn:house_rules>')
    expect(sys).toContain('<samsinn:room name="General">')
    expect(sys).toContain('<samsinn:identity>')
    expect(sys).toContain('<samsinn:response_format>')
  })

  test('house: false suppresses HOUSE RULES only', () => {
    const result = buildContext(mkDeps({ includePrompts: { house: false } }), 'room-1')
    const sys = result.messages[0]!.content
    expect(sys).not.toContain('<samsinn:house_rules>')
    expect(sys).toContain('<samsinn:room name="General">')
    expect(sys).toContain('<samsinn:identity>')
    expect(sys).toContain('<samsinn:response_format>')
  })

  test('room: false suppresses ROOM only', () => {
    const result = buildContext(mkDeps({ includePrompts: { room: false } }), 'room-1')
    const sys = result.messages[0]!.content
    expect(sys).not.toContain('<samsinn:room name="General">')
    expect(sys).toContain('<samsinn:house_rules>')
    expect(sys).toContain('<samsinn:identity>')
  })

  test('persona: false suppresses YOUR IDENTITY only', () => {
    const result = buildContext(mkDeps({ includePrompts: { persona: false } }), 'room-1')
    const sys = result.messages[0]!.content
    expect(sys).not.toContain('<samsinn:identity>')
    expect(sys).toContain('<samsinn:house_rules>')
  })

  test('responseFormat: false suppresses RESPONSE FORMAT only', () => {
    const result = buildContext(mkDeps({ includePrompts: { responseFormat: false } }), 'room-1')
    const sys = result.messages[0]!.content
    expect(sys).not.toContain('<samsinn:response_format>')
    expect(sys).toContain('<samsinn:identity>')
  })

  test('all four off: none of the four sections present; CONTEXT still emitted', () => {
    const result = buildContext(mkDeps({
      includePrompts: { persona: false, room: false, house: false, responseFormat: false },
    }), 'room-1')
    const sys = result.messages[0]!.content
    expect(sys).not.toContain('<samsinn:house_rules>')
    expect(sys).not.toContain('<samsinn:room name="General">')
    expect(sys).not.toContain('<samsinn:identity>')
    expect(sys).not.toContain('<samsinn:response_format>')
    expect(sys).toContain('<samsinn:context>')
  })

  test('partial includePrompts defaults missing keys to true', () => {
    const result = buildContext(mkDeps({ includePrompts: { house: false } }), 'room-1')
    const sys = result.messages[0]!.content
    expect(sys).toContain('<samsinn:identity>')
    expect(sys).toContain('<samsinn:room name="General">')
    expect(sys).toContain('<samsinn:response_format>')
  })

  test('promptsEnabled: false excludes every prompt regardless of per-key flags', () => {
    const result = buildContext(mkDeps({
      promptsEnabled: false,
      includePrompts: { persona: true, room: true, house: true, responseFormat: true, skills: true },
    }), 'room-1')
    const sys = result.messages[0]!.content
    expect(sys).not.toContain('<samsinn:house_rules>')
    expect(sys).not.toContain('<samsinn:room name="General">')
    expect(sys).not.toContain('<samsinn:identity>')
    expect(sys).not.toContain('<samsinn:response_format>')
  })

  test('contextEnabled: false suppresses participants/artifacts/activity/knownAgents', () => {
    const sections = buildSystemSections(mkDeps({ contextEnabled: false }), 'room-1')
    const toggleableKeys = ['ctx_participants', 'ctx_artifacts', 'ctx_activity', 'ctx_knownAgents']
    for (const key of toggleableKeys) {
      const sec = sections.find(s => s.key === key)
      expect(sec?.enabled).toBe(false)
    }
  })
})

describe('buildSystemSections', () => {
  test('returns labelled sections with enabled flags', () => {
    const sections = buildSystemSections(mkDeps(), 'room-1')
    const byKey = Object.fromEntries(sections.map(s => [s.key, s]))
    expect(byKey.house?.enabled).toBe(true)
    expect(byKey.room?.enabled).toBe(true)
    expect(byKey.persona?.enabled).toBe(true)
    expect(byKey.responseFormat?.enabled).toBe(true)
    expect(byKey.skills?.enabled).toBe(false) // getSkills not provided
    expect(byKey.ctx_intro?.optional).toBe(false)
  })

  test('respects includePrompts.house=false', () => {
    const sections = buildSystemSections(mkDeps({ includePrompts: { house: false } }), 'room-1')
    expect(sections.find(s => s.key === 'house')!.enabled).toBe(false)
  })

  test('respects includeContext.knownAgents=false', () => {
    const history = mkHistory('room-1', 'General', undefined, [])
    history.agentProfiles.set('b', { id: 'b', name: 'Bob', kind: 'ai' })
    const sections = buildSystemSections(mkDeps({
      history, includeContext: { knownAgents: false },
    }), 'room-1')
    expect(sections.find(s => s.key === 'ctx_knownAgents')!.enabled).toBe(false)
  })
})

describe('context-builder skills + context-data toggles', () => {
  test('skills section appears by default when getSkills returns text', () => {
    const result = buildContext(mkDeps({
      getSkills: () => 'skill-text',
    }), 'room-1')
    expect(result.messages[0]!.content).toContain('<samsinn:skills>')
    expect(result.messages[0]!.content).toContain('skill-text')
  })

  test('includePrompts.skills false suppresses SKILLS block', () => {
    const result = buildContext(mkDeps({
      getSkills: () => 'skill-text',
      includePrompts: { skills: false },
    }), 'room-1')
    expect(result.messages[0]!.content).not.toContain('<samsinn:skills>')
  })

  test('includeContext.participants false suppresses Other participants', () => {
    // Need to add a participant — simulate by injecting history with another sender
    const history = mkHistory('room-1', 'General', 'Topic: weather.', [{
      id: 'm1', roomId: 'room-1', senderId: 'other-agent', senderName: 'Other',
      content: 'hi', timestamp: Date.now(), type: 'chat',
    }])
    const result = buildContext(mkDeps({
      history,
      includeContext: { participants: false },
    }), 'room-1')
    expect(result.messages[0]!.content).not.toContain('Other participants:')
  })

  test('includeContext.knownAgents false suppresses Known agents line', () => {
    const history = mkHistory('room-1', 'General', undefined, [])
    history.agentProfiles.set('b', { id: 'b', name: 'Bob', kind: 'ai' })
    const result = buildContext(mkDeps({
      history,
      includeContext: { knownAgents: false },
    }), 'room-1')
    expect(result.messages[0]!.content).not.toContain('Known agents:')
  })
})

// ============================================================================
// Strategy split — see ContextStrategy in context-builder.ts.
// These tests guard the regression class that motivated the split: dialogue
// inside a system prompt makes models autocomplete from it (the "Sam parroted
// Alex" bug). Structural tests alone wouldn't catch a future change that
// re-inlined dialogue into the system block.
// ============================================================================

const SCRIPT_DOC = `# SCRIPT: Test\n\n## Cast\n### Alex\n- persona: lead\n### Sam\n- persona: critic\n\n## Step 1 — Open\nRoles:\n  Alex — propose\n  Sam — challenge`
const dialogueFixture = [
  { speaker: 'Alex', content: 'I think we should ship.' },
  { speaker: 'Sam', content: 'What about the migration risk?' },
]

const mkScriptDeps = (overrides: Partial<BuildContextDeps> = {}): BuildContextDeps => mkDeps({
  agentId: 'agent-alex',
  resolveName: (id) => id === 'agent-alex' ? 'Alex' : id,
  getScriptContext: (_roomId, agentName) =>
    agentName === 'Alex'
      ? { systemDoc: SCRIPT_DOC, dialogue: dialogueFixture }
      : undefined,
  ...overrides,
})

describe('selectStrategy — routing', () => {
  test('returns Script strategy when getScriptContext returns a value', () => {
    const deps = mkScriptDeps()
    const strategy = __strategyTestSeam.selectStrategy(deps, 'room-1')
    // Script: trailing instruction is non-null and contains the speak prompt.
    const trailing = strategy.buildTrailingInstruction()
    expect(trailing).not.toBeNull()
    expect(trailing!.content).toContain('Speak your next line as Alex')
  })

  test('returns Normal strategy when getScriptContext is absent', () => {
    const deps = mkDeps()  // no getScriptContext
    const strategy = __strategyTestSeam.selectStrategy(deps, 'room-1')
    expect(strategy.buildTrailingInstruction()).toBeNull()
  })

  test('returns Normal strategy when getScriptContext returns undefined for this agent', () => {
    const deps = mkScriptDeps({
      agentId: 'agent-bystander',
      resolveName: (id) => id === 'agent-bystander' ? 'Bystander' : id,
    })
    const strategy = __strategyTestSeam.selectStrategy(deps, 'room-1')
    expect(strategy.buildTrailingInstruction()).toBeNull()
  })
})

describe('createScriptStrategy — content regression guards', () => {
  // The "Sam parroted Alex" bug: dialogue inside a system block causes
  // autocompletion. These assertions guarantee dialogue lives in user/
  // assistant messages, NOT in the system block.

  test('system block contains script structure but NONE of the dialogue contents', () => {
    const deps = mkScriptDeps()
    const strategy = __strategyTestSeam.selectStrategy(deps, 'room-1')
    const sysText = strategy.buildSystemBlocks().map(b => b.text).join('\n')
    expect(sysText).toContain('SCRIPT: Test')
    expect(sysText).toContain('Roles:')
    for (const entry of dialogueFixture) {
      expect(sysText).not.toContain(entry.content)
    }
  })

  test('own-speaker dialogue is rendered as assistant role', () => {
    const deps = mkScriptDeps()
    const strategy = __strategyTestSeam.selectStrategy(deps, 'room-1')
    const { messages } = strategy.buildHistoryMessages()
    const ownEntries = messages.filter(m => m.role === 'assistant')
    expect(ownEntries).toHaveLength(1)
    expect(ownEntries[0]!.content).toBe('I think we should ship.')
  })

  test('other-speaker dialogue is rendered as user role with "{speaker} said:" prefix', () => {
    const deps = mkScriptDeps()
    const strategy = __strategyTestSeam.selectStrategy(deps, 'room-1')
    const { messages } = strategy.buildHistoryMessages()
    const others = messages.filter(m => m.role === 'user')
    expect(others).toHaveLength(1)
    expect(others[0]!.content).toBe('Sam said: What about the migration risk?')
  })

  test('all fresh incoming messages are added to flushIds', () => {
    const incoming: Message[] = [
      { id: 'inc-1', roomId: 'room-1', senderId: 'other', senderName: 'Other', content: 'hi', type: 'chat', timestamp: Date.now() },
      { id: 'inc-2', roomId: 'room-1', senderId: 'other', senderName: 'Other', content: 'hi2', type: 'chat', timestamp: Date.now() },
      { id: 'inc-skip', roomId: 'room-other', senderId: 'other', senderName: 'Other', content: 'wrong room', type: 'chat', timestamp: Date.now() },
    ]
    const history: AgentHistory = {
      rooms: new Map([['room-1', { profile: mkProfile('room-1', 'General'), history: [], lastActiveAt: Date.now() }]]),
      incoming,
      agentProfiles: new Map(),
    }
    const deps = mkScriptDeps({ history })
    const strategy = __strategyTestSeam.selectStrategy(deps, 'room-1')
    const { flushIds } = strategy.buildHistoryMessages()
    expect(flushIds.has('inc-1')).toBe(true)
    expect(flushIds.has('inc-2')).toBe(true)
    expect(flushIds.has('inc-skip')).toBe(false)  // wrong room — must NOT be flushed
  })
})

describe('buildContext — end-to-end snapshots (wire-format parity guard)', () => {
  test('Normal path: full message array shape', () => {
    const incoming: Message[] = [
      { id: 'in-1', roomId: 'room-1', senderId: 'b', senderName: 'Bob', content: 'morning', type: 'chat', timestamp: 1 },
    ]
    const old: Message[] = [
      { id: 'old-1', roomId: 'room-1', senderId: 'b', senderName: 'Bob', content: 'evening', type: 'chat', timestamp: 0 },
    ]
    const history: AgentHistory = {
      rooms: new Map([['room-1', { profile: mkProfile('room-1', 'General'), history: old, lastActiveAt: Date.now() }]]),
      incoming,
      agentProfiles: new Map([['b', { id: 'b', name: 'Bob', kind: 'ai' }]]),
    }
    const result = buildContext(mkDeps({
      history,
      resolveName: (id) => id === 'b' ? 'Bob' : id,
    }), 'room-1')
    expect(result.messages.map(m => m.role)).toEqual(['system', 'user', 'user'])
    // First user message is the OLD one (no [NEW] tag); second is the fresh incoming.
    expect(result.messages[1]!.content).toContain('[Bob]: evening')
    expect(result.messages[1]!.content).not.toContain('[NEW]')
    expect(result.messages[2]!.content).toContain('[NEW]')
    expect(result.messages[2]!.content).toContain('[Bob]: morning')
    expect(result.flushInfo.ids.has('in-1')).toBe(true)
    expect(result.flushInfo.ids.has('old-1')).toBe(false)
  })

  test('Script path: full message array shape with trailing instruction', () => {
    const result = buildContext(mkScriptDeps(), 'room-1')
    // system + dialogue (1 assistant + 1 user) + trailing user instruction.
    expect(result.messages.map(m => m.role)).toEqual(['system', 'assistant', 'user', 'user'])
    expect(result.messages[0]!.content).toContain('SCRIPT: Test')
    expect(result.messages[1]!.content).toBe('I think we should ship.')
    expect(result.messages[2]!.content).toBe('Sam said: What about the migration risk?')
    expect(result.messages[3]!.content).toContain('Speak your next line as Alex')
    // Single non-cacheable system block — see ScriptStrategy.buildSystemBlocks.
    expect(result.systemBlocks).toHaveLength(1)
    expect(result.systemBlocks![0]!.cacheable).toBe(false)
  })
})

