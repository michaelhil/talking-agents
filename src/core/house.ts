// ============================================================================
// House — Room collection. Creates, stores, and retrieves rooms.
// No delivery logic. No participant awareness. Just rooms.
// ============================================================================

import type { House, Room, RoomConfig, RoomProfile } from './types.ts'
import { INTRODUCTIONS_ROOM_ID, SYSTEM_SENDER_ID } from './types.ts'
import { createRoom } from './room.ts'

export const createHouse = (): House => {
  const rooms = new Map<string, Room>()

  const createRoomInHouse = (config: RoomConfig): Room => {
    const id = config.id ?? crypto.randomUUID()

    const existing = rooms.get(id)
    if (existing) return existing

    const profile: RoomProfile = {
      id,
      name: config.name,
      description: config.description,
      roomPrompt: config.roomPrompt,
      visibility: config.visibility,
      createdBy: config.createdBy,
      createdAt: Date.now(),
    }

    const room = createRoom(profile)
    rooms.set(id, room)
    return room
  }

  const getRoom = (id: string): Room | undefined => rooms.get(id)

  const listPublicRooms = (): ReadonlyArray<RoomProfile> =>
    [...rooms.values()]
      .filter(r => r.profile.visibility === 'public')
      .map(r => r.profile)

  const listAllRooms = (): ReadonlyArray<RoomProfile> =>
    [...rooms.values()].map(r => r.profile)

  const removeRoom = (id: string): boolean => {
    if (id === INTRODUCTIONS_ROOM_ID) return false
    return rooms.delete(id)
  }

  return {
    createRoom: createRoomInHouse,
    getRoom,
    listPublicRooms,
    listAllRooms,
    removeRoom,
  }
}

export const initIntroductionsRoom = (house: House): Room =>
  house.createRoom({
    id: INTRODUCTIONS_ROOM_ID,
    name: 'Introductions',
    description: 'All participants introduce themselves here',
    visibility: 'public',
    createdBy: SYSTEM_SENDER_ID,
  })
