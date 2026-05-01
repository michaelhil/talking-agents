import { describe, test, expect } from 'bun:test'
import { createRoom } from './room.ts'
import type { Message, RoomProfile } from '../types/messaging.ts'
import { SYSTEM_SENDER_ID } from '../types/constants.ts'

const makeProfile = (overrides?: Partial<RoomProfile>): RoomProfile => ({
  id: 'test-room',
  name: 'Test Room',
  createdBy: 'creator-1',
  createdAt: Date.now(),
  ...overrides,
})

const trackDeliveries = () => {
  const delivered: Array<{ agentId: string; content: string }> = []
  const deliver = (agentId: string, message: Message) => {
    delivered.push({ agentId, content: message.content })
  }
  return { delivered, deliver }
}

// Test helper: name→ID resolver from a static mapping
const makeResolver = (mapping: Record<string, string>) =>
  (name: string): string | undefined => mapping[name]

// ============================================================================
// Basic Room Tests
// ============================================================================

describe('Room — self-contained component', () => {
  test('starts with zero messages and no participants', () => {
    const room = createRoom(makeProfile())
    expect(room.getMessageCount()).toBe(0)
    expect(room.getParticipantIds()).toEqual([])
    expect(room.getRecent(10)).toEqual([])
  })

  test('post appends message with auto-generated id, timestamp, and roomId', () => {
    const room = createRoom(makeProfile({ id: 'my-room' }))
    const message = room.post({
      senderId: 'alice',
      content: 'Hello',
      type: 'chat',
    })

    expect(message.id).toBeTruthy()
    expect(message.timestamp).toBeGreaterThan(0)
    expect(message.roomId).toBe('my-room')
    expect(message.content).toBe('Hello')
    expect(message.senderId).toBe('alice')
    expect(message.type).toBe('chat')
    expect(room.getMessageCount()).toBe(1)
  })

  test('post delivers to all members including sender (broadcast mode)', () => {
    const { delivered, deliver } = trackDeliveries()
    const room = createRoom(makeProfile(), { deliver })

    room.addMember('alice')
    room.addMember('bob')

    room.post({ senderId: 'alice', content: 'Hi', type: 'chat' })
    expect(delivered).toHaveLength(2)
    expect(delivered.map(d => d.agentId).sort()).toEqual(['alice', 'bob'])
    delivered.length = 0
    room.post({ senderId: 'bob', content: 'Hey', type: 'chat' })
    expect(delivered).toHaveLength(2)
  })

  test('works without deliver callback', () => {
    const room = createRoom(makeProfile())
    room.addMember('alice')
    const message = room.post({ senderId: 'alice', content: 'Hi', type: 'chat' })
    expect(message.content).toBe('Hi')
    expect(room.getMessageCount()).toBe(1)
  })

  test('getParticipantIds derives from message senders, excludes system', () => {
    const room = createRoom(makeProfile())

    room.post({ senderId: SYSTEM_SENDER_ID, content: 'Room created', type: 'system' })
    room.post({ senderId: 'alice', content: 'Hi', type: 'chat' })
    room.post({ senderId: 'bob', content: 'Hey', type: 'chat' })
    room.post({ senderId: 'alice', content: 'Again', type: 'chat' })

    const ids = room.getParticipantIds()
    expect(ids).toContain('alice')
    expect(ids).toContain('bob')
    expect(ids).not.toContain(SYSTEM_SENDER_ID)
    expect(ids).toHaveLength(2)
  })

  test('getRecent returns last N messages', () => {
    const room = createRoom(makeProfile())

    for (let i = 0; i < 20; i++) {
      room.post({ senderId: 'alice', content: `msg-${i}`, type: 'chat' })
    }

    const recent5 = room.getRecent(5)
    expect(recent5).toHaveLength(5)
    expect(recent5[0]!.content).toBe('msg-15')
    expect(recent5[4]!.content).toBe('msg-19')

    const all = room.getRecent(100)
    expect(all).toHaveLength(20)
  })

  test('getRecent with n=0 or negative returns empty array', () => {
    const room = createRoom(makeProfile())
    room.post({ senderId: 'alice', content: 'Hi', type: 'chat' })
    expect(room.getRecent(0)).toEqual([])
    expect(room.getRecent(-1)).toEqual([])
  })

  test('profile is accessible', () => {
    const profile = makeProfile({ roomPrompt: 'Be nice' })
    const room = createRoom(profile)

    expect(room.profile.id).toBe('test-room')
    expect(room.profile.name).toBe('Test Room')
    expect(room.profile.roomPrompt).toBe('Be nice')
  })

  test('join messages do NOT implicitly add membership (use addMember explicitly)', () => {
    const room = createRoom(makeProfile())
    room.post({ senderId: 'alice', content: '[alice] has joined', type: 'join' })
    // join/leave messages don't trigger implicit membership — use room.addMember()
    expect(room.getParticipantIds()).not.toContain('alice')
  })

  test('preserves generationMs when provided', () => {
    const room = createRoom(makeProfile())
    const message = room.post({
      senderId: 'bot-1',
      content: 'Analyzed data',
      type: 'chat',
      generationMs: 2400,
    })
    expect(message.generationMs).toBe(2400)
  })

  test('preserves typed optional fields on post (tokens, provider, model)', () => {
    const room = createRoom(makeProfile())
    const message = room.post({
      senderId: 'alice',
      content: 'With telemetry',
      type: 'chat',
      promptTokens: 120,
      completionTokens: 45,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
    })
    expect(message.promptTokens).toBe(120)
    expect(message.completionTokens).toBe(45)
    expect(message.provider).toBe('gemini')
    expect(message.model).toBe('gemini-2.5-flash')
  })

  test('message IDs are unique (UUID-based)', () => {
    const room = createRoom(makeProfile())
    const ids = new Set<string>()

    for (let i = 0; i < 100; i++) {
      const message = room.post({ senderId: 'alice', content: `msg-${i}`, type: 'chat' })
      ids.add(message.id)
    }

    expect(ids.size).toBe(100)
  })

  // === Member management ===

  test('addMember adds without requiring a post', () => {
    const room = createRoom(makeProfile())
    room.addMember('invited-agent')
    expect(room.hasMember('invited-agent')).toBe(true)
    expect(room.getParticipantIds()).toContain('invited-agent')
  })

  test('addMember is idempotent', () => {
    const room = createRoom(makeProfile())
    room.addMember('alice')
    room.addMember('alice')
    room.addMember('alice')
    expect(room.getParticipantIds().filter(id => id === 'alice')).toHaveLength(1)
  })

  test('removeMember removes agent from members and future delivery', () => {
    const delivered: string[] = []
    const room = createRoom(makeProfile(), {
      deliver: (agentId) => { delivered.push(agentId) },
    })

    room.addMember('alice')
    room.addMember('bob')

    room.removeMember('alice')
    expect(room.hasMember('alice')).toBe(false)
    expect(room.getParticipantIds()).not.toContain('alice')

    room.post({ senderId: 'bob', content: 'Still here?', type: 'chat' })
    expect(delivered).toEqual(['bob'])
  })

  test('removeMember is safe for non-existent members', () => {
    const room = createRoom(makeProfile())
    room.removeMember('nonexistent')
    expect(room.hasMember('nonexistent')).toBe(false)
  })

  test('hasMember returns false for system sender', () => {
    const room = createRoom(makeProfile())
    room.post({ senderId: SYSTEM_SENDER_ID, content: 'System msg', type: 'system' })
    expect(room.hasMember(SYSTEM_SENDER_ID)).toBe(false)
  })

  test('post throws on empty senderId', () => {
    const room = createRoom(makeProfile())
    expect(() => room.post({ senderId: '', content: 'Hi', type: 'chat' })).toThrow()
  })

  test('post throws on whitespace-only senderId', () => {
    const room = createRoom(makeProfile())
    expect(() => room.post({ senderId: '   ', content: 'Hi', type: 'chat' })).toThrow()
  })

  test('senderName is preserved on messages', () => {
    const room = createRoom(makeProfile())
    const msg = room.post({ senderId: 'a', senderName: 'Alice', content: 'hi', type: 'chat' })
    expect(msg.senderName).toBe('Alice')
  })

  test('senderName is optional (backwards compatibility)', () => {
    const room = createRoom(makeProfile())
    const msg = room.post({ senderId: 'a', content: 'hi', type: 'chat' })
    expect(msg.senderName).toBeUndefined()
  })
})

