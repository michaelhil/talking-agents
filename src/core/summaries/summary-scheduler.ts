// Per-room scheduler for summary + compression.
//
// Two independent schedules per room (summary has its own, compression has
// its own). Each is either time-based (`setInterval`) or message-count-based
// (triggers on room.onMessagePosted when enough have accumulated).
//
// Concurrency: each target (summary / compression) is single-flight per room.
// If a run is already in-flight and another trigger fires, it's dropped —
// the next natural trigger picks it up. Manual `triggerNow` drops if busy.

import type { Message } from '../types/messaging.ts'
import type { Room } from '../types/room.ts'
import type { SummaryConfig, SummaryFeatureConfig, CompressionFeatureConfig } from '../types/summary.ts'
import type { SummaryEngine } from './summary-engine.ts'
import { compressionDue } from './summary-engine.ts'

export type SummaryTarget = 'summary' | 'compression'

export interface TriggerOptions {
  readonly onDelta?: (delta: string) => void
  readonly abort?: AbortSignal
}

export interface SummaryScheduler {
  // Call on every posted message in any room.
  readonly onMessagePosted: (roomId: string, message: Message) => void
  // Call when a room's summaryConfig changes.
  readonly onConfigChanged: (roomId: string) => void
  // Call when a room is removed.
  readonly onRoomRemoved: (roomId: string) => void
  // Force a run (used by REST/WS regenerate). Returns the promise so callers
  // can await completion and surface errors.
  readonly triggerNow: (
    roomId: string,
    target: SummaryTarget | 'both',
    options?: TriggerOptions,
  ) => Promise<void>
  // Returns true while a target is running for the given room.
  readonly isRunning: (roomId: string, target: SummaryTarget) => boolean
  readonly dispose: () => void
}

interface RoomTrackers {
  // Messages posted since last summary / compression run (count-based trigger).
  sinceSummary: number
  sinceCompression: number
  summaryTimer?: ReturnType<typeof setInterval>
  compressionTimer?: ReturnType<typeof setInterval>
  summaryInFlight: boolean
  compressionInFlight: boolean
}

export interface SchedulerDeps {
  readonly engine: SummaryEngine
  readonly getRoom: (roomId: string) => Room | undefined
  // Fired on start/delta/end of a run so the UI layer can relay to clients.
  readonly onRunStarted?: (roomId: string, target: SummaryTarget) => void
  readonly onRunDelta?: (roomId: string, target: SummaryTarget, delta: string) => void
  readonly onRunCompleted?: (roomId: string, target: SummaryTarget, text: string) => void
  readonly onRunFailed?: (roomId: string, target: SummaryTarget, reason: string) => void
}

