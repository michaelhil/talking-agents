// ============================================================================
// Snapshot — System state persistence via JSON.
//
// Pure serialization/deserialization. Reads system state via public getters,
// writes to disk atomically (tmp → rename). Restores by calling
// restoreRoom/injectMessages/restoreState/spawnAIAgent with preserved IDs.
//
// Auto-saver: debounced timer (5s default), flushes on SIGINT/SIGTERM.
//
// v8: current. Older versions are rejected at load — no migration ladder.
//     AIAgentConfig stores `persona` (renamed from systemPrompt); IncludePrompts
//     uses `persona` key (renamed from `agent`).
// ============================================================================

import type { Agent, AIAgentConfig } from './types/agent.ts'
import type { Artifact } from './types/artifact.ts'
import type { DeliveryMode, Message, RoomProfile } from './types/messaging.ts'
import type { Bookmark, Room } from './types/room.ts'
import { asAIAgent } from '../agents/shared.ts'
import { mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

// --- Version ---

export const SNAPSHOT_VERSION = 8

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
  readonly version: '8'
  readonly timestamp: number
  readonly rooms: ReadonlyArray<RoomSnapshot>
  readonly agents: ReadonlyArray<AgentSnapshot>
  readonly artifacts: ReadonlyArray<Artifact>
  readonly bookmarks?: ReadonlyArray<Bookmark>
  readonly ollamaUrls?: ReadonlyArray<string>
  readonly ollamaUrl?: string
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
    readonly listBookmarks: () => ReadonlyArray<Bookmark>
  }
  readonly team: {
    readonly listAgents: () => ReadonlyArray<Agent>
    readonly getAgent: (idOrName: string) => Agent | undefined
  }
  readonly ollamaUrls?: {
    readonly list: () => string[]
    readonly getCurrent: () => string
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
    version: '8',
    timestamp: Date.now(),
    rooms,
    agents,
    artifacts: [...artifacts],
    bookmarks: [...system.house.listBookmarks()],
    ...(system.ollamaUrls ? {
      ollamaUrls: system.ollamaUrls.list(),
      ollamaUrl: system.ollamaUrls.getCurrent(),
    } : {}),
  }
}

// --- Validation ---

const isValidSnapshot = (raw: Record<string, unknown>): boolean =>
  raw.version === String(SNAPSHOT_VERSION)

// No migration ladder — v8 is a clean break (persona rename). Older
// snapshots are rejected by isValidSnapshot and the server starts fresh.

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
    readonly restoreBookmarks: (entries: ReadonlyArray<Bookmark>) => void
  }
  readonly spawnAIAgent: (config: AIAgentConfig, options?: { overrideId?: string }) => Promise<unknown>
  readonly team?: {
    readonly getAgent: (idOrName: string) => { readonly id: string; readonly join: (room: Room) => Promise<void> } | undefined
  }
  readonly ollamaUrls?: {
    readonly add: (url: string) => void
    readonly setCurrent: (url: string) => void
  }
}

export const restoreFromSnapshot = async (
  system: RestorableSystem,
  snapshot: SystemSnapshot,
): Promise<void> => {
  // 1. Restore rooms (messages + membership + state)
  const roomMap = new Map<string, Room>()
  for (const roomSnap of snapshot.rooms) {
    const room = system.house.restoreRoom(roomSnap.profile)
    room.injectMessages(roomSnap.messages)
    room.restoreState({
      members: roomSnap.members,
      muted: roomSnap.muted,
      // Flow execution is never persisted; restore flow rooms as broadcast.
      // Manual mode is persisted — resumes the user's turn-taking session.
      mode: roomSnap.deliveryMode === 'manual' ? 'manual' : 'broadcast',
      paused: roomSnap.paused,
      compressedIds: roomSnap.compressedIds,
    })
    roomMap.set(room.profile.id, room)
  }

  // 2. Restore AI agents (with preserved IDs, no auto-join)
  for (const agentSnap of snapshot.agents) {
    await system.spawnAIAgent(agentSnap.config, { overrideId: agentSnap.id })

    // 3. Silently add agent to their rooms; call join() for history summary
    const agent = system.team?.getAgent(agentSnap.id)
    for (const roomId of agentSnap.roomIds) {
      const room = roomMap.get(roomId)
      if (room) {
        room.addMember(agentSnap.id)
        if (agent) await agent.join(room)
      }
    }
  }

  // 4. Restore artifacts
  system.house.artifacts.restore(snapshot.artifacts ?? [])

  // 4b. Restore bookmarks (system-wide)
  system.house.restoreBookmarks(snapshot.bookmarks ?? [])

  // 5. Restore Ollama URLs
  if (system.ollamaUrls && snapshot.ollamaUrls) {
    for (const url of snapshot.ollamaUrls) system.ollamaUrls.add(url)
    if (snapshot.ollamaUrl) system.ollamaUrls.setCurrent(snapshot.ollamaUrl)
  }
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
