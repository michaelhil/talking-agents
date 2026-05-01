// ============================================================================
// Snapshot — System state persistence via JSON.
//
// Pure serialization/deserialization. Reads system state via public getters,
// writes to disk atomically (tmp → rename). Restores by calling
// restoreRoom/injectMessages/restoreState/spawnAIAgent with preserved IDs.
//
// Auto-saver: debounced timer (5s default), flushes on SIGINT/SIGTERM.
//
// v17: current. Adds per-agent `triggers` (scheduled prompts) on AIAgentConfig
// and HumanAgentSnapshot. Both AI and human agents support triggers. The
// scheduler runs server-side; persisted state is the trigger list +
// lastFiredAt timestamps so triggers resume across restart. Cascade-cleaned
// when the pinned room is deleted.
// v16: adds 'error' MessageType + errorCode/errorProvider on Message
// (distinct from 'pass' so LLM/transport failures don't masquerade as agent
// decisions) and `preferredModel` on AIAgentConfig (user intent, snapshot-stable;
// effective model resolved per call). Older versions are rejected at load —
// no migration ladder.
//      v14 adds RoomSnapshot.wikiBindings + AIAgentConfig.wikiBindings (per-room
//      and per-agent wiki bindings for the wiki-backed knowledge feature).
//      v13 removes the v1 script engine entirely (replaced by the v2 reactive
//      runner — see docs/scripts.md). v1 ScriptRun was never persisted, so
//      this is a clean drop with nothing to migrate.
//      v12 removed macros entirely. Dropped RoomSnapshot.selectedMacroId and
//      any persisted macro artifacts.
//      v11 added RoomSnapshot.summaryConfig + latestSummary. Also removed the
//      cap-based message pruning path, so compressedIds are only populated by
//      the summary-engine's replaceCompression() now.
// ============================================================================