// ============================================================================
// Delivery Mode Tests
// ============================================================================

describe('Room — Delivery modes', () => {
  test('defaults to broadcast mode', () => {
    const room = createRoom(makeProfile())
    expect(room.deliveryMode).toBe('broadcast')
  })

  test('setDeliveryMode switches mode', () => {
    const room = createRoom(makeProfile())
    room.setDeliveryMode('broadcast')
    expect(room.deliveryMode).toBe('broadcast')
    room.setDeliveryMode('broadcast')
    expect(room.deliveryMode).toBe('broadcast')
  })

  test('manual mode delivers only to humans and the AI sender (AI peers skipped)', () => {
    const { delivered, deliver } = trackDeliveries()
    const kinds: Record<string, 'ai' | 'human'> = {
      'ai-a': 'ai', 'ai-b': 'ai', 'human-1': 'human',
    }
    const resolveKind = (id: string) => kinds[id]
    const room = createRoom(makeProfile(), { deliver, resolveKind })
    room.addMember('ai-a'); room.addMember('ai-b'); room.addMember('human-1')
    room.setDeliveryMode('manual')

    // Human posts — only the human member receives (senders are added to members when posting).
    room.post({ senderId: 'human-1', content: 'Hello', type: 'chat' })
    expect(delivered.map(d => d.agentId).sort()).toEqual(['human-1'])
    delivered.length = 0

    // AI-a posts — AI-a receives (self), human-1 receives, ai-b is skipped.
    room.post({ senderId: 'ai-a', content: 'Reply', type: 'chat' })
    expect(delivered.map(d => d.agentId).sort()).toEqual(['ai-a', 'human-1'])
  })

  test('manual mode ignores [[AgentName]] addressing', () => {
    const { delivered, deliver } = trackDeliveries()
    const kinds: Record<string, 'ai' | 'human'> = { 'ai-a': 'ai', 'human-1': 'human' }
    const room = createRoom(makeProfile(), {
      deliver,
      resolveKind: (id) => kinds[id],
      resolveAgentName: makeResolver({ 'Alpha': 'ai-a' }),
    })
    room.addMember('ai-a'); room.addMember('human-1')
    room.setDeliveryMode('manual')

    room.post({ senderId: 'human-1', content: '[[Alpha]] please respond', type: 'chat' })
    expect(delivered.map(d => d.agentId).sort()).toEqual(['human-1'])
  })

  test('onManualModeEntered fires only on transition into manual', () => {
    const calls: string[] = []
    const room = createRoom(makeProfile(), { onManualModeEntered: (id) => calls.push(id) })
    expect(calls).toEqual([])
    room.setDeliveryMode('manual')
    expect(calls).toEqual(['test-room'])
    room.setDeliveryMode('manual') // no-op re-entry — still counts? setDeliveryMode is called; prevMode === manual now, skipped.
    expect(calls).toEqual(['test-room'])
    room.setDeliveryMode('broadcast')
    room.setDeliveryMode('manual')
    expect(calls).toEqual(['test-room', 'test-room'])
  })
})

