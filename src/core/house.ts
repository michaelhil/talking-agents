// ============================================================================
// House — Room collection. Creates, stores, and retrieves rooms.
// Accepts an optional DeliverFn, forwarded to every Room for member delivery.
//
// Names are unique (case-insensitive). createRoom throws on collision.
// createRoomSafe auto-renames on collision and returns CreateResult.
// ============================================================================

import type { CreateResult, House, HouseCallbacks, Room, RoomConfig, RoomProfile } from './types.ts'
import { createRoom, type RoomCallbacks } from './room.ts'
import { ensureUniqueName, validateName } from './names.ts'

const DEFAULT_HOUSE_PROMPT = `You are part of samsinn, a collaborative multi-agent system. Be respectful and constructive. When uncertain, say so rather than guessing. Prioritise responding to new messages and direct questions. Use ::PASS:: only when the conversation genuinely does not need your input.`

const DEFAULT_RESPONSE_FORMAT = `- By default, just write your message as natural text. Your response IS the message other participants will read.
- You may use Markdown formatting (headings, bold, lists, code blocks, etc.).
- To stay silent, start your response with exactly ::PASS:: followed by a brief reason.
  Example: ::PASS:: This question was already answered by someone else
- To direct a message to a specific agent, use [[AgentName]] in your response. The addressed agent(s) will respond next. Other agents will see your message as context later.
  Example: [[Analyst-1]] can you elaborate on that point?
  You can address multiple agents: [[Analyst-1]] [[Researcher-2]] compare notes.
- Never wrap your response in JSON or data structures.`


export const createHouse = (callbacks: HouseCallbacks = {}): House => {
  const { deliver, resolveAgentName, onMessagePosted, onTurnChanged, onDeliveryModeChanged, onFlowEvent, onTodoChanged, onRoomCreated, onRoomDeleted } = callbacks
  const rooms = new Map<string, Room>()
  const nameIndex = new Map<string, string>()  // lowercase name → room ID
  let housePrompt = DEFAULT_HOUSE_PROMPT
  let responseFormat = DEFAULT_RESPONSE_FORMAT

  const getExistingNames = (): ReadonlyArray<string> =>
    [...rooms.values()].map(r => r.profile.name)

  const isNameTaken = (name: string): boolean =>
    nameIndex.has(name.toLowerCase())

  // Shared RoomCallbacks wiring — used by storeRoom and restoreRoom
  const makeRoomCallbacks = (): RoomCallbacks => ({
    deliver, resolveAgentName, onMessagePosted, onTurnChanged, onDeliveryModeChanged, onFlowEvent, onTodoChanged,
  })

  // Internal: creates room without uniqueness check (caller guarantees).
  const storeRoom = (config: RoomConfig, name: string): Room => {
    validateName(name, 'Room')
    const id = crypto.randomUUID()
    const profile: RoomProfile = {
      id,
      name,
      roomPrompt: config.roomPrompt,
      createdBy: config.createdBy,
      createdAt: Date.now(),
    }
    const room = createRoom(profile, makeRoomCallbacks())
    rooms.set(id, room)
    nameIndex.set(name.toLowerCase(), id)
    onRoomCreated?.(profile)
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
    // O(1) name lookup via index
    const idByName = nameIndex.get(idOrName.toLowerCase())
    return idByName ? rooms.get(idByName) : undefined
  }

  const listAllRooms = (): ReadonlyArray<RoomProfile> =>
    [...rooms.values()].map(r => r.profile)

  const getRoomsForAgent = (agentId: string): ReadonlyArray<Room> =>
    [...rooms.values()].filter(r => r.hasMember(agentId))

  const removeRoom = (id: string): boolean => {
    const room = rooms.get(id)
    if (!room) return false
    const { name } = room.profile
    nameIndex.delete(name.toLowerCase())
    rooms.delete(id)
    onRoomDeleted?.(id, name)
    return true
  }

  return {
    createRoom: createRoomInHouse,
    createRoomSafe,
    getRoom,
    getRoomsForAgent,
    listAllRooms,
    removeRoom,
    getHousePrompt: () => housePrompt,
    setHousePrompt: (prompt: string) => { housePrompt = prompt },
    getResponseFormat: () => responseFormat,
    setResponseFormat: (format: string) => { responseFormat = format },

    // Snapshot restore — create room with preserved profile (existing ID)
    restoreRoom: (existingProfile: RoomProfile): Room => {
      const room = createRoom(existingProfile, makeRoomCallbacks())
      rooms.set(existingProfile.id, room)
      nameIndex.set(existingProfile.name.toLowerCase(), existingProfile.id)
      return room
    },
  }
}
