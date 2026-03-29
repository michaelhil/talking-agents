import { describe, test, expect } from 'bun:test'
import { createHouse } from './house.ts'

describe('House — room collection', () => {
  test('starts empty', () => {
    const house = createHouse()
    expect(house.listAllRooms()).toEqual([])
  })

  test('creates a room with auto-generated UUID', () => {
    const house = createHouse()
    const room = house.createRoom({
      name: 'General',
      createdBy: 'alice',
    })

    expect(room.profile.name).toBe('General')
    expect(room.profile.createdBy).toBe('alice')
    expect(room.profile.createdAt).toBeGreaterThan(0)
    expect(room.profile.id).toHaveLength(36) // UUID format

    const retrieved = house.getRoom(room.profile.id)
    expect(retrieved).toBe(room)
  })

  test('getRoom returns undefined for nonexistent room', () => {
    const house = createHouse()
    expect(house.getRoom('nope')).toBeUndefined()
  })

  test('findByName returns room (case-insensitive)', () => {
    const house = createHouse()
    const room = house.createRoom({ name: 'General', createdBy: 'alice' })

    expect(house.getRoom('General')).toBe(room)
    expect(house.getRoom('general')).toBe(room)
    expect(house.getRoom('GENERAL')).toBe(room)
    expect(house.getRoom('nonexistent')).toBeUndefined()
  })

  test('name uniqueness enforced (case-insensitive)', () => {
    const house = createHouse()
    house.createRoom({ name: 'General', createdBy: 'alice' })

    expect(() => {
      house.createRoom({ name: 'General', createdBy: 'bob' })
    }).toThrow('Room name "General" is already taken')

    expect(() => {
      house.createRoom({ name: 'general', createdBy: 'bob' })
    }).toThrow('Room name "general" is already taken')
  })

  test('createRoomSafe auto-renames on collision', () => {
    const house = createHouse()
    house.createRoom({ name: 'Planning', createdBy: 'alice' })

    const result = house.createRoomSafe({ name: 'Planning', createdBy: 'bob' })

    expect(result.requestedName).toBe('Planning')
    expect(result.assignedName).toBe('Planning-2')
    expect(result.value.profile.name).toBe('Planning-2')
  })

  test('createRoomSafe returns original name when no collision', () => {
    const house = createHouse()
    const result = house.createRoomSafe({ name: 'Unique', createdBy: 'alice' })

    expect(result.requestedName).toBe('Unique')
    expect(result.assignedName).toBe('Unique')
  })

  test('createRoomSafe increments suffix on multiple collisions', () => {
    const house = createHouse()
    house.createRoom({ name: 'Room', createdBy: 'a' })
    house.createRoomSafe({ name: 'Room', createdBy: 'b' }) // Room-2

    const result = house.createRoomSafe({ name: 'Room', createdBy: 'c' })
    expect(result.assignedName).toBe('Room-3')
  })

  test('listAllRooms returns all rooms', () => {
    const house = createHouse()
    house.createRoom({ name: 'A', createdBy: 'alice' })
    house.createRoom({ name: 'B', createdBy: 'alice' })

    expect(house.listAllRooms()).toHaveLength(2)
  })

  test('removeRoom deletes a room', () => {
    const house = createHouse()
    const room = house.createRoom({ name: 'Temp', createdBy: 'alice' })

    expect(house.removeRoom(room.profile.id)).toBe(true)
    expect(house.getRoom(room.profile.id)).toBeUndefined()
    expect(house.listAllRooms()).toHaveLength(0)
  })

  test('removeRoom returns false for nonexistent room', () => {
    const house = createHouse()
    expect(house.removeRoom('nope')).toBe(false)
  })

  test('any room can be removed (no protected rooms)', () => {
    const house = createHouse()
    const intro = house.createRoom({ name: 'Introductions', createdBy: 'system' })

    expect(house.removeRoom(intro.profile.id)).toBe(true)
    expect(house.getRoom(intro.profile.id)).toBeUndefined()
  })

  test('onRoomCreated fires when room is created (not restored)', () => {
    const created: string[] = []
    const house = createHouse({ onRoomCreated: (p) => created.push(p.name) })

    house.createRoom({ name: 'Alpha', createdBy: 'alice' })
    house.createRoomSafe({ name: 'Beta', createdBy: 'bob' })
    expect(created).toEqual(['Alpha', 'Beta'])
  })

  test('onRoomCreated does NOT fire for restoreRoom', () => {
    const created: string[] = []
    const house = createHouse({ onRoomCreated: (p) => created.push(p.name) })

    const room = house.createRoom({ name: 'Original', createdBy: 'alice' })
    created.length = 0  // reset

    house.restoreRoom(room.profile)
    expect(created).toHaveLength(0)
  })

  test('onRoomDeleted fires when room is removed', () => {
    const deleted: string[] = []
    const house = createHouse({ onRoomDeleted: (_id, name) => deleted.push(name) })

    const room = house.createRoom({ name: 'ToDelete', createdBy: 'alice' })
    house.removeRoom(room.profile.id)
    expect(deleted).toEqual(['ToDelete'])
  })

  test('preserves roomPrompt', () => {
    const house = createHouse()
    const room = house.createRoom({
      name: 'Focused',
      roomPrompt: 'Stay on topic about data pipelines',
      createdBy: 'alice',
    })

    expect(room.profile.roomPrompt).toBe('Stay on topic about data pipelines')
  })

  test('rooms created by house are functional (can post and query)', () => {
    const house = createHouse()
    const room = house.createRoom({ name: 'Active', createdBy: 'alice' })

    const message = room.post({ senderId: 'alice', content: 'Hello', type: 'chat' })
    expect(message.content).toBe('Hello')
    expect(message.roomId).toBe(room.profile.id)
    expect(room.getMessageCount()).toBe(1)
    expect(room.getRecent(10)).toHaveLength(1)
    expect(room.getParticipantIds()).toContain('alice')
  })

  test('removed room name can be reused', () => {
    const house = createHouse()
    const original = house.createRoom({ name: 'Reusable', createdBy: 'alice' })
    original.post({ senderId: 'alice', content: 'Old message', type: 'chat' })

    house.removeRoom(original.profile.id)
    const fresh = house.createRoom({ name: 'Reusable', createdBy: 'bob' })

    expect(fresh.profile.name).toBe('Reusable')
    expect(fresh.profile.createdBy).toBe('bob')
    expect(fresh.getMessageCount()).toBe(0)
  })

  test('rejects empty name', () => {
    const house = createHouse()
    expect(() => {
      house.createRoom({ name: '', createdBy: 'alice' })
    }).toThrow('Room name cannot be empty')
  })

  test('rejects whitespace-only name', () => {
    const house = createHouse()
    expect(() => {
      house.createRoom({ name: '   ', createdBy: 'alice' })
    }).toThrow('Room name cannot be empty')
  })

  test('rejects name with leading/trailing whitespace', () => {
    const house = createHouse()
    expect(() => {
      house.createRoom({ name: '  General  ', createdBy: 'alice' })
    }).toThrow('Room name cannot have leading or trailing whitespace')
  })

  test('rejects excessively long name', () => {
    const house = createHouse()
    expect(() => {
      house.createRoom({ name: 'A'.repeat(101), createdBy: 'alice' })
    }).toThrow('Room name cannot exceed 100 characters')
  })

  test('room tracks members via addMember/hasMember', () => {
    const house = createHouse()
    const room = house.createRoom({ name: 'Members Test', createdBy: 'alice' })

    expect(room.hasMember('bob')).toBe(false)
    room.addMember('bob')
    expect(room.hasMember('bob')).toBe(true)
    expect(room.getParticipantIds()).toContain('bob')
  })

  test('getRoomsForAgent returns rooms where agent is a member', () => {
    const house = createHouse()
    const room1 = house.createRoom({ name: 'A', createdBy: 'alice' })
    const room2 = house.createRoom({ name: 'B', createdBy: 'alice' })
    house.createRoom({ name: 'C', createdBy: 'alice' })

    room1.addMember('agent-1')
    room2.addMember('agent-1')

    const rooms = house.getRoomsForAgent('agent-1')
    expect(rooms).toHaveLength(2)
    expect(rooms.map(r => r.profile.name).sort()).toEqual(['A', 'B'])
  })

  test('getRoomsForAgent returns empty for unknown agent', () => {
    const house = createHouse()
    house.createRoom({ name: 'A', createdBy: 'alice' })
    expect(house.getRoomsForAgent('nobody')).toEqual([])
  })

  test('posting adds sender as member implicitly', () => {
    const house = createHouse()
    const room = house.createRoom({ name: 'Implicit', createdBy: 'alice' })

    expect(room.hasMember('alice')).toBe(false)
    room.post({ senderId: 'alice', content: 'Hi', type: 'chat' })
    expect(room.hasMember('alice')).toBe(true)
  })
})
