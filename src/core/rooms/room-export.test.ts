// ============================================================================
// Room export helper — structure + pass-through tests.
// ============================================================================

import { describe, test, expect } from 'bun:test'
import { createRoom } from './room.ts'
import { exportRoomConversation } from './room-export.ts'

const makeRoom = (name: string) =>
  createRoom({ id: `room-${name}`, name, createdAt: Date.now(), createdBy: 'test' })

describe('exportRoomConversation', () => {
  test('empty room exports zero messages with correct shape', () => {
    const room = makeRoom('alpha')
    const result = exportRoomConversation(room)
    expect(result.roomId).toBe('room-alpha')
    expect(result.roomName).toBe('alpha')
    expect(result.messageCount).toBe(0)
    expect(result.messages).toEqual([])
    expect(typeof result.exportedAt).toBe('number')
  })

  test('populated room exports every message with telemetry', () => {
    const room = makeRoom('bravo')
    room.post({
      senderId: 'agent-1',
      senderName: 'Alice',
      content: 'hello',
      type: 'chat',
      promptTokens: 12,
      completionTokens: 5,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
    })
    room.post({
      senderId: 'user',
      senderName: 'User',
      content: 'hi back',
      type: 'chat',
    })

    const result = exportRoomConversation(room)
    expect(result.messageCount).toBe(2)
    expect(result.messages).toHaveLength(2)
    // Telemetry pass-through: fields Messages already carry must be present
    const first = result.messages[0]!
    expect(first.senderName).toBe('Alice')
    expect(first.promptTokens).toBe(12)
    expect(first.completionTokens).toBe(5)
    expect(first.provider).toBe('anthropic')
    expect(first.model).toBe('claude-haiku-4-5')
    // Messages without telemetry still export cleanly
    expect(result.messages[1]!.content).toBe('hi back')
  })

  test('messages are returned in room order (oldest first)', () => {
    const room = makeRoom('charlie')
    for (let i = 0; i < 5; i++) {
      room.post({ senderId: 'u', senderName: 'U', content: `m${i}`, type: 'chat' })
    }
    const result = exportRoomConversation(room)
    expect(result.messages.map(m => m.content)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4'])
  })
})
