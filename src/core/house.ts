// ============================================================================
// House — Room collection. Creates, stores, and retrieves rooms.
// Accepts an optional DeliverFn, forwarded to every Room for member delivery.
//
// Names are unique (case-insensitive). createRoom throws on collision.
// createRoomSafe auto-renames on collision and returns CreateResult.
// ============================================================================

import type { CreateResult, DeliverFn, House, Room, RoomConfig, RoomProfile } from './types.ts'
import { createRoom } from './room.ts'
import { ensureUniqueName, validateName } from './names.ts'

export const createHouse = (deliver?: DeliverFn): House => {
  const rooms = new Map<string, Room>()

  const getExistingNames = (): ReadonlyArray<string> =>
    [...rooms.values()].map(r => r.profile.name)

  const isNameTaken = (name: string): boolean =>
    getExistingNames().some(n => n.toLowerCase() === name.toLowerCase())

  // Internal: creates room without uniqueness check (caller guarantees).
  const storeRoom = (config: RoomConfig, name: string): Room => {
    validateName(name, 'Room')
    const id = crypto.randomUUID()
    const profile: RoomProfile = {
      id,
      name,
      description: config.description,
      roomPrompt: config.roomPrompt,
      visibility: config.visibility,
      createdBy: config.createdBy,
      createdAt: Date.now(),
    }
    const room = createRoom(profile, deliver)
    rooms.set(id, room)
    return room
  }

  const createRoomInHouse = (config: RoomConfig): Room => {
    if (isNameTaken(config.name)) {
      throw new Error(`Room name "${config.name}" is already taken`)
    }
    return storeRoom(config, config.name)
  }

  const createRoomSafe = (config: RoomConfig): CreateResult<Room> => {
    const assignedName = ensureUniqueName(config.name, getExistingNames())
    const room = storeRoom(config, assignedName)
    return { value: room, requestedName: config.name, assignedName }
  }

  const getRoom = (idOrName: string): Room | undefined => {
    const byId = rooms.get(idOrName)
    if (byId) return byId
    const lower = idOrName.toLowerCase()
    for (const room of rooms.values()) {
      if (room.profile.name.toLowerCase() === lower) return room
    }
    return undefined
  }

  const listPublicRooms = (): ReadonlyArray<RoomProfile> =>
    [...rooms.values()]
      .filter(r => r.profile.visibility === 'public')
      .map(r => r.profile)

  const listAllRooms = (): ReadonlyArray<RoomProfile> =>
    [...rooms.values()].map(r => r.profile)

  const getRoomsForAgent = (agentId: string): ReadonlyArray<Room> =>
    [...rooms.values()].filter(r => r.hasMember(agentId))

  const removeRoom = (id: string): boolean => rooms.delete(id)

  return {
    createRoom: createRoomInHouse,
    createRoomSafe,
    getRoom,
    getRoomsForAgent,
    listPublicRooms,
    listAllRooms,
    removeRoom,
  }
}
