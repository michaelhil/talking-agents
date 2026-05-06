// ============================================================================
// JSONL file sink — append-only event stream for observational logging.
//
// Writes newline-delimited JSON to `<dir>/<sessionId>.jsonl`. When the active
// file passes `rotateAtBytes`, the next write opens `<sessionId>.1.jsonl`,
// then `<sessionId>.2.jsonl`, etc. Rotation is purely size-based; no
// time-based rotation (deployments handling that add their own post-process).
//
// Robustness:
// - write() is synchronous (queue-only); flushing happens off the event loop
// - queue cap = 10,000 events. On overflow, drop oldest with loud stderr
//   warning; when the sink next successfully writes, it emits a synthetic
//   `log.dropped` event so analysts see the gap in the stream.
// - Sink errors (EACCES, ENOSPC, etc.) → stderr, sink keeps running. A single
//   unrecoverable failure does not bring down samsinn.
// - close() drains the queue before returning.
// ============================================================================

import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { LogEvent, LogSink, LogSinkStats } from './types.ts'

export interface JsonlFileSinkOptions {
  readonly dir: string
  readonly sessionId: string
  readonly rotateAtBytes?: number   // default from SAMSINN_LOG_MAX_BYTES or 50 MB
  readonly flushIntervalMs?: number // default 1000
  readonly queueCap?: number        // default 10,000
}

// Per-file byte cap. Rotation maintains a 2-file ring: <base>.jsonl is
// the active file; on overflow it is renamed to <base>.1.jsonl (overwriting
// any prior .1) and a fresh <base>.jsonl is started. Per-instance footprint
// is therefore bounded at 2 × rotateAtBytes — important on multi-tenant
// deploys where N instances each have their own log directory.
const rotateBytesFromEnv = (): number => {
  const v = process.env.SAMSINN_LOG_MAX_BYTES
  if (!v) return 50 * 1024 * 1024
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 50 * 1024 * 1024
}
const DEFAULT_FLUSH_INTERVAL_MS = 1000
const DEFAULT_QUEUE_CAP = 10_000

export const createJsonlFileSink = async (options: JsonlFileSinkOptions): Promise<LogSink> => {
  const rotateAtBytes = options.rotateAtBytes ?? rotateBytesFromEnv()
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
  const queueCap = options.queueCap ?? DEFAULT_QUEUE_CAP

  // Queue of serialized JSONL lines. Held in-memory between flushes.
  let queue: string[] = []
  let eventCount = 0
  let droppedCount = 0
  let pendingDropNotice = 0  // drops since last successful write — emitted as synthetic log.dropped

  // Rotation state. currentFilePath is always <base>.jsonl (the active file).
  // On rotation it's renamed to <base>.1.jsonl (overwriting any prior .1).
  let currentFileBytes = 0
  let closed = false

  const currentFilePath = join(options.dir, `${options.sessionId}.jsonl`)
  const rolledFilePath = join(options.dir, `${options.sessionId}.1.jsonl`)

  // On construction, seed currentFileBytes from any existing file so we
  // don't over-append past rotation. Awaited (B1): the previous fire-and-
  // forget version meant the first batch could land before currentFileBytes
  // was populated, skipping the rotation check (`currentFileBytes > 0`
  // short-circuits) and growing the file past the cap.
  try {
    const s = await stat(currentFilePath)
    currentFileBytes = s.size
  } catch { /* no pre-existing file — fine */ }

  // Ensure dir exists before the first write. Cached to avoid per-flush mkdir.
  let dirEnsured = false
  const ensureDir = async (): Promise<void> => {
    if (dirEnsured) return
    await mkdir(dirname(currentFilePath), { recursive: true })
    dirEnsured = true
  }

  const serialize = (event: LogEvent): string => {
    // JSON.stringify can throw on circular refs — extremely unlikely for our
    // event shapes, but defend anyway so a bad payload can't take down the flush loop.
    try {
      return JSON.stringify(event) + '\n'
    } catch (err) {
      return JSON.stringify({
        ts: event.ts,
        kind: 'log.serialize_failed',
        session: event.session,
        payload: { originalKind: event.kind, error: err instanceof Error ? err.message : String(err) },
      }) + '\n'
    }
  }

  const flushNow = async (): Promise<void> => {
    if (queue.length === 0) return

    // Snapshot the queue and prepend synthetic drop-notice if needed.
    const pending: string[] = []
    const emittingDropNotice = pendingDropNotice > 0
    if (emittingDropNotice) {
      const notice: LogEvent = {
        ts: Date.now(),
        kind: 'log.dropped',
        session: options.sessionId,
        payload: { count: pendingDropNotice, reason: 'queue overflow' },
      }
      pending.push(serialize(notice))
      pendingDropNotice = 0
    }
    pending.push(...queue)
    queue = []

    const batch = pending.join('')
    const batchBytes = Buffer.byteLength(batch, 'utf-8')

    try {
      await ensureDir()

      // Rotate first if this batch would push past the threshold.
      // 2-file ring: rm any prior .1, mv current → .1, start fresh active.
      if (currentFileBytes > 0 && currentFileBytes + batchBytes > rotateAtBytes) {
        try { await rm(rolledFilePath, { force: true }) } catch { /* missing is fine */ }
        try { await rename(currentFilePath, rolledFilePath) } catch { /* if missing, fall through */ }
        currentFileBytes = 0
      }

      await appendFile(currentFilePath, batch, 'utf-8')
      currentFileBytes += batchBytes
      // Real events written = pending.length minus the synthetic notice (if any).
      eventCount += pending.length - (emittingDropNotice ? 1 : 0)
    } catch (err) {
      // mkdir failure, disk full, permission denied, etc. Log once; drop this
      // batch so we don't loop forever on a broken disk. Queue is already cleared.
      droppedCount += pending.length
      pendingDropNotice += pending.length
      console.error(`[logging] sink write failed for ${currentFilePath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Background flush loop. setInterval returns a Timer; unref() so it doesn't
  // block process exit if close() hasn't been called.
  const timer = setInterval(() => {
    void flushNow().catch(err => {
      console.error(`[logging] flush loop error: ${err instanceof Error ? err.message : String(err)}`)
    })
  }, flushIntervalMs)
  timer.unref?.()

  return {
    write: (event: LogEvent): void => {
      if (closed) return
      if (queue.length >= queueCap) {
        // Drop the oldest event, increment counters, emit stderr warning once
        // per overflow batch (every 100th drop suffices — we still surface count).
        queue.shift()
        droppedCount++
        pendingDropNotice++
        if (droppedCount === 1 || droppedCount % 100 === 0) {
          console.error(`[logging] queue overflow, dropping oldest (total dropped: ${droppedCount})`)
        }
      }
      queue.push(serialize(event))
    },
    flush: async (): Promise<void> => {
      await flushNow()
    },
    close: async (): Promise<void> => {
      if (closed) return
      closed = true
      clearInterval(timer)
      await flushNow()
    },
    stats: (): LogSinkStats => ({
      eventCount,
      droppedCount,
      queuedCount: queue.length,
      currentFile: currentFilePath,
      currentFileBytes,
    }),
  }
}
