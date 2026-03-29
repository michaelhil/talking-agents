// ============================================================================
// Snapshot — System state persistence via JSON.
//
// Pure serialization/deserialization. Reads system state via public getters,
// writes to disk atomically (tmp → rename). Restores by calling
// restoreRoom/injectMessages/restoreState/spawnAIAgent with preserved IDs.
//
// Auto-saver: debounced timer (5s default), flushes on SIGINT/SIGTERM.
//
// BREAKING CHANGE (v2): Todos and flow blueprints are no longer stored per-room.
// All artifacts (task lists, polls, flows) are stored at system level in
// SystemSnapshot.artifacts. Snapshots from v1 (or unversioned) are incompatible
// and must be deleted before upgrading.
// ============================================================================

import type {
  Agent, AIAgentConfig, Artifact, DeliveryMode, Flow, Message, Room, RoomProfile,
} from './types.ts'
import { asAIAgent } from '../agents/shared.ts'
import { mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

// --- Version ---

export const SNAPSHOT_VERSION = 2

// --- Snapshot schema ---

export interface RoomSnapshot {
  readonly profile: RoomProfile
  readonly messages: ReadonlyArray<Message>
  readonly members: ReadonlyArray<string>
  readonly deliveryMode: DeliveryMode
  readonly paused: boolean
  readonly muted: ReadonlyArray<string>
  readonly compressedIds?: ReadonlyArray<string>
}

export interface AgentSnapshot {
  readonly id: string
  readonly config: AIAgentConfig
  readonly roomIds: ReadonlyArray<string>
}

export interface SystemSnapshot {
  readonly version: '2'
  readonly timestamp: number
  readonly house: {
    readonly housePrompt: string
    readonly responseFormat: string
  }
  readonly rooms: ReadonlyArray<RoomSnapshot>
  readonly agents: ReadonlyArray<AgentSnapshot>
  readonly artifacts: ReadonlyArray<Artifact>
}

// --- Minimal System interface for serialization ---

interface SerializableSystem {
  readonly house: {
    readonly listAllRooms: () => ReadonlyArray<RoomProfile>
    readonly getRoom: (idOrName: string) => Room | undefined
    readonly getRoomsForAgent: (agentId: string) => ReadonlyArray<Room>
    readonly getHousePrompt: () => string
    readonly getResponseFormat: () => string
    readonly artifacts: {
      readonly list: (filter?: { includeResolved?: boolean }) => ReadonlyArray<Artifact>
    }
  }
  readonly team: {
    readonly listAgents: () => ReadonlyArray<Agent>
    readonly getAgent: (idOrName: string) => Agent | undefined
  }
}

// --- Serialize ---

export const serializeSystem = (system: SerializableSystem): SystemSnapshot => {
  const roomProfiles = system.house.listAllRooms()
  const rooms: RoomSnapshot[] = []

  for (const profile of roomProfiles) {
    const room = system.house.getRoom(profile.id)
    if (!room) continue

    const state = room.getRoomState()
    rooms.push({
      profile: room.profile,
      messages: room.getRecent(room.getMessageCount()),
      members: [...room.getParticipantIds()],
      deliveryMode: state.mode,
      paused: state.paused,
      muted: [...state.muted],
      compressedIds: room.getCompressedIds().size > 0 ? [...room.getCompressedIds()] : undefined,
    })
  }

  const agents: AgentSnapshot[] = []
  for (const agent of system.team.listAgents()) {
    if (agent.kind !== 'ai') continue
    const aiAgent = asAIAgent(agent)
    if (!aiAgent) continue
    const agentRooms = system.house.getRoomsForAgent(agent.id)
    agents.push({
      id: agent.id,
      config: aiAgent.getConfig(),
      roomIds: agentRooms.map(r => r.profile.id),
    })
  }

  // Include all artifacts (resolved and unresolved) for full state persistence
  const artifacts = system.house.artifacts.list({ includeResolved: true })

  return {
    version: '2',
    timestamp: Date.now(),
    house: {
      housePrompt: system.house.getHousePrompt(),
      responseFormat: system.house.getResponseFormat(),
    },
    rooms,
    agents,
    artifacts: [...artifacts],
  }
}

// --- Validation ---

const isValidSnapshot = (raw: Record<string, unknown>): boolean => {
  const rawVersion = raw.version
  const version = typeof rawVersion === 'string' ? parseInt(rawVersion, 10) : typeof rawVersion === 'number' ? rawVersion : 0
  return version === SNAPSHOT_VERSION
}

// --- Save / Load ---

export const saveSnapshot = async (snapshot: SystemSnapshot, path: string): Promise<void> => {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })
  const tmpPath = `${path}.tmp`
  await Bun.write(tmpPath, JSON.stringify(snapshot, null, 2))
  await rename(tmpPath, path)
}