// ============================================================================
// Muting Tests
// ============================================================================

describe('Room — Muting', () => {
  test('agents are not muted by default', () => {
    const room = createRoom(makeProfile())
    room.addMember('a')
    expect(room.isMuted('a')).toBe(false)
    expect(room.getMutedIds().size).toBe(0)
  })

  test('setMuted mutes and unmutes agents', () => {
    const room = createRoom(makeProfile())
    room.addMember('a')

    room.setMuted('a', true)
    expect(room.isMuted('a')).toBe(true)
    expect(room.getMutedIds().has('a')).toBe(true)

    room.setMuted('a', false)
    expect(room.isMuted('a')).toBe(false)
  })

  test('muting posts a system message to room history', () => {
    const room = createRoom(makeProfile())
    room.post({ senderId: 'a', senderName: 'Alice', content: 'hi', type: 'chat' })
    const countBefore = room.getMessageCount()

    room.setMuted('a', true)
    expect(room.getMessageCount()).toBe(countBefore + 1)

    const lastMsg = room.getRecent(1)[0]!
    expect(lastMsg.type).toBe('mute')
    expect(lastMsg.content).toContain('Alice')
    expect(lastMsg.content).toContain('muted')
    expect(lastMsg.senderId).toBe(SYSTEM_SENDER_ID)
  })

  test('unmuting posts an unmute message', () => {
    const room = createRoom(makeProfile())
    room.post({ senderId: 'a', senderName: 'Alice', content: 'hi', type: 'chat' })

    room.setMuted('a', true)
    room.setMuted('a', false)

    const lastMsg = room.getRecent(1)[0]!
    expect(lastMsg.type).toBe('mute')
    expect(lastMsg.content).toContain('unmuted')
  })

  test('muted agents are excluded from broadcast delivery', () => {
    const { delivered, deliver } = trackDeliveries()
    const room = createRoom(makeProfile(), { deliver })

    room.addMember('a')
    room.addMember('b')
    room.addMember('c')
    room.setMuted('b', true)

    room.post({ senderId: 'a', content: 'Hello', type: 'chat' })

    const agentIds = delivered.map(d => d.agentId)
    expect(agentIds).toContain('a')
    expect(agentIds).toContain('c')
    expect(agentIds).not.toContain('b')
  })

  test('muted agents are excluded from [[AgentName]] addressing', () => {
    const { delivered, deliver } = trackDeliveries()
    const room = createRoom(makeProfile(), { deliver })

    room.addMember('a')
    room.addMember('b')

    room.post({ senderId: 'a', senderName: 'Alice', content: 'setup', type: 'chat' })
    room.post({ senderId: 'b', senderName: 'Bob', content: 'setup', type: 'chat' })
    delivered.length = 0

    room.setMuted('b', true)
    room.post({ senderId: 'a', senderName: 'Alice', content: '[[Bob]] hello?', type: 'chat' })

    // Bob is muted, so addressing fails → falls through to broadcast (excluding muted)
    const agentIds = delivered.map(d => d.agentId)
    expect(agentIds).not.toContain('b')
  })

  test('setMuted is idempotent (no duplicate messages)', () => {
    const room = createRoom(makeProfile())
    room.post({ senderId: 'a', senderName: 'Alice', content: 'hi', type: 'chat' })

    room.setMuted('a', true)
    const count1 = room.getMessageCount()
    room.setMuted('a', true) // already muted
    expect(room.getMessageCount()).toBe(count1) // no new message
  })
})


