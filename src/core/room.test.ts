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
    expect(message.roomId).toBe('my-room') // room stamps its own ID
    expect(message.content).toBe('Hello')
    expect(message.senderId).toBe('alice')
    expect(message.type).toBe('chat')
    expect(room.getMessageCount()).toBe(1)
  })

  test('post delivers to all members including sender', () => {
    const delivered: Array<{ agentId: string; message: Message; historyLen: number }> = []
    const room = createRoom(makeProfile(), (agentId, message, history) => {
      delivered.push({ agentId, message, historyLen: history.length })
    })

    room.addMember('alice')
    room.addMember('bob')

    // Alice posts — delivered to both Alice and Bob
    room.post({ senderId: 'alice', content: 'Hi', type: 'chat' })
    expect(delivered).toHaveLength(2)
    expect(delivered.map(d => d.agentId).sort()).toEqual(['alice', 'bob'])
    expect(delivered[0]!.historyLen).toBe(0) // no prior messages

    delivered.length = 0

    // Bob posts — delivered to both, with 1 message of history
    room.post({ senderId: 'bob', content: 'Hey', type: 'chat' })
    expect(delivered).toHaveLength(2)
    expect(delivered.every(d => d.historyLen === 1)).toBe(true)
  })

  test('post delivers history excluding the new message', () => {
    const histories: ReadonlyArray<Message>[] = []
    const room = createRoom(makeProfile(), (_agentId, _message, history) => {
      histories.push(history)
    })

    room.addMember('alice')
    room.addMember('bob')

    room.post({ senderId: 'alice', content: 'msg-1', type: 'chat' })
    room.post({ senderId: 'alice', content: 'msg-2', type: 'chat' })
    room.post({ senderId: 'alice', content: 'msg-3', type: 'chat' })

    // Third post: history should contain msg-1 and msg-2 but NOT msg-3
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

  test('message IDs are unique across different rooms', () => {
    const room1 = createRoom(makeProfile({ id: 'room-1' }))
    const room2 = createRoom(makeProfile({ id: 'room-2' }))
    const ids = new Set<string>()

    for (let i = 0; i < 50; i++) {
      ids.add(room1.post({ senderId: 'alice', content: `r1-${i}`, type: 'chat' }).id)
      ids.add(room2.post({ senderId: 'bob', content: `r2-${i}`, type: 'chat' }).id)
    }

    expect(ids.size).toBe(100)
  })

  // === Message eviction ===

  test('evicts oldest messages when exceeding maxMessages', () => {
    const room = createRoom(makeProfile(), undefined, undefined, 5)

    for (let i = 0; i < 8; i++) {
      room.post({ senderId: 'alice', content: `msg-${i}`, type: 'chat' })
    }

    expect(room.getMessageCount()).toBe(5)
    const recent = room.getRecent(10)
    expect(recent[0]!.content).toBe('msg-3')
    expect(recent[4]!.content).toBe('msg-7')
  })

  test('eviction does not affect member tracking', () => {
    const room = createRoom(makeProfile(), undefined, undefined, 3)

    room.post({ senderId: 'alice', content: 'a', type: 'chat' })
    room.post({ senderId: 'bob', content: 'b', type: 'chat' })
    room.post({ senderId: 'charlie', content: 'c', type: 'chat' })
    // All 3 messages evicted after next 3 posts
    room.post({ senderId: 'dave', content: 'd', type: 'chat' })
    room.post({ senderId: 'dave', content: 'e', type: 'chat' })
    room.post({ senderId: 'dave', content: 'f', type: 'chat' })

    // Alice/bob/charlie messages are gone but they're still members
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
    const room = createRoom(makeProfile(), (agentId) => { delivered.push(agentId) })

    room.addMember('alice')
    room.addMember('bob')

    room.removeMember('alice')
    expect(room.hasMember('alice')).toBe(false)
    expect(room.getParticipantIds()).not.toContain('alice')

    // Alice no longer receives messages (bob gets his own echo)
    room.post({ senderId: 'bob', content: 'Still here?', type: 'chat' })
    expect(delivered).toEqual(['bob'])
  })

  test('removeMember is safe for non-existent members', () => {
    const room = createRoom(makeProfile())
    room.removeMember('nonexistent') // should not throw
    expect(room.hasMember('nonexistent')).toBe(false)
  })

  test('hasMember returns false for system sender', () => {
    const room = createRoom(makeProfile())
    room.post({ senderId: SYSTEM_SENDER_ID, content: 'System msg', type: 'system' })
    expect(room.hasMember(SYSTEM_SENDER_ID)).toBe(false)
  })

  // === Input validation ===

  test('post throws on empty senderId', () => {
    const room = createRoom(makeProfile())
    expect(() => room.post({ senderId: '', content: 'Hi', type: 'chat' })).toThrow()
  })

  test('post throws on whitespace-only senderId', () => {
    const room = createRoom(makeProfile())
    expect(() => room.post({ senderId: '   ', content: 'Hi', type: 'chat' })).toThrow()
  })
})

