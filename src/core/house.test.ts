import { describe, test, expect } from 'bun:test'
import { createHouse, initIntroductionsRoom } from './house.ts'
import { INTRODUCTIONS_ROOM_ID } from './types.ts'

describe('House — room collection', () => {
  test('starts empty', () => {
    const house = createHouse()
    expect(house.listAllRooms()).toEqual([])
    expect(house.listPublicRooms()).toEqual([])
  })

  test('creates a room and retrieves it', () => {
    const house = createHouse()
    const room = house.createRoom({
      name: 'General',
      visibility: 'public',
      createdBy: 'alice',
    })

    expect(room.profile.name).toBe('General')
    expect(room.profile.visibility).toBe('public')
    expect(room.profile.createdBy).toBe('alice')
    expect(room.profile.createdAt).toBeGreaterThan(0)

    const retrieved = house.getRoom(room.profile.id)
    expect(retrieved).toBe(room) // same reference
  })

  test('creates a room with fixed ID', () => {
    const house = createHouse()
    const room = house.createRoom({
      id: 'my-room',
      name: 'Fixed',
      visibility: 'public',
      createdBy: 'alice',
    })

    expect(room.profile.id).toBe('my-room')
    expect(house.getRoom('my-room')).toBe(room)
  })

  test('returns existing room if ID already exists', () => {
    const house = createHouse()
    const first = house.createRoom({ id: 'dup', name: 'First', visibility: 'public', createdBy: 'alice' })
    const second = house.createRoom({ id: 'dup', name: 'Second', visibility: 'public', createdBy: 'bob' })

    expect(second).toBe(first)
    expect(second.profile.name).toBe('First')
  })

  test('getRoom returns undefined for nonexistent room', () => {
    const house = createHouse()
    expect(house.getRoom('nope')).toBeUndefined()
  })

  test('listPublicRooms only returns public rooms', () => {
    const house = createHouse()
    house.createRoom({ name: 'Public', visibility: 'public', createdBy: 'alice' })
    house.createRoom({ name: 'Private', visibility: 'private', createdBy: 'alice' })

    const publicRooms = house.listPublicRooms()
    expect(publicRooms).toHaveLength(1)
    expect(publicRooms[0]!.name).toBe('Public')
  })

  test('listAllRooms returns all rooms', () => {
    const house = createHouse()
    house.createRoom({ name: 'A', visibility: 'public', createdBy: 'alice' })
    house.createRoom({ name: 'B', visibility: 'private', createdBy: 'alice' })

    expect(house.listAllRooms()).toHaveLength(2)
  })

  test('removeRoom deletes a room', () => {
    const house = createHouse()
    const room = house.createRoom({ name: 'Temp', visibility: 'public', createdBy: 'alice' })

    expect(house.removeRoom(room.profile.id)).toBe(true)
    expect(house.getRoom(room.profile.id)).toBeUndefined()
    expect(house.listAllRooms()).toHaveLength(0)
  })

  test('removeRoom returns false for nonexistent room', () => {
    const house = createHouse()
    expect(house.removeRoom('nope')).toBe(false)
  })

  test('removeRoom prevents deleting Introductions room', () => {
    const house = createHouse()
    initIntroductionsRoom(house)

    expect(house.removeRoom(INTRODUCTIONS_ROOM_ID)).toBe(false)
    expect(house.getRoom(INTRODUCTIONS_ROOM_ID)).toBeDefined()
  })

  test('preserves room description and roomPrompt', () => {
    const house = createHouse()
    const room = house.createRoom({
      name: 'Focused',
      description: 'A focused room',
      roomPrompt: 'Stay on topic about data pipelines',
      visibility: 'public',
      createdBy: 'alice',
    })

    expect(room.profile.description).toBe('A focused room')
    expect(room.profile.roomPrompt).toBe('Stay on topic about data pipelines')
  })

  test('rooms created by house are functional (can post and query)', () => {
    const house = createHouse()
    const room = house.createRoom({ name: 'Active', visibility: 'public', createdBy: 'alice' })

    const result = room.post({ senderId: 'alice', content: 'Hello', type: 'chat' })
    expect(result.message.content).toBe('Hello')
    expect(result.message.roomId).toBe(room.profile.id) // room stamps its own ID
    expect(room.getMessageCount()).toBe(1)
    expect(room.getRecent(10)).toHaveLength(1)
    expect(room.getParticipantIds()).toContain('alice')
  })

  test('remove then recreate with same ID produces a fresh room', () => {
    const house = createHouse()
    const original = house.createRoom({ id: 'reusable', name: 'Original', visibility: 'public', createdBy: 'alice' })
    original.post({ senderId: 'alice', content: 'Old message', type: 'chat' })

    house.removeRoom('reusable')
    const fresh = house.createRoom({ id: 'reusable', name: 'Fresh', visibility: 'public', createdBy: 'bob' })

    expect(fresh.profile.name).toBe('Fresh')
    expect(fresh.profile.createdBy).toBe('bob')
    expect(fresh.getMessageCount()).toBe(0) // no old messages
  })
})

describe('initIntroductionsRoom', () => {
  test('creates the Introductions room with correct config', () => {
    const house = createHouse()
    const intro = initIntroductionsRoom(house)

    expect(intro.profile.id).toBe(INTRODUCTIONS_ROOM_ID)
    expect(intro.profile.name).toBe('Introductions')
    expect(intro.profile.visibility).toBe('public')
    expect(intro.profile.createdBy).toBe('system')
  })

  test('is idempotent — calling twice returns the same room', () => {
    const house = createHouse()
    const first = initIntroductionsRoom(house)
    const second = initIntroductionsRoom(house)

    expect(second).toBe(first)
  })
})
