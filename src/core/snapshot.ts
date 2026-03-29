// ============================================================================
// Snapshot — System state persistence via JSON.
//
// Pure serialization/deserialization. Reads system state via public getters,
// writes to disk atomically (tmp → rename). Restores by calling
// restoreRoom/injectMessages/restoreState/spawnAIAgent with preserved IDs.
//
// Auto-saver: debounced timer (5s default), flushes on SIGINT/SIGTERM.
// ============================================================================

import type {
  AIAgentConfig, DeliveryMode, Flow, Message, Room, RoomProfile, TodoItem,
} from './types.ts'
import { asAIAgent } from '../agents/shared.ts'
import { mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

// --- Version ---

export const SNAPSHOT_VERSION = 1

// --- Snapshot schema ---

export interface RoomSnapshot {
  readonly profile: RoomProfile
  readonly messages: ReadonlyArray<Message>
  readonly members: ReadonlyArray<string>
  readonly deliveryMode: DeliveryMode
  readonly paused: boolean
  readonly muted: ReadonlyArray<string>
  readonly flows: ReadonlyArray<Flow>
  readonly todos: ReadonlyArray<TodoItem>
}

export interface AgentSnapshot {
  readonly id: string
  readonly config: AIAgentConfig  // includes temperature, historyLimit, tools
  readonly roomIds: ReadonlyArray<string>
}

export interface SystemSnapshot {
  readonly version: '1'
  readonly timestamp: number
  readonly house: {
    readonly housePrompt: string
    readonly responseFormat: string
  }
  readonly rooms: ReadonlyArray<RoomSnapshot>
  readonly agents: ReadonlyArray<AgentSnapshot>
}

// --- Minimal System interface for serialization (avoid importing full System) ---

interface SerializableSystem {
  readonly house: {
    readonly listAllRooms: () => ReadonlyArray<RoomProfile>
    readonly getRoom: (idOrName: string) => Room | undefined
    readonly getRoomsForAgent: (agentId: string) => ReadonlyArray<Room>
    readonly getHousePrompt: () => string
    readonly getResponseFormat: () => string
  }
  readonly team: {
    readonly listAgents: () => ReadonlyArray<{ readonly id: string; readonly name: string; readonly kind: string }>
    readonly getAgent: (idOrName: string) => { readonly id: string; readonly kind: string } | undefined
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
      flows: room.getFlows(),
      todos: room.getTodos(),
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
      config: {
        name: aiAgent.name,
        model: aiAgent.getModel(),
        systemPrompt: aiAgent.getSystemPrompt(),
        temperature: aiAgent.getTemperature(),
        historyLimit: aiAgent.getHistoryLimit(),
        tools: aiAgent.getTools(),
      },
      roomIds: agentRooms.map(r => r.profile.id),
    })
  }

  return {
    version: '1',
    timestamp: Date.now(),
    house: {
      housePrompt: system.house.getHousePrompt(),
      responseFormat: system.house.getResponseFormat(),
    },
    rooms,
    agents,
  }
}

// --- Migration ---

const migrateSnapshot = (raw: Record<string, unknown>): SystemSnapshot => {
  // Version may be stored as string (legacy) or number; normalise to number
  const rawVersion = raw.version
  const version = typeof rawVersion === 'number'
    ? rawVersion
    : typeof rawVersion === 'string'
      ? parseInt(rawVersion, 10)
      : 0
  if (version > SNAPSHOT_VERSION) {
    throw new Error(
      `Snapshot version ${version} is newer than this build (supports up to v${SNAPSHOT_VERSION}). Please upgrade the application.`,
    )
  }
  // v0 → v1: version field was added; no structural changes needed
  // Future migrations: if (version < 2) { raw = migrateV1toV2(raw) }
  return raw as unknown as SystemSnapshot
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
    return migrateSnapshot(raw)
  } catch (err) {
    console.error('Failed to load snapshot:', err)
    return null
  }
}

// --- Restore ---

// Intermediate data shape used during room restore — maps snapshot fields to Room calls.
interface RoomRestoreData {
  readonly room: Room
  readonly members: ReadonlyArray<string>
  readonly muted: ReadonlyArray<string>
  readonly paused: boolean
  readonly flows: ReadonlyArray<Flow>
  readonly todos: ReadonlyArray<TodoItem>
}

interface RestorableSystem {
  readonly house: {
    readonly restoreRoom: (profile: RoomProfile) => Room
    readonly setHousePrompt: (prompt: string) => void
    readonly setResponseFormat: (format: string) => void
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

  // 2. Restore rooms
  // Flow mode is NOT restored — no active flow execution is persisted.
  // Rooms are always restored in broadcast mode (paused state is preserved).
  const roomMap = new Map<string, Room>()
  for (const roomSnap of snapshot.rooms) {
    const room = system.house.restoreRoom(roomSnap.profile)
    room.injectMessages(roomSnap.messages)
    const data: RoomRestoreData = {
      room,
      members: roomSnap.members,
      muted: roomSnap.muted,
      paused: roomSnap.paused,
      flows: roomSnap.flows,
      todos: roomSnap.todos ?? [],
    }
    data.room.restoreState({
      members: data.members,
      muted: data.muted,
      mode: 'broadcast',
      paused: data.paused,
      flows: data.flows,
      todos: data.todos,
    })
    roomMap.set(room.profile.id, room)
  }

  // 3. Restore AI agents (with preserved IDs, no auto-join)
  for (const agentSnap of snapshot.agents) {
    await system.spawnAIAgent(agentSnap.config, { overrideId: agentSnap.id })

    // 4. Silently add agent to their rooms (no join message); call join() for history summary
    const agent = system.team?.getAgent(agentSnap.id)
    for (const roomId of agentSnap.roomIds) {
      const room = roomMap.get(roomId)
      if (room) {
        room.addMember(agentSnap.id)
        if (agent) await agent.join(room)
      }
    }
  }

  // 5. Patch flow steps that are missing agentId (backward compat with old snapshots).
  // agentId was added after some flows were already saved — resolve by agent name.
  if (system.team) {
    const team = system.team
    for (const room of roomMap.values()) {
      for (const flow of room.getFlows()) {
        if (flow.steps.some(s => !s.agentId)) {
          room.removeFlow(flow.id)
          room.addFlow({
            name: flow.name,
            loop: flow.loop,
            steps: flow.steps.map(s => ({
              ...s,
              agentId: s.agentId || (team.getAgent(s.agentName)?.id ?? ''),
            })),
          })
        }
      }
    }
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
  let pendingSave = false  // tracks if a save was requested while one was in-flight

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
      // If more changes arrived while we were saving, schedule another pass
      if (pendingSave) {
        timer = setTimeout(doSave, debounceMs)
      }
    }
  }

  const scheduleSave = (): void => {
    if (saving) {
      // Save in-flight — mark dirty; doSave's finally block will reschedule
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
