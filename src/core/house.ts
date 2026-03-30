// ============================================================================
// House — Room collection + Artifact system.
//
// Creates, stores, and retrieves rooms.
// Hosts the ArtifactStore and ArtifactTypeRegistry for the system.
//
// Names are unique (case-insensitive). createRoom throws on collision.
// createRoomSafe auto-renames on collision and returns CreateResult.
// ============================================================================

import type {
  Artifact,
  ArtifactStore,
  ArtifactTypeRegistry,
  CreateResult,
  House,
  HouseCallbacks,
  OnArtifactChanged,
  Room,
  RoomConfig,
  RoomProfile,
} from './types.ts'
import { createRoom, type RoomCallbacks } from './room.ts'
import { createArtifactStore } from './artifact-store.ts'
import { createArtifactTypeRegistry } from './artifact-type-registry.ts'
import { ensureUniqueName, validateName } from './names.ts'

const DEFAULT_HOUSE_PROMPT = `You are part of samsinn, a collaborative multi-agent system. Be respectful and constructive. When uncertain, say so rather than guessing. Prioritise responding to new messages and direct questions. Use ::PASS:: only when the conversation genuinely does not need your input.`

const DEFAULT_RESPONSE_FORMAT = `- By default, just write your message as natural text. Your response IS the message other participants will read.
- You may use Markdown formatting (headings, bold, lists, code blocks, etc.).
- To stay silent, start your response with exactly ::PASS:: followed by a brief reason.
  Example: ::PASS:: This question was already answered by someone else
- To direct a message to a specific agent, use [[AgentName]] in your response. The addressed agent(s) will respond next. Other agents will see your message as context later.
  Example: [[Analyst-1]] can you elaborate on that point?
  You can address multiple agents: [[Analyst-1]] [[Researcher-2]] compare notes.
- To address all agents with a given tag (role/capability), use [[tag:TagName]].
  Example: [[tag:Reviewer]] please review this before we proceed.
- Never wrap your response in JSON or data structures.`


export const createHouse = (callbacks: HouseCallbacks = {}): House => {
  const {
    deliver, resolveAgentName, resolveTag, onMessagePosted, onTurnChanged,
    onDeliveryModeChanged, onFlowEvent, onRoomCreated, onRoomDeleted,
  } = callbacks

  const rooms = new Map<string, Room>()
  const nameIndex = new Map<string, string>()  // lowercase name → room ID
  let housePrompt = DEFAULT_HOUSE_PROMPT
  let responseFormat = DEFAULT_RESPONSE_FORMAT

  // --- Artifact system ---

  const artifactTypeRegistry = createArtifactTypeRegistry()

  // Classify a raw artifact action into the event key used for postSystemMessageOn checks.
  // A plain update that also resolves is classified as 'resolved', not 'updated'.
  const classifyArtifactEvent = (
    action: 'added' | 'updated' | 'removed',
    artifact: Artifact,
  ): 'added' | 'updated' | 'removed' | 'resolved' => {
    if (action === 'updated' && artifact.resolvedAt !== undefined) return 'resolved'
    return action
  }

  // Wire onArtifactChanged to post system messages in scoped rooms on significant events.
  const artifactChangedHandler: OnArtifactChanged = (action, artifact) => {
    const typeDef = artifactTypeRegistry.get(artifact.type)
    const postOn = typeDef?.postSystemMessageOn ?? ['added', 'removed', 'resolved']
    const eventKey = classifyArtifactEvent(action, artifact)

    if ((postOn as ReadonlyArray<string>).includes(eventKey) && artifact.scope.length > 0) {
      let content: string
      if (eventKey === 'updated') {
        // Prefer type-specific message; fall back to generic
        const custom = typeDef?.formatUpdateMessage?.(artifact)
        content = custom ?? `${artifact.type} "${artifact.title}" was updated`
      } else {
        const verb = eventKey === 'added' ? 'created' : eventKey === 'removed' ? 'deleted' : 'resolved'
        content = `${artifact.type} "${artifact.title}" was ${verb}`
      }
      for (const roomId of artifact.scope) {
        const room = rooms.get(roomId)
        room?.post({ senderId: 'system', content, type: 'system' })
      }
    }
    callbacks.onArtifactChanged?.(action, artifact)
  }

  const artifactStore = createArtifactStore(artifactTypeRegistry, artifactChangedHandler)

  // --- Rooms ---

  const getExistingNames = (): ReadonlyArray<string> =>
    [...rooms.values()].map(r => r.profile.name)

  const isNameTaken = (name: string): boolean =>
    nameIndex.has(name.toLowerCase())

  const makeRoomCallbacks = (): RoomCallbacks => ({
    deliver, resolveAgentName, resolveTag, onMessagePosted, onTurnChanged, onDeliveryModeChanged, onFlowEvent,
  })

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

    restoreRoom: (existingProfile: RoomProfile): Room => {
      const room = createRoom(existingProfile, makeRoomCallbacks())
      rooms.set(existingProfile.id, room)
      nameIndex.set(existingProfile.name.toLowerCase(), existingProfile.id)
      return room
    },

    artifacts: artifactStore as ArtifactStore,
    artifactTypes: artifactTypeRegistry as ArtifactTypeRegistry,
  }
}
