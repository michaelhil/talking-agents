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
  AIAgentConfig, AIAgent, DeliveryMode, Flow, Message, Room, RoomProfile, TodoItem,
} from './types.ts'
import { mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

// --- Snapshot schema ---

export interface RoomSnapshot {
  readonly profile: RoomProfile
  readonly messages: ReadonlyArray<Message>
  readonly members: ReadonlyArray<string>
  readonly deliveryMode: DeliveryMode
  readonly muted: ReadonlyArray<string>
  readonly flows: ReadonlyArray<Flow>
  readonly todos: ReadonlyArray<TodoItem>
}

export interface AgentSnapshot {
  readonly id: string
  readonly config: AIAgentConfig
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
      muted: [...state.muted],
      flows: room.getFlows(),
      todos: room.getTodos(),
    })
  }

  const agents: AgentSnapshot[] = []
  for (const agent of system.team.listAgents()) {
    if (agent.kind !== 'ai') continue
    const aiAgent = agent as unknown as AIAgent
    const agentRooms = system.house.getRoomsForAgent(agent.id)
    agents.push({
      id: agent.id,
      config: {
        name: aiAgent.name,
        model: aiAgent.getModel(),
        systemPrompt: aiAgent.getSystemPrompt(),
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
    const data = await file.json() as SystemSnapshot
    if (data.version !== '1') {
      console.error(`Unsupported snapshot version: ${data.version}`)
      return null
    }
    return data
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
  }
  readonly spawnAIAgent: (config: AIAgentConfig, options?: { overrideId?: string; skipAutoJoin?: boolean }) => Promise<unknown>
}

export const restoreFromSnapshot = async (
  system: RestorableSystem,
  snapshot: SystemSnapshot,
): Promise<void> => {
  // 1. Restore house prompts
  system.house.setHousePrompt(snapshot.house.housePrompt)
  system.house.setResponseFormat(snapshot.house.responseFormat)

  // 2. Restore rooms
  const roomMap = new Map<string, Room>()
  for (const roomSnap of snapshot.rooms) {
    const room = system.house.restoreRoom(roomSnap.profile)
    room.injectMessages(roomSnap.messages)
    room.restoreState({
      members: roomSnap.members,
      muted: roomSnap.muted,
      mode: roomSnap.deliveryMode,
      paused: true,  // always start paused
      flows: roomSnap.flows,
      todos: roomSnap.todos ?? [],
    })
    roomMap.set(room.profile.id, room)
  }

  // 3. Restore AI agents (with preserved IDs, skip auto-join)
  for (const agentSnap of snapshot.agents) {
    await system.spawnAIAgent(agentSnap.config, {
      overrideId: agentSnap.id,
      skipAutoJoin: true,
    })

    // 4. Silently add agent to their rooms (no join message, no summary)
    for (const roomId of agentSnap.roomIds) {
      const room = roomMap.get(roomId)
      if (room) {
        room.addMember(agentSnap.id)
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

  const scheduleSave = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(async () => {
      if (saving) return
      saving = true
      try {
        const snapshot = serializeSystem(system)
        await saveSnapshot(snapshot, path)
      } catch (err) {
        console.error('Auto-save failed:', err)
      } finally {
        saving = false
      }
    }, debounceMs)
  }

  const flush = async (): Promise<void> => {
    if (timer) clearTimeout(timer)
    timer = undefined
    const snapshot = serializeSystem(system)
    await saveSnapshot(snapshot, path)
  }

  const dispose = (): void => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }

  return { scheduleSave, flush, dispose }
}