export const loadSnapshot = async (path: string): Promise<SystemSnapshot | null> => {
  const file = Bun.file(path)
  if (!await file.exists()) return null

  try {
    const text = await file.text()
    const raw = JSON.parse(text) as Record<string, unknown>

    if (!isValidSnapshot(raw)) {
      console.warn(`Snapshot at "${path}" is incompatible (expected v${SNAPSHOT_VERSION}). Ignoring — delete the snapshot file to reset.`)
      return null
    }

    return raw as unknown as SystemSnapshot
  } catch (err) {
    console.error('Failed to load snapshot:', err)
    return null
  }
}

// --- Restore ---

interface RestorableSystem {
  readonly house: {
    readonly restoreRoom: (profile: RoomProfile) => Room
    readonly setHousePrompt: (prompt: string) => void
    readonly setResponseFormat: (format: string) => void
    readonly artifacts: {
      readonly restore: (artifacts: ReadonlyArray<Artifact>) => void
    }
  }
  readonly spawnAIAgent: (config: AIAgentConfig, options?: { overrideId?: string }) => Promise<unknown>
  readonly team?: {
    readonly getAgent: (idOrName: string) => { readonly id: string; readonly join: (room: Room) => Promise<void> } | undefined
  }
}

export const restoreFromSnapshot = async (
  system: RestorableSystem,
  snapshot: SystemSnapshot,
): Promise<void> => {
  // 1. Restore house prompts
  system.house.setHousePrompt(snapshot.house.housePrompt)
  system.house.setResponseFormat(snapshot.house.responseFormat)

  // 2. Restore rooms (messages + membership + state)
  const roomMap = new Map<string, Room>()
  for (const roomSnap of snapshot.rooms) {
    const room = system.house.restoreRoom(roomSnap.profile)
    room.injectMessages(roomSnap.messages)
    room.restoreState({
      members: roomSnap.members,
      muted: roomSnap.muted,
      mode: 'broadcast',  // Flow execution is never persisted
      paused: roomSnap.paused,
      compressedIds: roomSnap.compressedIds,
    })
    roomMap.set(room.profile.id, room)
  }

  // 3. Restore AI agents (with preserved IDs, no auto-join)
  for (const agentSnap of snapshot.agents) {
    await system.spawnAIAgent(agentSnap.config, { overrideId: agentSnap.id })

    // 4. Silently add agent to their rooms; call join() for history summary
    const agent = system.team?.getAgent(agentSnap.id)
    for (const roomId of agentSnap.roomIds) {
      const room = roomMap.get(roomId)
      if (room) {
        room.addMember(agentSnap.id)
        if (agent) await agent.join(room)
      }
    }
  }

  // 5. Restore artifacts (all types, system-level)
  system.house.artifacts.restore(snapshot.artifacts ?? [])
}

// --- Auto-saver ---

export interface AutoSaver {
  readonly scheduleSave: () => void
  readonly flush: () => Promise<void>
  readonly dispose: () => void
}

export const createAutoSaver = (
  system: SerializableSystem,
  path: string,
  debounceMs: number = 5000,
): AutoSaver => {
  let timer: Timer | undefined
  let saving = false
  let pendingSave = false

  const doSave = async (): Promise<void> => {
    saving = true
    pendingSave = false
    try {
      const snapshot = serializeSystem(system)
      await saveSnapshot(snapshot, path)
    } catch (err) {
      console.error('Auto-save failed:', err)
    } finally {
      saving = false
      if (pendingSave) {
        timer = setTimeout(doSave, debounceMs)
      }
    }
  }

  const scheduleSave = (): void => {
    if (saving) {
      pendingSave = true
      return
    }
    if (timer) clearTimeout(timer)
    timer = setTimeout(doSave, debounceMs)
  }

  const flush = async (): Promise<void> => {
    if (timer) clearTimeout(timer)
    timer = undefined
    pendingSave = false
    await doSave()
  }

  const dispose = (): void => {
    if (timer) clearTimeout(timer)
    timer = undefined
    pendingSave = false
  }

  return { scheduleSave, flush, dispose }
}
