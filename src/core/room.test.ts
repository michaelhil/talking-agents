import { describe, test, expect } from 'bun:test'
import { createRoom } from './room.ts'
import type { Message, RoomProfile } from './types.ts'
import { SYSTEM_SENDER_ID } from './types.ts'

const makeProfile = (overrides?: Partial<RoomProfile>): RoomProfile => ({
  id: 'test-room',
  name: 'Test Room',
  visibility: 'public',
  createdBy: 'creator-1',
  createdAt: Date.now(),
  ...overrides,
})

const trackDeliveries = () => {
  const delivered: Array<{ agentId: string; content: string; historyLen: number }> = []
  const deliver = (agentId: string, message: Message, history: ReadonlyArray<Message>) => {
    delivered.push({ agentId, content: message.content, historyLen: history.length })
  }
  return { delivered, deliver }
}

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
    expect(delivered[0]!.historyLen).toBe(0)

    delivered.length = 0
    room.post({ senderId: 'bob', content: 'Hey', type: 'chat' })
    expect(delivered).toHaveLength(2)
    expect(delivered.every(d => d.historyLen === 1)).toBe(true)
  })

  test('post delivers history excluding the new message', () => {
    const histories: ReadonlyArray<Message>[] = []
    const room = createRoom(makeProfile(), {
      deliver: (_agentId, _message, history) => { histories.push(history) },
    })

    room.addMember('alice')
    room.addMember('bob')

    room.post({ senderId: 'alice', content: 'msg-1', type: 'chat' })
    room.post({ senderId: 'alice', content: 'msg-2', type: 'chat' })
    room.post({ senderId: 'alice', content: 'msg-3', type: 'chat' })

    const lastHistory = histories[histories.length - 1]!
    expect(lastHistory).toHaveLength(2)
    expect(lastHistory[0]!.content).toBe('msg-1')
    expect(lastHistory[1]!.content).toBe('msg-2')
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
    const profile = makeProfile({ description: 'A test room', roomPrompt: 'Be nice' })
    const room = createRoom(profile)

    expect(room.profile.id).toBe('test-room')
    expect(room.profile.name).toBe('Test Room')
    expect(room.profile.description).toBe('A test room')
    expect(room.profile.roomPrompt).toBe('Be nice')
    expect(room.profile.visibility).toBe('public')
  })

  test('join messages make the joiner a participant', () => {
    const room = createRoom(makeProfile())
    room.post({ senderId: 'alice', content: '[alice] has joined', type: 'join' })
    expect(room.getParticipantIds()).toContain('alice')
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

  test('preserves metadata when provided', () => {
    const room = createRoom(makeProfile())
    const message = room.post({
      senderId: 'alice',
      content: 'With meta',
      type: 'chat',
      metadata: { source: 'test', priority: 1 },
    })
    expect(message.metadata).toEqual({ source: 'test', priority: 1 })
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

  test('evicts oldest messages when exceeding maxMessages', () => {
    const room = createRoom(makeProfile(), undefined, 5)

    for (let i = 0; i < 8; i++) {
      room.post({ senderId: 'alice', content: `msg-${i}`, type: 'chat' })
    }

    expect(room.getMessageCount()).toBe(5)
    const recent = room.getRecent(10)
    expect(recent[0]!.content).toBe('msg-3')
    expect(recent[4]!.content).toBe('msg-7')
  })

  test('eviction does not affect member tracking', () => {
    const room = createRoom(makeProfile(), undefined, 3)

    room.post({ senderId: 'alice', content: 'a', type: 'chat' })
    room.post({ senderId: 'bob', content: 'b', type: 'chat' })
    room.post({ senderId: 'charlie', content: 'c', type: 'chat' })
    room.post({ senderId: 'dave', content: 'd', type: 'chat' })
    room.post({ senderId: 'dave', content: 'e', type: 'chat' })
    room.post({ senderId: 'dave', content: 'f', type: 'chat' })

    expect(room.hasMember('alice')).toBe(true)
    expect(room.hasMember('bob')).toBe(true)
    expect(room.hasMember('charlie')).toBe(true)
    expect(room.hasMember('dave')).toBe(true)
    expect(room.getParticipantIds()).toHaveLength(4)
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
    room.setDeliveryMode('targeted')
    expect(room.deliveryMode).toBe('targeted')
    room.setDeliveryMode('broadcast')
    expect(room.deliveryMode).toBe('broadcast')
  })

  test('targeted mode: messages stored but not delivered', () => {
    const { delivered, deliver } = trackDeliveries()
    const room = createRoom(makeProfile(), { deliver })

    room.addMember('a')
    room.addMember('b')
    room.setDeliveryMode('targeted')

    room.post({ senderId: 'a', content: 'Hello', type: 'chat' })
    expect(delivered).toHaveLength(0)
    expect(room.getMessageCount()).toBe(1)
  })

  test('deliverMessageTo delivers existing message to selected agents', () => {
    const { delivered, deliver } = trackDeliveries()
    const room = createRoom(makeProfile(), { deliver })

    room.addMember('a')
    room.addMember('b')
    room.addMember('c')
    room.setDeliveryMode('targeted')

    const msg = room.post({ senderId: 'a', content: 'Hello', type: 'chat' })
    expect(delivered).toHaveLength(0)

    room.deliverMessageTo(msg.id, ['b', 'c'])
    expect(delivered).toHaveLength(2)
    expect(delivered.map(d => d.agentId).sort()).toEqual(['b', 'c'])
  })

  test('deliverMessageTo skips muted agents', () => {
    const { delivered, deliver } = trackDeliveries()
    const room = createRoom(makeProfile(), { deliver })

    room.addMember('a')
    room.addMember('b')
    room.addMember('c')
    room.setDeliveryMode('targeted')
    room.setMuted('c', true)

    const msg = room.post({ senderId: 'a', content: 'Hello', type: 'chat' })
    room.deliverMessageTo(msg.id, ['b', 'c'])

    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.agentId).toBe('b')
  })

  test('deliverMessageTo ignores unknown message IDs', () => {
    const { delivered, deliver } = trackDeliveries()
    const room = createRoom(makeProfile(), { deliver })

    room.addMember('a')
    room.deliverMessageTo('nonexistent', ['a'])
    expect(delivered).toHaveLength(0)
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
// Staleness Mode Tests
// ============================================================================

describe('Room — Staleness mode', () => {
  test('staleness defaults', () => {
    const room = createRoom(makeProfile())
    expect(room.staleness.paused).toBe(false)
    expect(room.staleness.participating.size).toBe(0)
    expect(room.staleness.currentTurn).toBeUndefined()
  })

  test('broadcast mode: delivers to all members', () => {
    const { delivered, deliver } = trackDeliveries()
    const room = createRoom(makeProfile(), { deliver })

    room.addMember('a')
    room.addMember('b')
    room.addMember('c')

    room.post({ senderId: 'a', senderName: 'Alice', content: 'Hello', type: 'chat' })
    expect(delivered).toHaveLength(3)
    expect(delivered.map(d => d.agentId).sort()).toEqual(['a', 'b', 'c'])
  })

  test('staleness mode: delivers only to stalest agent', () => {
    const { delivered, deliver } = trackDeliveries()
    const room = createRoom(makeProfile(), { deliver })

    room.addMember('a')
    room.addMember('b')
    room.addMember('c')

    // Establish staleness: C spoke, then B, then A
    room.post({ senderId: 'c', senderName: 'Charlie', content: 'msg-c', type: 'chat' })
    room.post({ senderId: 'b', senderName: 'Bob', content: 'msg-b', type: 'chat' })
    room.post({ senderId: 'a', senderName: 'Alice', content: 'msg-a', type: 'chat' })
    delivered.length = 0

    room.setParticipating('a', true)
    room.setParticipating('b', true)
    room.setParticipating('c', true)
    room.setDeliveryMode('staleness')

    // Kicks off chain — delivers to stalest (C)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.agentId).toBe('c')
    expect(room.staleness.currentTurn).toBe('c')
  })

  test('staleness chain advances when currentTurn agent responds', () => {
    const { delivered, deliver } = trackDeliveries()
    const room = createRoom(makeProfile(), { deliver })

    room.addMember('a')
    room.addMember('b')
    room.addMember('c')

    room.post({ senderId: 'c', senderName: 'Charlie', content: 'c1', type: 'chat' })
    room.post({ senderId: 'b', senderName: 'Bob', content: 'b1', type: 'chat' })
    room.post({ senderId: 'a', senderName: 'Alice', content: 'a1', type: 'chat' })
    delivered.length = 0

    room.setParticipating('a', true)
    room.setParticipating('b', true)
    room.setParticipating('c', true)
    room.setDeliveryMode('staleness')

    // C was delivered to (stalest). Simulate C's response.
    delivered.length = 0
    room.post({ senderId: 'c', senderName: 'Charlie', content: 'c-response', type: 'chat' })

    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.agentId).toBe('b')
    expect(room.staleness.currentTurn).toBe('b')

    // B responds → advance to A
    delivered.length = 0
    room.post({ senderId: 'b', senderName: 'Bob', content: 'b-response', type: 'chat' })
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.agentId).toBe('a')
    expect(room.staleness.currentTurn).toBe('a')
  })

  test('pass messages advance the staleness turn', () => {
    const { delivered, deliver } = trackDeliveries()
    const room = createRoom(makeProfile(), { deliver })

    room.addMember('a')
    room.addMember('b')

    room.post({ senderId: 'b', senderName: 'Bob', content: 'b1', type: 'chat' })
    room.post({ senderId: 'a', senderName: 'Alice', content: 'a1', type: 'chat' })
    delivered.length = 0

    room.setParticipating('a', true)
    room.setParticipating('b', true)
    room.setDeliveryMode('staleness')

    // B is stalest
    expect(delivered[0]!.agentId).toBe('b')
    delivered.length = 0

    // B passes — advances to A
    room.post({ senderId: 'b', senderName: 'Bob', content: '[pass] nothing to add', type: 'pass' })
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.agentId).toBe('a')
  })

  test('pause stops the staleness chain', () => {
    const { delivered, deliver } = trackDeliveries()
    const room = createRoom(makeProfile(), { deliver })

    room.addMember('a')
    room.addMember('b')

    room.post({ senderId: 'a', senderName: 'Alice', content: 'a1', type: 'chat' })
    room.post({ senderId: 'b', senderName: 'Bob', content: 'b1', type: 'chat' })
    delivered.length = 0

    room.setParticipating('a', true)
    room.setParticipating('b', true)
    room.setDeliveryMode('staleness')
    delivered.length = 0

    room.setStalenessPaused(true)
    expect(room.staleness.paused).toBe(true)
    expect(room.staleness.currentTurn).toBeUndefined()
  })

  test('resume restarts the staleness chain from stalest', () => {
    const { delivered, deliver } = trackDeliveries()
    const room = createRoom(makeProfile(), { deliver })

    room.addMember('a')
    room.addMember('b')

    room.post({ senderId: 'b', senderName: 'Bob', content: 'b1', type: 'chat' })
    room.post({ senderId: 'a', senderName: 'Alice', content: 'a1', type: 'chat' })
    delivered.length = 0

    room.setParticipating('a', true)
    room.setParticipating('b', true)
    room.setDeliveryMode('staleness')

    room.setStalenessPaused(true)
    delivered.length = 0

    room.setStalenessPaused(false)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.agentId).toBe('b')
  })

  test('removing currentTurn agent advances the chain', () => {
    const { delivered, deliver } = trackDeliveries()
    const room = createRoom(makeProfile(), { deliver })

    room.addMember('a')
    room.addMember('b')

    room.post({ senderId: 'b', senderName: 'Bob', content: 'b1', type: 'chat' })
    room.post({ senderId: 'a', senderName: 'Alice', content: 'a1', type: 'chat' })
    delivered.length = 0

    room.setParticipating('a', true)
    room.setParticipating('b', true)
    room.setDeliveryMode('staleness')

    expect(room.staleness.currentTurn).toBe('b')
    delivered.length = 0

    room.setParticipating('b', false)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.agentId).toBe('a')
    expect(room.staleness.currentTurn).toBe('a')
  })

  test('onTurnChanged callback fires on turn changes', () => {
    const turns: Array<{ roomId: string; agentId?: string }> = []
    const onTurnChanged = (roomId: string, agentId?: string) => {
      turns.push({ roomId, agentId })
    }

    const { deliver } = trackDeliveries()
    const room = createRoom(makeProfile({ id: 'room-1' }), { deliver, onTurnChanged })

    room.addMember('a')
    room.addMember('b')
    room.post({ senderId: 'a', senderName: 'Alice', content: 'a1', type: 'chat' })
    room.post({ senderId: 'b', senderName: 'Bob', content: 'b1', type: 'chat' })

    room.setParticipating('a', true)
    room.setParticipating('b', true)
    room.setDeliveryMode('staleness')

    expect(turns.length).toBeGreaterThan(0)
    expect(turns[turns.length - 1]!.roomId).toBe('room-1')
  })

  test('messages from non-currentTurn are stored but not delivered in staleness', () => {
    const { delivered, deliver } = trackDeliveries()
    const room = createRoom(makeProfile(), { deliver })

    room.addMember('a')
    room.addMember('b')
    room.addMember('c')

    room.post({ senderId: 'c', senderName: 'Charlie', content: 'c1', type: 'chat' })
    room.post({ senderId: 'b', senderName: 'Bob', content: 'b1', type: 'chat' })
    room.post({ senderId: 'a', senderName: 'Alice', content: 'a1', type: 'chat' })
    delivered.length = 0

    room.setParticipating('a', true)
    room.setParticipating('b', true)
    room.setParticipating('c', true)
    room.setDeliveryMode('staleness')

    expect(room.staleness.currentTurn).toBe('c')
    delivered.length = 0

    // A posts while C has the floor — no delivery
    room.post({ senderId: 'a', senderName: 'Alice', content: 'interjection', type: 'chat' })
    expect(delivered).toHaveLength(0)
    expect(room.getMessageCount()).toBe(4) // 3 initial + interjection
  })

  test('muted agents skipped in staleness', () => {
    const { delivered, deliver } = trackDeliveries()
    const room = createRoom(makeProfile(), { deliver })

    room.addMember('a')
    room.addMember('b')
    room.addMember('c')

    room.post({ senderId: 'c', senderName: 'Charlie', content: 'c1', type: 'chat' })
    room.post({ senderId: 'b', senderName: 'Bob', content: 'b1', type: 'chat' })
    room.post({ senderId: 'a', senderName: 'Alice', content: 'a1', type: 'chat' })
    delivered.length = 0

    room.setParticipating('a', true)
    room.setParticipating('b', true)
    room.setParticipating('c', true)
    room.setMuted('c', true) // mute stalest agent
    room.setDeliveryMode('staleness')

    // C is muted, so B should be the stalest non-muted participant
    expect(delivered.length).toBeGreaterThan(0)
    expect(delivered[0]!.agentId).toBe('b')
  })
})

