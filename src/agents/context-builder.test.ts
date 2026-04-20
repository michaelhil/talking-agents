import { test, expect, describe } from 'bun:test'
import { buildContext, buildSystemSections, type BuildContextDeps } from './context-builder.ts'
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
    expect(sys).toContain('=== HOUSE RULES ===')
    expect(sys).toContain('=== ROOM: General ===')
    expect(sys).toContain('=== YOUR IDENTITY ===')
    expect(sys).toContain('=== RESPONSE FORMAT ===')
  })

  test('house: false suppresses HOUSE RULES only', () => {
    const result = buildContext(mkDeps({ includePrompts: { house: false } }), 'room-1')
    const sys = result.messages[0]!.content
    expect(sys).not.toContain('=== HOUSE RULES ===')
    expect(sys).toContain('=== ROOM: General ===')
    expect(sys).toContain('=== YOUR IDENTITY ===')
    expect(sys).toContain('=== RESPONSE FORMAT ===')
  })

  test('room: false suppresses ROOM only', () => {
    const result = buildContext(mkDeps({ includePrompts: { room: false } }), 'room-1')
    const sys = result.messages[0]!.content
    expect(sys).not.toContain('=== ROOM: General ===')
    expect(sys).toContain('=== HOUSE RULES ===')
    expect(sys).toContain('=== YOUR IDENTITY ===')
  })

  test('persona: false suppresses YOUR IDENTITY only', () => {
    const result = buildContext(mkDeps({ includePrompts: { persona: false } }), 'room-1')
    const sys = result.messages[0]!.content
    expect(sys).not.toContain('=== YOUR IDENTITY ===')
    expect(sys).toContain('=== HOUSE RULES ===')
  })

  test('responseFormat: false suppresses RESPONSE FORMAT only', () => {
    const result = buildContext(mkDeps({ includePrompts: { responseFormat: false } }), 'room-1')
    const sys = result.messages[0]!.content
    expect(sys).not.toContain('=== RESPONSE FORMAT ===')
    expect(sys).toContain('=== YOUR IDENTITY ===')
  })

  test('all four off: none of the four sections present; CONTEXT still emitted', () => {
    const result = buildContext(mkDeps({
      includePrompts: { persona: false, room: false, house: false, responseFormat: false },
    }), 'room-1')
    const sys = result.messages[0]!.content
    expect(sys).not.toContain('=== HOUSE RULES ===')
    expect(sys).not.toContain('=== ROOM: General ===')
    expect(sys).not.toContain('=== YOUR IDENTITY ===')
    expect(sys).not.toContain('=== RESPONSE FORMAT ===')
    expect(sys).toContain('=== CONTEXT ===')
  })

  test('partial includePrompts defaults missing keys to true', () => {
    const result = buildContext(mkDeps({ includePrompts: { house: false } }), 'room-1')
    const sys = result.messages[0]!.content
    expect(sys).toContain('=== YOUR IDENTITY ===')
    expect(sys).toContain('=== ROOM: General ===')
    expect(sys).toContain('=== RESPONSE FORMAT ===')
  })

  test('promptsEnabled: false excludes every prompt regardless of per-key flags', () => {
    const result = buildContext(mkDeps({
      promptsEnabled: false,
      includePrompts: { persona: true, room: true, house: true, responseFormat: true, skills: true },
    }), 'room-1')
    const sys = result.messages[0]!.content
    expect(sys).not.toContain('=== HOUSE RULES ===')
    expect(sys).not.toContain('=== ROOM: General ===')
    expect(sys).not.toContain('=== YOUR IDENTITY ===')
    expect(sys).not.toContain('=== RESPONSE FORMAT ===')
  })

  test('contextEnabled: false suppresses participants/flow/artifacts/activity/knownAgents', () => {
    const sections = buildSystemSections(mkDeps({ contextEnabled: false }), 'room-1')
    const toggleableKeys = ['ctx_participants', 'ctx_flow', 'ctx_artifacts', 'ctx_activity', 'ctx_knownAgents']
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
    expect(byKey.ctx_newHint?.optional).toBe(false)
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
    expect(result.messages[0]!.content).toContain('=== SKILLS ===')
    expect(result.messages[0]!.content).toContain('skill-text')
  })

  test('includePrompts.skills false suppresses SKILLS block', () => {
    const result = buildContext(mkDeps({
      getSkills: () => 'skill-text',
      includePrompts: { skills: false },
    }), 'room-1')
    expect(result.messages[0]!.content).not.toContain('=== SKILLS ===')
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

describe('context-builder flow stepPrompt toggle', () => {
  test('includeFlowStepPrompt=true emits [Step instruction: ...] suffix', () => {
    const msg: Message = {
      id: 'm1', roomId: 'room-1', senderId: 'other', senderName: 'Other',
      content: 'hi', timestamp: Date.now(), type: 'chat',
      metadata: { stepPrompt: 'do X' } as Record<string, unknown>,
    }
    const result = buildContext(mkDeps({
      history: mkHistory('room-1', 'General', undefined, [msg]),
      includeFlowStepPrompt: true,
    }), 'room-1')
    const content = result.messages.map(m => m.content).join('\n')
    expect(content).toContain('[Step instruction: do X]')
  })

  test('includeFlowStepPrompt=false suppresses suffix', () => {
    const msg: Message = {
      id: 'm1', roomId: 'room-1', senderId: 'other', senderName: 'Other',
      content: 'hi', timestamp: Date.now(), type: 'chat',
      metadata: { stepPrompt: 'do X' } as Record<string, unknown>,
    }
    const result = buildContext(mkDeps({
      history: mkHistory('room-1', 'General', undefined, [msg]),
      includeFlowStepPrompt: false,
    }), 'room-1')
    const content = result.messages.map(m => m.content).join('\n')
    expect(content).not.toContain('[Step instruction:')
  })
})