import type { Agent, AIAgentConfig } from '../types/agent.ts'
import type { Artifact } from '../types/artifact.ts'
import type { DeliveryMode, Message, RoomProfile } from '../types/messaging.ts'
import type { Bookmark, Room } from '../types/room.ts'
import type { SummaryConfig } from '../types/summary.ts'
import type { Trigger } from '../triggers/types.ts'
import { asAIAgent } from '../../agents/shared.ts'
import { mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

// --- Version ---

export const SNAPSHOT_VERSION = 17

// --- Snapshot schema ---

export interface RoomSnapshot {
  readonly profile: RoomProfile
  readonly messages: ReadonlyArray<Message>
  readonly members: ReadonlyArray<string>
  readonly deliveryMode: DeliveryMode
  readonly paused: boolean
  readonly muted: ReadonlyArray<string>
  readonly compressedIds?: ReadonlyArray<string>
  readonly summaryConfig?: SummaryConfig
  readonly latestSummary?: string
  readonly wikiBindings?: ReadonlyArray<string>
}

export interface AgentSnapshot {
  readonly id: string
  readonly config: AIAgentConfig
  readonly roomIds: ReadonlyArray<string>
}

// Humans are now persistent across restarts. The legacy model (humans live
// only as long as a WS session is bound to them) is gone in v15.
export interface HumanAgentSnapshot {
  readonly id: string
  readonly name: string
  readonly roomIds: ReadonlyArray<string>
  readonly triggers?: ReadonlyArray<Trigger>
}

export interface SystemSnapshot {
  readonly version: '17'
  readonly timestamp: number
  readonly rooms: ReadonlyArray<RoomSnapshot>
  readonly agents: ReadonlyArray<AgentSnapshot>             // AI agents
  readonly humans: ReadonlyArray<HumanAgentSnapshot>        // human agents
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
      summaryConfig: room.summaryConfig,
      ...(state.latestSummary ? { latestSummary: state.latestSummary } : {}),
      ...(room.getWikiBindings().length > 0 ? { wikiBindings: [...room.getWikiBindings()] } : {}),
    })
  }

  const agents: AgentSnapshot[] = []
  const humans: HumanAgentSnapshot[] = []
  for (const agent of system.team.listAgents()) {
    const agentRooms = system.house.getRoomsForAgent(agent.id)
    if (agent.kind === 'ai') {
      const aiAgent = asAIAgent(agent)
      if (!aiAgent) continue
      agents.push({
        id: agent.id,
        config: aiAgent.getConfig(),
        roomIds: agentRooms.map(r => r.profile.id),
      })
    } else if (agent.kind === 'human') {
      const triggers = agent.getTriggers?.() ?? []
      humans.push({
        id: agent.id,
        name: agent.name,
        roomIds: agentRooms.map(r => r.profile.id),
        ...(triggers.length > 0 ? { triggers: [...triggers] } : {}),
      })
    }
  }

  // Include all artifacts (resolved and unresolved) for full state persistence
  const artifacts = system.house.artifacts.list({ includeResolved: true })

  return {
    version: '17',
    timestamp: Date.now(),
    rooms,
    agents,
    humans,
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

// No migration ladder — clean break per repo policy. Older snapshots are
// rejected by isValidSnapshot and the server starts fresh.

// --- Save / Load ---

// A snapshot is "skippable" iff persisting it adds no value the user would
// notice — i.e. truly empty (no rooms, no agents, no artifacts, no
// bookmarks). Used by createAutoSaver to skip persistence when seeding is
// disabled (SAMSINN_SEED_EXAMPLE=0) and nothing was created.
//
// Previously this also recognized "seed-only" snapshots (1 Cafe + 1 AI + 1
// Human + no chat) as skippable to avoid drive-by visitors leaving dirs on
// disk. That coupled the check to seed-example.ts and only compared agent
// NAMES — persona/model/triggers/tools edits without a chat message were
// silently dropped (it half-undid F1's "agent edits trigger save"). Dropped
// in favour of letting the janitor handle drive-by cleanup (instance-
// cleanup.ts: demote idle → trash after 48h, purge after 7d). The auth-
// gated prod deploy bounds drive-by traffic; one snapshot file is ~5–20KB.
export const isEmptySnapshot = (snap: SystemSnapshot): boolean => {
  if (snap.artifacts && snap.artifacts.length > 0) return false
  if (snap.bookmarks && snap.bookmarks.length > 0) return false
  return snap.rooms.length === 0 && snap.agents.length === 0
}

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
      // Louder than warn — this means user state from a previous version is
      // about to be invisible. Operator must decide whether to delete the
      // file (clean break) or downgrade. Bumping to error so it surfaces
      // in log scrapes and admin tooling.
      console.error(`Snapshot at "${path}" is incompatible (got v${raw.version}, expected v${SNAPSHOT_VERSION}). Ignoring — delete the snapshot file to reset.`)
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
    readonly artifactTypes?: {
      readonly get: (type: string) => { readonly validateBody?: (body: unknown) => boolean } | undefined
    }
    readonly restoreBookmarks: (entries: ReadonlyArray<Bookmark>) => void
  }
  readonly spawnAIAgent: (config: AIAgentConfig, options?: { overrideId?: string }) => Promise<unknown>
  readonly spawnHumanAgent?: (config: { name: string }, send: (msg: unknown) => void, options?: { overrideId?: string }) => Promise<unknown>
  readonly team?: {
    readonly getAgent: (idOrName: string) => {
      readonly id: string
      readonly join: (room: Room) => Promise<void>
      readonly addTrigger?: (trigger: Trigger) => void
    } | undefined
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
      mode: roomSnap.deliveryMode,
      paused: roomSnap.paused,
      compressedIds: roomSnap.compressedIds,
      ...(roomSnap.summaryConfig ? { summaryConfig: roomSnap.summaryConfig } : {}),
      ...(roomSnap.latestSummary ? { latestSummary: roomSnap.latestSummary } : {}),
      ...(roomSnap.wikiBindings ? { wikiBindings: roomSnap.wikiBindings } : {}),
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

  // 2b. Restore human agents (preserved IDs, no-op transport — clients
  // reattach via the per-instance broadcast, not per-agent transport).
  if (system.spawnHumanAgent) {
    for (const humanSnap of snapshot.humans ?? []) {
      await system.spawnHumanAgent(
        { name: humanSnap.name },
        () => { /* no-op default; UI doesn't bind transport in v15 */ },
        { overrideId: humanSnap.id },
      )
      const agent = system.team?.getAgent(humanSnap.id)
      for (const roomId of humanSnap.roomIds) {
        const room = roomMap.get(roomId)
        if (room) {
          room.addMember(humanSnap.id)
          if (agent) await agent.join(room)
        }
      }
      // Restore triggers (lastFiredAt persists; scheduler resumes naturally).
      if (humanSnap.triggers && agent?.addTrigger) {
        for (const t of humanSnap.triggers) agent.addTrigger(t)
      }
    }
  }

  // 4. Restore artifacts. Drop any whose body fails the type-defined
  // validateBody guard — a single corrupt entry shouldn't crash later
  // rendering or break the whole rehydrate.
  const incoming = snapshot.artifacts ?? []
  const types = system.house.artifactTypes
  const valid: Artifact[] = []
  for (const a of incoming) {
    const def = types?.get(a.type)
    if (def?.validateBody && !def.validateBody(a.body)) {
      console.error(`[snapshot] dropping artifact ${a.id} (${a.type}) "${a.title}": body failed validateBody`)
      continue
    }
    valid.push(a)
  }
  system.house.artifacts.restore(valid)

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

// Hard cap on save deferral: when continuous mutations keep pushing the
// debounce timer forward, force a save once the first deferred mutation has
// waited this long. Without this, a steady trickle of edits at <debounceMs
// intervals would never trigger a save until traffic stops.
const MAX_DEFER_MS = 30_000

// Backoff schedule for transient save failures. Mirrors the eviction-flush
// retry policy in system-registry.ts so the same disk-full / perm-flip
// scenario is handled identically by the background path. Total wait if all
// three retries are needed: ~80s before the next mutation re-arms the timer.
const SAVE_RETRY_BACKOFF_MS: ReadonlyArray<number> = [5_000, 15_000, 60_000]

export const createAutoSaver = (
  system: SerializableSystem,
  path: string,
  debounceMs: number = 5000,
): AutoSaver => {
  let timer: Timer | undefined
  let saving = false
  let pendingSave = false
  // Timestamp of the first scheduleSave() call in the current debounce
  // window. Cleared on save start; used by scheduleSave to enforce
  // MAX_DEFER_MS so a continuous trickle can't starve the saver.
  let firstDeferredAt: number | null = null

  const doSave = async (): Promise<void> => {
    saving = true
    pendingSave = false
    firstDeferredAt = null
    try {
      const snapshot = serializeSystem(system)
      // Skip persistence for instances with no real user activity. Prevents
      // cookieless drive-by visits and the seed-only state from leaving an
      // empty dir on disk. First user/AI message flips this and the dir is
      // created via saveSnapshot's mkdir(recursive).
      if (isEmptySnapshot(snapshot)) return
      // Bounded retry on transient errors (disk full, perm flip, etc.).
      // Same policy as eviction flush — see system-registry.ts:329.
      let lastErr: unknown = null
      for (let attempt = 0; attempt <= SAVE_RETRY_BACKOFF_MS.length; attempt++) {
        try {
          await saveSnapshot(snapshot, path)
          return
        } catch (err) {
          lastErr = err
          if (attempt < SAVE_RETRY_BACKOFF_MS.length) {
            const reason = err instanceof Error ? err.message : String(err)
            console.warn(`[snapshot] auto-save attempt ${attempt + 1} failed: ${reason} — retrying`)
            await new Promise(resolve => setTimeout(resolve, SAVE_RETRY_BACKOFF_MS[attempt]))
          }
        }
      }
      const reason = lastErr instanceof Error ? lastErr.message : String(lastErr)
      console.error(`[snapshot] auto-save exhausted retries; recent state will retry on next mutation: ${reason}`)
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
    const now = Date.now()
    if (firstDeferredAt === null) firstDeferredAt = now
    // If we've been deferring beyond MAX_DEFER_MS, fire on the next tick
    // regardless of debounce — break the starvation loop.
    const deferredFor = now - firstDeferredAt
    const delay = deferredFor >= MAX_DEFER_MS ? 0 : debounceMs
    if (timer) clearTimeout(timer)
    timer = setTimeout(doSave, delay)
  }

  const flush = async (): Promise<void> => {
    if (timer) clearTimeout(timer)
    timer = undefined
    pendingSave = false
    firstDeferredAt = null
    await doSave()
  }

  const dispose = (): void => {
    if (timer) clearTimeout(timer)
    timer = undefined
    pendingSave = false
    firstDeferredAt = null
  }

  return { scheduleSave, flush, dispose }
}