// ============================================================================
// Turn-Taking Tests
// ============================================================================

describe('Room — Turn-Taking mode', () => {
  const trackDeliveries = () => {
    const delivered: Array<{ agentId: string; content: string }> = []
    const deliverFn = (agentId: string, message: Message) => {
      delivered.push({ agentId, content: message.content })
    }
    return { delivered, deliverFn }
  }

  test('turnTaking defaults to disabled', () => {
    const room = createRoom(makeProfile())
    expect(room.turnTaking.enabled).toBe(false)
    expect(room.turnTaking.paused).toBe(false)
    expect(room.turnTaking.participating.size).toBe(0)
    expect(room.turnTaking.currentTurn).toBeUndefined()
  })

  test('TT disabled: broadcasts to all members (unchanged behavior)', () => {
    const { delivered, deliverFn } = trackDeliveries()
    const room = createRoom(makeProfile(), deliverFn)

    room.addMember('a')
    room.addMember('b')
    room.addMember('c')

    room.post({ senderId: 'a', senderName: 'Alice', content: 'Hello', type: 'chat' })
    expect(delivered).toHaveLength(3) // broadcast to all
    expect(delivered.map(d => d.agentId).sort()).toEqual(['a', 'b', 'c'])
  })

  test('TT enabled: delivers only to stalest agent', () => {
    const { delivered, deliverFn } = trackDeliveries()
    const room = createRoom(makeProfile(), deliverFn)

    room.addMember('a')
    room.addMember('b')
    room.addMember('c')

    // Pre-TT messages to establish staleness: C spoke, then B, then A
    room.post({ senderId: 'c', senderName: 'Charlie', content: 'msg-c', type: 'chat' })
    room.post({ senderId: 'b', senderName: 'Bob', content: 'msg-b', type: 'chat' })
    room.post({ senderId: 'a', senderName: 'Alice', content: 'msg-a', type: 'chat' })
    delivered.length = 0

    // Enable TT with all three participating
    room.setParticipating('a', true)
    room.setParticipating('b', true)
    room.setParticipating('c', true)
    room.setTurnTaking(true)

    // setTurnTaking(true) kicks off chain — delivers to stalest (C)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.agentId).toBe('c')
    expect(room.turnTaking.currentTurn).toBe('c')
  })

  test('TT chain advances when currentTurn agent responds', () => {
    const { delivered, deliverFn } = trackDeliveries()
    const room = createRoom(makeProfile(), deliverFn)

    room.addMember('a')
    room.addMember('b')
    room.addMember('c')

    // Establish staleness: C, B, A
    room.post({ senderId: 'c', senderName: 'Charlie', content: 'c1', type: 'chat' })
    room.post({ senderId: 'b', senderName: 'Bob', content: 'b1', type: 'chat' })
    room.post({ senderId: 'a', senderName: 'Alice', content: 'a1', type: 'chat' })
    delivered.length = 0

    room.setParticipating('a', true)
    room.setParticipating('b', true)
    room.setParticipating('c', true)
    room.setTurnTaking(true)

    // C was delivered to (stalest). Clear and simulate C's response.
    delivered.length = 0
    room.post({ senderId: 'c', senderName: 'Charlie', content: 'c-response', type: 'chat' })

    // Should advance to next stalest: B (B's last msg is at index 1, A's at index 2)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.agentId).toBe('b')
    expect(room.turnTaking.currentTurn).toBe('b')

    // B responds — should advance to A
    delivered.length = 0
    room.post({ senderId: 'b', senderName: 'Bob', content: 'b-response', type: 'chat' })
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.agentId).toBe('a')
    expect(room.turnTaking.currentTurn).toBe('a')
  })

  test('pass messages advance the turn', () => {
    const { delivered, deliverFn } = trackDeliveries()
    const room = createRoom(makeProfile(), deliverFn)

    room.addMember('a')
    room.addMember('b')

    room.post({ senderId: 'b', senderName: 'Bob', content: 'b1', type: 'chat' })
    room.post({ senderId: 'a', senderName: 'Alice', content: 'a1', type: 'chat' })
    delivered.length = 0

    room.setParticipating('a', true)
    room.setParticipating('b', true)
    room.setTurnTaking(true)

    // B is stalest, gets delivery
    expect(delivered[0]!.agentId).toBe('b')
    delivered.length = 0

    // B passes — still advances to A
    room.post({ senderId: 'b', senderName: 'Bob', content: '[pass] nothing to add', type: 'pass' })
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.agentId).toBe('a')
  })

  test('pause stops the chain', () => {
    const { delivered, deliverFn } = trackDeliveries()
    const room = createRoom(makeProfile(), deliverFn)

    room.addMember('a')
    room.addMember('b')

    room.post({ senderId: 'a', senderName: 'Alice', content: 'a1', type: 'chat' })
    room.post({ senderId: 'b', senderName: 'Bob', content: 'b1', type: 'chat' })
    delivered.length = 0

    room.setParticipating('a', true)
    room.setParticipating('b', true)
    room.setTurnTaking(true)

    delivered.length = 0
    room.setTurnTakingPaused(true)
    expect(room.turnTaking.paused).toBe(true)
    expect(room.turnTaking.currentTurn).toBeUndefined()

    // Posting while paused — no TT delivery
    room.post({ senderId: 'a', senderName: 'Alice', content: 'during pause', type: 'chat' })
    // Message is stored but no TT delivery (falls through to broadcast since TT is paused)
    // Wait — actually when TT enabled + paused, post() checks `ttEnabled && !ttPaused`
    // Since ttPaused is true, it falls through to broadcast
  })

  test('resume restarts the chain from stalest', () => {
    const { delivered, deliverFn } = trackDeliveries()
    const room = createRoom(makeProfile(), deliverFn)

    room.addMember('a')
    room.addMember('b')

    room.post({ senderId: 'b', senderName: 'Bob', content: 'b1', type: 'chat' })
    room.post({ senderId: 'a', senderName: 'Alice', content: 'a1', type: 'chat' })
    delivered.length = 0

    room.setParticipating('a', true)
    room.setParticipating('b', true)
    room.setTurnTaking(true)

    // Chain started, pause it
    room.setTurnTakingPaused(true)
    delivered.length = 0

    // Resume
    room.setTurnTakingPaused(false)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.agentId).toBe('b') // B is stalest
  })

  test('participation toggle: excluded agent is skipped', () => {
    const { delivered, deliverFn } = trackDeliveries()
    const room = createRoom(makeProfile(), deliverFn)

    room.addMember('a')
    room.addMember('b')
    room.addMember('c')

    room.post({ senderId: 'c', senderName: 'Charlie', content: 'c1', type: 'chat' })
    room.post({ senderId: 'b', senderName: 'Bob', content: 'b1', type: 'chat' })
    room.post({ senderId: 'a', senderName: 'Alice', content: 'a1', type: 'chat' })
    delivered.length = 0

    // Only A and B participate — C is excluded
    room.setParticipating('a', true)
    room.setParticipating('b', true)
    room.setTurnTaking(true)

    // Stalest among {A, B} is B
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.agentId).toBe('b')
  })

  test('removing currentTurn agent advances the chain', () => {
    const { delivered, deliverFn } = trackDeliveries()
    const room = createRoom(makeProfile(), deliverFn)

    room.addMember('a')
    room.addMember('b')

    room.post({ senderId: 'b', senderName: 'Bob', content: 'b1', type: 'chat' })
    room.post({ senderId: 'a', senderName: 'Alice', content: 'a1', type: 'chat' })
    delivered.length = 0

    room.setParticipating('a', true)
    room.setParticipating('b', true)
    room.setTurnTaking(true)

    // B has the turn
    expect(room.turnTaking.currentTurn).toBe('b')
    delivered.length = 0

    // Remove B from participation
    room.setParticipating('b', false)

    // Should advance to A
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.agentId).toBe('a')
    expect(room.turnTaking.currentTurn).toBe('a')
  })

  test('onTurnChanged callback is called on turn changes', () => {
    const turns: Array<{ roomId: string; agentId?: string }> = []
    const onTurnChanged = (roomId: string, agentId?: string) => {
      turns.push({ roomId, agentId })
    }

    const { deliverFn } = trackDeliveries()
    const room = createRoom(makeProfile({ id: 'room-1' }), deliverFn, onTurnChanged)

    room.addMember('a')
    room.addMember('b')
    room.post({ senderId: 'a', senderName: 'Alice', content: 'a1', type: 'chat' })
    room.post({ senderId: 'b', senderName: 'Bob', content: 'b1', type: 'chat' })

    room.setParticipating('a', true)
    room.setParticipating('b', true)
    room.setTurnTaking(true)

    expect(turns.length).toBeGreaterThan(0)
    expect(turns[turns.length - 1]!.roomId).toBe('room-1')
  })

  test('messages from non-currentTurn are stored but not delivered in TT', () => {
    const { delivered, deliverFn } = trackDeliveries()
    const room = createRoom(makeProfile(), deliverFn)

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
    room.setTurnTaking(true)

    // C has the turn
    expect(room.turnTaking.currentTurn).toBe('c')
    delivered.length = 0

    // A posts something while C has the floor
    room.post({ senderId: 'a', senderName: 'Alice', content: 'interjection', type: 'chat' })

    // No delivery — A is not the currentTurn, and chain is not idle
    expect(delivered).toHaveLength(0)

    // But message is stored (3 initial + interjection = 4)
    expect(room.getMessageCount()).toBe(4)
  })
})

