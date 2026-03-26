// ============================================================================
// House — Room collection. Creates, stores, and retrieves rooms.
// Accepts an optional DeliverFn, forwarded to every Room for member delivery.
//
// Names are unique (case-insensitive). createRoom throws on collision.
// createRoomSafe auto-renames on collision and returns CreateResult.
// ============================================================================

import type { CreateResult, DeliverFn, House, OnDeliveryModeChanged, OnFlowEvent, OnMessagePosted, OnTurnChanged, Room, RoomConfig, RoomProfile } from './types.ts'
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

const DEFAULT_RESPONSE_FORMAT_TOOLS = `\n- To use a tool, write ONLY ::TOOL:: followed by the tool name on its own line. Do not write anything else — just the tool call. Add JSON arguments after the name if needed.
  Example: ::TOOL:: get_time
  Example: ::TOOL:: query_agent {"target": "Alice", "question": "status?"}
  You may call multiple tools, one ::TOOL:: per line. After tools run you will receive results and should then write a normal response.
- IMPORTANT: You do NOT have access to real-time information like the current time or date. When asked about these, you MUST use the appropriate tool. Never guess or make up values for information a tool can provide.`

export { DEFAULT_RESPONSE_FORMAT_TOOLS }

export const createHouse = (deliver?: DeliverFn, onMessagePosted?: OnMessagePosted, onTurnChanged?: OnTurnChanged, onDeliveryModeChanged?: OnDeliveryModeChanged, onFlowEvent?: OnFlowEvent): House => {
  const rooms = new Map<string, Room>()
  let housePrompt = DEFAULT_HOUSE_PROMPT
  let responseFormat = DEFAULT_RESPONSE_FORMAT

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
      roomPrompt: config.roomPrompt,
      visibility: config.visibility,
      createdBy: config.createdBy,
      createdAt: Date.now(),
    }
    const roomCallbacks: RoomCallbacks = { deliver, onMessagePosted, onTurnChanged, onDeliveryModeChanged, onFlowEvent }
    const room = createRoom(profile, roomCallbacks)
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
    getHousePrompt: () => housePrompt,
    setHousePrompt: (prompt: string) => { housePrompt = prompt },
    getResponseFormat: () => responseFormat,
    setResponseFormat: (format: string) => { responseFormat = format },
  }
}