export const createSummaryScheduler = (deps: SchedulerDeps): SummaryScheduler => {
  const trackers = new Map<string, RoomTrackers>()

  const getTracker = (roomId: string): RoomTrackers => {
    let t = trackers.get(roomId)
    if (!t) {
      t = { sinceSummary: 0, sinceCompression: 0, summaryInFlight: false, compressionInFlight: false }
      trackers.set(roomId, t)
    }
    return t
  }

  const clearTimers = (t: RoomTrackers): void => {
    if (t.summaryTimer) { clearInterval(t.summaryTimer); t.summaryTimer = undefined }
    if (t.compressionTimer) { clearInterval(t.compressionTimer); t.compressionTimer = undefined }
  }

  const fanoutDelta = (roomId: string, target: SummaryTarget, userOnDelta?: (d: string) => void) => (delta: string) => {
    userOnDelta?.(delta)
    deps.onRunDelta?.(roomId, target, delta)
  }

  const runSummaryForRoom = async (roomId: string, options: TriggerOptions = {}): Promise<void> => {
    const room = deps.getRoom(roomId)
    if (!room) return
    const t = getTracker(roomId)
    if (t.summaryInFlight) return
    t.summaryInFlight = true
    t.sinceSummary = 0
    deps.onRunStarted?.(roomId, 'summary')
    try {
      const text = await deps.engine.runSummary(room, {
        onDelta: fanoutDelta(roomId, 'summary', options.onDelta),
        abort: options.abort,
      })
      deps.onRunCompleted?.(roomId, 'summary', text)
    } catch (err) {
      deps.onRunFailed?.(roomId, 'summary', err instanceof Error ? err.message : String(err))
    } finally {
      t.summaryInFlight = false
    }
  }

  const runCompressionForRoom = async (roomId: string, options: TriggerOptions = {}): Promise<void> => {
    const room = deps.getRoom(roomId)
    if (!room) return
    const t = getTracker(roomId)
    if (t.compressionInFlight) return
    t.compressionInFlight = true
    t.sinceCompression = 0
    deps.onRunStarted?.(roomId, 'compression')
    try {
      const result = await deps.engine.runCompression(room, {
        onDelta: fanoutDelta(roomId, 'compression', options.onDelta),
        abort: options.abort,
      })
      deps.onRunCompleted?.(roomId, 'compression', result?.text ?? '')
    } catch (err) {
      deps.onRunFailed?.(roomId, 'compression', err instanceof Error ? err.message : String(err))
    } finally {
      t.compressionInFlight = false
    }
  }

  const configureTimers = (roomId: string): void => {
    const room = deps.getRoom(roomId)
    if (!room) return
    const t = getTracker(roomId)
    clearTimers(t)

    const summary: SummaryFeatureConfig = room.summaryConfig.summary
    if (summary.enabled && summary.schedule.kind === 'time') {
      const ms = Math.max(5, summary.schedule.everySeconds) * 1000
      t.summaryTimer = setInterval(() => { void runSummaryForRoom(roomId) }, ms)
    }
    const compression: CompressionFeatureConfig = room.summaryConfig.compression
    if (compression.enabled && compression.schedule.kind === 'time') {
      const ms = Math.max(5, compression.schedule.everySeconds) * 1000
      t.compressionTimer = setInterval(() => {
        if (compressionDue(room)) void runCompressionForRoom(roomId)
      }, ms)
    }
  }

  const onConfigChanged = (roomId: string): void => {
    configureTimers(roomId)
  }

  const onMessagePosted = (roomId: string, message: Message): void => {
    if (message.type !== 'chat') return
    const room = deps.getRoom(roomId)
    if (!room) return
    const t = getTracker(roomId)

    const cfg: SummaryConfig = room.summaryConfig

    // Summary count trigger
    if (cfg.summary.enabled && cfg.summary.schedule.kind === 'messages') {
      t.sinceSummary += 1
      if (t.sinceSummary >= cfg.summary.schedule.everyMessages) {
        void runSummaryForRoom(roomId)
      }
    }

    // Compression count trigger: both the "N since last" gate AND the structural
    // "we have enough to compress" gate must be satisfied.
    if (cfg.compression.enabled && cfg.compression.schedule.kind === 'messages') {
      t.sinceCompression += 1
      if (t.sinceCompression >= cfg.compression.schedule.everyMessages && compressionDue(room)) {
        void runCompressionForRoom(roomId)
      }
    }
  }

  const triggerNow = async (
    roomId: string,
    target: SummaryTarget | 'both',
    options: TriggerOptions = {},
  ): Promise<void> => {
    if (target === 'both') {
      await Promise.all([
        runSummaryForRoom(roomId, options),
        runCompressionForRoom(roomId, options),
      ])
      return
    }
    if (target === 'summary') return runSummaryForRoom(roomId, options)
    return runCompressionForRoom(roomId, options)
  }

  const onRoomRemoved = (roomId: string): void => {
    const t = trackers.get(roomId)
    if (!t) return
    clearTimers(t)
    trackers.delete(roomId)
  }

  const dispose = (): void => {
    for (const t of trackers.values()) clearTimers(t)
    trackers.clear()
  }

  const isRunning = (roomId: string, target: SummaryTarget): boolean => {
    const t = trackers.get(roomId)
    if (!t) return false
    return target === 'summary' ? t.summaryInFlight : t.compressionInFlight
  }

  return { onMessagePosted, onConfigChanged, onRoomRemoved, triggerNow, isRunning, dispose }
}