// ============================================================================
// Directed Addressing Tests
// ============================================================================

describe('Room — Directed Addressing [[AgentName]]', () => {
  const nameMap = makeResolver({ Alice: 'a', Bob: 'b', Charlie: 'c' })

  test('broadcast mode: [[AgentName]] delivers only to addressed agent', () => {
    const { delivered, deliver } = trackDeliveries()
    const room = createRoom(makeProfile(), { deliver, resolveAgentName: nameMap })

    room.addMember('a')
    room.addMember('b')
    room.addMember('c')

    room.post({ senderId: 'a', senderName: 'Alice', content: 'setup', type: 'chat' })
    room.post({ senderId: 'b', senderName: 'Bob', content: 'setup', type: 'chat' })
    room.post({ senderId: 'c', senderName: 'Charlie', content: 'setup', type: 'chat' })
    delivered.length = 0

    room.post({ senderId: 'a', senderName: 'Alice', content: '[[Bob]] what do you think?', type: 'chat' })
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.agentId).toBe('b')
  })

  test('broadcast mode: [[AgentName]] with multiple targets', () => {
    const { delivered, deliver } = trackDeliveries()
    const room = createRoom(makeProfile(), { deliver, resolveAgentName: nameMap })

    room.addMember('a')
    room.addMember('b')
    room.addMember('c')

    room.post({ senderId: 'a', senderName: 'Alice', content: 'hi', type: 'chat' })
    room.post({ senderId: 'b', senderName: 'Bob', content: 'hi', type: 'chat' })
    room.post({ senderId: 'c', senderName: 'Charlie', content: 'hi', type: 'chat' })
    delivered.length = 0

    room.post({ senderId: 'a', senderName: 'Alice', content: '[[Bob]] [[Charlie]] compare notes', type: 'chat' })
    expect(delivered).toHaveLength(2)
    expect(delivered.map(d => d.agentId).sort()).toEqual(['b', 'c'])
  })

  test('unresolvable [[Name]] falls through to broadcast', () => {
    const { delivered, deliver } = trackDeliveries()
    const room = createRoom(makeProfile(), { deliver, resolveAgentName: nameMap })

    room.addMember('a')
    room.addMember('b')

    room.post({ senderId: 'a', senderName: 'Alice', content: 'hi', type: 'chat' })
    delivered.length = 0

    room.post({ senderId: 'a', senderName: 'Alice', content: '[[Nobody]] hello?', type: 'chat' })
    expect(delivered).toHaveLength(2)
    expect(delivered.map(d => d.agentId).sort()).toEqual(['a', 'b'])
  })

  test('message with [[AgentName]] is always stored regardless of delivery', () => {
    const { deliver } = trackDeliveries()
    const room = createRoom(makeProfile(), { deliver, resolveAgentName: nameMap })

    room.addMember('a')
    room.addMember('b')

    room.post({ senderId: 'a', senderName: 'Alice', content: 'setup', type: 'chat' })
    room.post({ senderId: 'b', senderName: 'Bob', content: 'setup', type: 'chat' })
    const before = room.getMessageCount()

    room.post({ senderId: 'a', senderName: 'Alice', content: '[[Bob]] directed msg', type: 'chat' })
    expect(room.getMessageCount()).toBe(before + 1)
  })
})