// ============================================================================
// Directed Addressing Tests
// ============================================================================

describe('Room — Directed Addressing [[AgentName]]', () => {
  const trackDeliveries = () => {
    const delivered: Array<{ agentId: string; content: string }> = []
    const deliverFn = (agentId: string, message: Message) => {
      delivered.push({ agentId, content: message.content })
    }
    return { delivered, deliverFn }
  }

  test('non-TT mode: [[AgentName]] delivers only to addressed agent', () => {
    const { delivered, deliverFn } = trackDeliveries()
    const room = createRoom(makeProfile(), deliverFn)

    room.addMember('a')
    room.addMember('b')
    room.addMember('c')

    // Post messages with senderName so names can be resolved
    room.post({ senderId: 'a', senderName: 'Alice', content: 'setup', type: 'chat' })
    room.post({ senderId: 'b', senderName: 'Bob', content: 'setup', type: 'chat' })
    room.post({ senderId: 'c', senderName: 'Charlie', content: 'setup', type: 'chat' })
    delivered.length = 0

    // Alice addresses Bob specifically
    room.post({ senderId: 'a', senderName: 'Alice', content: '[[Bob]] what do you think?', type: 'chat' })

    // Only Bob gets delivery (not Alice, not Charlie)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.agentId).toBe('b')
  })

  test('non-TT mode: [[AgentName]] with multiple targets', () => {
    const { delivered, deliverFn } = trackDeliveries()
    const room = createRoom(makeProfile(), deliverFn)

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

  test('non-TT mode: unresolvable [[Name]] falls through to broadcast', () => {
    const { delivered, deliverFn } = trackDeliveries()
    const room = createRoom(makeProfile(), deliverFn)

    room.addMember('a')
    room.addMember('b')

    room.post({ senderId: 'a', senderName: 'Alice', content: 'hi', type: 'chat' })
    delivered.length = 0

    // Address someone who doesn't exist — falls through to broadcast
    room.post({ senderId: 'a', senderName: 'Alice', content: '[[Nobody]] hello?', type: 'chat' })

    // Broadcasts to both members (a via post + addMember, b via addMember)
    expect(delivered).toHaveLength(2)
    expect(delivered.map(d => d.agentId).sort()).toEqual(['a', 'b'])
  })

  test('TT mode: [[AgentName]] overrides staleness', () => {
    const { delivered, deliverFn } = trackDeliveries()
    const room = createRoom(makeProfile(), deliverFn)

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
    room.setTurnTaking(true)

    // C has the turn (stalest). C addresses Bob directly instead of normal response.
    delivered.length = 0
    room.post({ senderId: 'c', senderName: 'Charlie', content: '[[Bob]] what do you think?', type: 'chat' })

    // Bob gets the delivery, not the normal staleness-based next agent
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.agentId).toBe('b')
    expect(room.turnTaking.currentTurn).toBe('b')
  })

  test('message with [[AgentName]] is always stored regardless of delivery', () => {
    const { deliverFn } = trackDeliveries()
    const room = createRoom(makeProfile(), deliverFn)

    room.addMember('a')
    room.addMember('b')

    room.post({ senderId: 'a', senderName: 'Alice', content: 'setup', type: 'chat' })
    room.post({ senderId: 'b', senderName: 'Bob', content: 'setup', type: 'chat' })
    const before = room.getMessageCount()

    room.post({ senderId: 'a', senderName: 'Alice', content: '[[Bob]] directed msg', type: 'chat' })
    expect(room.getMessageCount()).toBe(before + 1)
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
