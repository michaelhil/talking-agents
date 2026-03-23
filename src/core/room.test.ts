import { describe, test, expect } from 'bun:test'
import { createRoom } from './room.ts'
import type { RoomProfile } from './types.ts'
import { SYSTEM_SENDER_ID } from './types.ts'

const makeProfile = (overrides?: Partial<RoomProfile>): RoomProfile => ({
  id: 'test-room',
  name: 'Test Room',
  visibility: 'public',
  createdBy: 'creator-1',
  createdAt: Date.now(),
  ...overrides,
})

describe('Room — pure data structure', () => {
  test('starts with zero messages and no participants', () => {
    const room = createRoom(makeProfile())
    expect(room.getMessageCount()).toBe(0)
    expect(room.getParticipantIds()).toEqual([])
    expect(room.getRecent(10)).toEqual([])
  })

  test('post appends message with auto-generated id, timestamp, and roomId', () => {
    const room = createRoom(makeProfile({ id: 'my-room' }))
    const result = room.post({
      senderId: 'alice',
      content: 'Hello',
      type: 'chat',
    })

    expect(result.message.id).toBeTruthy()
    expect(result.message.timestamp).toBeGreaterThan(0)
    expect(result.message.roomId).toBe('my-room') // room stamps its own ID
    expect(result.message.content).toBe('Hello')
    expect(result.message.senderId).toBe('alice')
    expect(result.message.type).toBe('chat')
    expect(room.getMessageCount()).toBe(1)
  })

  test('post returns recipient IDs excluding the sender', () => {
    const room = createRoom(makeProfile())

    // Alice posts first — no recipients yet
    const r1 = room.post({ senderId: 'alice', content: 'Hi', type: 'chat' })
    expect(r1.recipientIds).toEqual([])

    // Bob posts — Alice is now a recipient
    const r2 = room.post({ senderId: 'bob', content: 'Hey', type: 'chat' })
    expect(r2.recipientIds).toContain('alice')
    expect(r2.recipientIds).not.toContain('bob')

    // Alice posts again — Bob is a recipient
    const r3 = room.post({ senderId: 'alice', content: 'Howdy', type: 'chat' })
    expect(r3.recipientIds).toContain('bob')
    expect(r3.recipientIds).not.toContain('alice')
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
    const result = room.post({
      senderId: 'bot-1',
      content: 'Analyzed data',
      type: 'chat',
      generationMs: 2400,
    })
    expect(result.message.generationMs).toBe(2400)
  })

  test('preserves metadata when provided', () => {
    const room = createRoom(makeProfile())
    const result = room.post({
      senderId: 'alice',
      content: 'With meta',
      type: 'chat',
      metadata: { source: 'test', priority: 1 },
    })
    expect(result.message.metadata).toEqual({ source: 'test', priority: 1 })
  })

  test('message IDs are unique (UUID-based)', () => {
    const room = createRoom(makeProfile())
    const ids = new Set<string>()

    for (let i = 0; i < 100; i++) {
      const result = room.post({ senderId: 'alice', content: `msg-${i}`, type: 'chat' })
      ids.add(result.message.id)
    }

    expect(ids.size).toBe(100)
  })

  test('message IDs are unique across different rooms', () => {
    const room1 = createRoom(makeProfile({ id: 'room-1' }))
    const room2 = createRoom(makeProfile({ id: 'room-2' }))
    const ids = new Set<string>()

    for (let i = 0; i < 50; i++) {
      ids.add(room1.post({ senderId: 'alice', content: `r1-${i}`, type: 'chat' }).message.id)
      ids.add(room2.post({ senderId: 'bob', content: `r2-${i}`, type: 'chat' }).message.id)
    }

    expect(ids.size).toBe(100)
  })

  test('room has no external dependencies — no delivery, no events', () => {
    const room = createRoom(makeProfile())
    room.post({ senderId: 'alice', content: 'Standalone', type: 'chat' })
    const msgs = room.getRecent(10)
    const participants = room.getParticipantIds()

    expect(msgs).toHaveLength(1)
    expect(participants).toEqual(['alice'])
  })
})