// ============================================================================
// Directed Addressing Tests
// ============================================================================

describe('Room — Directed Addressing [[AgentName]]', () => {
  test('broadcast mode: [[AgentName]] delivers only to addressed agent', () => {
    const { delivered, deliver } = trackDeliveries()
    const room = createRoom(makeProfile(), { deliver })

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
    const room = createRoom(makeProfile(), { deliver })

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
    const room = createRoom(makeProfile(), { deliver })

    room.addMember('a')
    room.addMember('b')

    room.post({ senderId: 'a', senderName: 'Alice', content: 'hi', type: 'chat' })
    delivered.length = 0

    room.post({ senderId: 'a', senderName: 'Alice', content: '[[Nobody]] hello?', type: 'chat' })
    expect(delivered).toHaveLength(2)
    expect(delivered.map(d => d.agentId).sort()).toEqual(['a', 'b'])
  })

  test('staleness mode: [[AgentName]] overrides staleness', () => {
    const { delivered, deliver } = trackDeliveries()
    const room = createRoom(makeProfile(), { deliver })

    room.addMember('a')
    room.addMember('b')
    room.addMember('c')

    room.post({ senderId: 'c', senderName: 'Charlie', content: 'c1', type: 'chat' })
    room.post({ senderId: 'b', senderName: 'Bob', content: 'b1', type: 'chat' })
    room.post({ senderId: 'a', senderName: 'Alice', content: 'a1', type: 'chat' })
    delivered.length = 0

    room.setParticipating('a', true)
    room.setParticipating('b', true)
    room.setParticipating('c', true)
    room.setDeliveryMode('staleness')

    // C has the turn (stalest). C addresses Bob directly.
    delivered.length = 0
    room.post({ senderId: 'c', senderName: 'Charlie', content: '[[Bob]] what do you think?', type: 'chat' })

    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.agentId).toBe('b')
    expect(room.staleness.currentTurn).toBe('b')
  })

  test('message with [[AgentName]] is always stored regardless of delivery', () => {
    const { deliver } = trackDeliveries()
    const room = createRoom(makeProfile(), { deliver })

    room.addMember('a')
    room.addMember('b')

    room.post({ senderId: 'a', senderName: 'Alice', content: 'setup', type: 'chat' })
    room.post({ senderId: 'b', senderName: 'Bob', content: 'setup', type: 'chat' })
    const before = room.getMessageCount()

    room.post({ senderId: 'a', senderName: 'Alice', content: '[[Bob]] directed msg', type: 'chat' })
    expect(room.getMessageCount()).toBe(before + 1)
  })
})

// ============================================================================
// Flow Tests
// ============================================================================

describe('Room — Flow mode', () => {
  test('addFlow creates a flow with generated ID', () => {
    const room = createRoom(makeProfile())
    const flow = room.addFlow({
      name: 'Test Flow',
      steps: [{ agentName: 'Alice' }, { agentName: 'Bob' }],
      loop: false,
    })

    expect(flow.id).toBeTruthy()
    expect(flow.name).toBe('Test Flow')
    expect(flow.steps).toHaveLength(2)
    expect(room.getFlows()).toHaveLength(1)
  })

  test('removeFlow deletes a flow', () => {
    const room = createRoom(makeProfile())
    const flow = room.addFlow({ name: 'F', steps: [{ agentName: 'A' }], loop: false })
    expect(room.removeFlow(flow.id)).toBe(true)
    expect(room.getFlows()).toHaveLength(0)
  })

  test('startFlow delivers to first step agent', () => {
    const { delivered, deliver } = trackDeliveries()
    const room = createRoom(makeProfile(), { deliver })

    room.addMember('a')
    room.addMember('b')

    // Establish name resolution
    room.post({ senderId: 'a', senderName: 'Alice', content: 'hi', type: 'chat' })
    room.post({ senderId: 'b', senderName: 'Bob', content: 'hi', type: 'chat' })
    delivered.length = 0

    const flow = room.addFlow({
      name: 'Pipeline',
      steps: [{ agentName: 'Alice' }, { agentName: 'Bob' }],
      loop: false,
    })

    room.startFlow(flow.id)
    expect(room.deliveryMode).toBe('flow')
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.agentId).toBe('a')
  })

  test('flow advances when expected agent responds', () => {
    const { delivered, deliver } = trackDeliveries()
    const room = createRoom(makeProfile(), { deliver })

    room.addMember('a')
    room.addMember('b')

    room.post({ senderId: 'a', senderName: 'Alice', content: 'hi', type: 'chat' })
    room.post({ senderId: 'b', senderName: 'Bob', content: 'hi', type: 'chat' })
    delivered.length = 0

    const flow = room.addFlow({
      name: 'Pipeline',
      steps: [{ agentName: 'Alice' }, { agentName: 'Bob' }],
      loop: false,
    })
    room.startFlow(flow.id)
    delivered.length = 0

    // Alice responds → flow advances to Bob
    room.post({ senderId: 'a', senderName: 'Alice', content: 'analysis done', type: 'chat' })
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.agentId).toBe('b')
  })

  test('flow completes and switches to targeted mode', () => {
    const { delivered, deliver } = trackDeliveries()
    const room = createRoom(makeProfile(), { deliver })

    room.addMember('a')
    room.addMember('b')

    room.post({ senderId: 'a', senderName: 'Alice', content: 'hi', type: 'chat' })
    room.post({ senderId: 'b', senderName: 'Bob', content: 'hi', type: 'chat' })

    const flow = room.addFlow({
      name: 'Pipeline',
      steps: [{ agentName: 'Alice' }, { agentName: 'Bob' }],
      loop: false,
    })
    room.startFlow(flow.id)
    delivered.length = 0

    // Alice responds
    room.post({ senderId: 'a', senderName: 'Alice', content: 'step1', type: 'chat' })
    delivered.length = 0

    // Bob responds → flow complete
    room.post({ senderId: 'b', senderName: 'Bob', content: 'step2', type: 'chat' })
    expect(room.deliveryMode).toBe('targeted')
    expect(room.flowExecution).toBeUndefined()
  })

  test('flow with loop restarts from step 0', () => {
    const { delivered, deliver } = trackDeliveries()
    const room = createRoom(makeProfile(), { deliver })

    room.addMember('a')
    room.addMember('b')

    room.post({ senderId: 'a', senderName: 'Alice', content: 'hi', type: 'chat' })
    room.post({ senderId: 'b', senderName: 'Bob', content: 'hi', type: 'chat' })

    const flow = room.addFlow({
      name: 'Loop',
      steps: [{ agentName: 'Alice' }, { agentName: 'Bob' }],
      loop: true,
    })
    room.startFlow(flow.id)
    delivered.length = 0

    // Complete one cycle: Alice → Bob
    room.post({ senderId: 'a', senderName: 'Alice', content: 'round1-a', type: 'chat' })
    delivered.length = 0
    room.post({ senderId: 'b', senderName: 'Bob', content: 'round1-b', type: 'chat' })

    // Should loop back to Alice
    expect(room.deliveryMode).toBe('flow')
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.agentId).toBe('a')
  })

  test('step prompt is passed via message metadata', () => {
    const deliveredMeta: Array<Record<string, unknown> | undefined> = []
    const room = createRoom(makeProfile(), {
      deliver: (_id, msg) => { deliveredMeta.push(msg.metadata) },
    })

    room.addMember('a')
    room.addMember('b')

    room.post({ senderId: 'a', senderName: 'Alice', content: 'hi', type: 'chat' })
    room.post({ senderId: 'b', senderName: 'Bob', content: 'hi', type: 'chat' })
    deliveredMeta.length = 0

    const flow = room.addFlow({
      name: 'Prompted',
      steps: [
        { agentName: 'Alice', stepPrompt: 'Focus on risks' },
        { agentName: 'Bob', stepPrompt: 'Summarize findings' },
      ],
      loop: false,
    })
    room.startFlow(flow.id)

    // First delivery to Alice should have stepPrompt
    expect(deliveredMeta[0]?.stepPrompt).toBe('Focus on risks')

    deliveredMeta.length = 0
    room.post({ senderId: 'a', senderName: 'Alice', content: 'done', type: 'chat' })

    // Delivery to Bob should have Bob's stepPrompt
    expect(deliveredMeta[0]?.stepPrompt).toBe('Summarize findings')
  })

  test('cancelFlow stops execution and switches to targeted', () => {
    const { deliver } = trackDeliveries()
    const room = createRoom(makeProfile(), { deliver })

    room.addMember('a')
    room.post({ senderId: 'a', senderName: 'Alice', content: 'hi', type: 'chat' })

    const flow = room.addFlow({ name: 'F', steps: [{ agentName: 'Alice' }], loop: true })
    room.startFlow(flow.id)
    expect(room.deliveryMode).toBe('flow')

    room.cancelFlow()
    expect(room.deliveryMode).toBe('targeted')
    expect(room.flowExecution).toBeUndefined()
  })

  test('off-turn posts during flow are stored but not delivered', () => {
    const { delivered, deliver } = trackDeliveries()
    const room = createRoom(makeProfile(), { deliver })

    room.addMember('a')
    room.addMember('b')

    room.post({ senderId: 'a', senderName: 'Alice', content: 'hi', type: 'chat' })
    room.post({ senderId: 'b', senderName: 'Bob', content: 'hi', type: 'chat' })

    const flow = room.addFlow({
      name: 'F',
      steps: [{ agentName: 'Alice' }, { agentName: 'Bob' }],
      loop: false,
    })
    room.startFlow(flow.id)
    delivered.length = 0

    // Bob posts while Alice has the floor
    room.post({ senderId: 'b', senderName: 'Bob', content: 'interjection', type: 'chat' })
    expect(delivered).toHaveLength(0) // not delivered, stored only
  })
})
