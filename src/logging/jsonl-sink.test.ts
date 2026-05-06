import { describe, test, expect } from 'bun:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJsonlFileSink } from './jsonl-sink.ts'
import type { LogEvent } from './types.ts'

const mkEvent = (session: string, kind: string, i: number): LogEvent => ({
  ts: Date.now(),
  kind,
  session,
  payload: { seq: i },
})

describe('createJsonlFileSink — round-trip', () => {
  test('write → close flushes all queued events to a single file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'samsinn-sink-'))
    try {
      const sink = await createJsonlFileSink({ dir, sessionId: 'alpha' })
      for (let i = 0; i < 10; i++) sink.write(mkEvent('alpha', 'test.event', i))
      await sink.close()

      const raw = await readFile(join(dir, 'alpha.jsonl'), 'utf-8')
      const lines = raw.trim().split('\n')
      expect(lines).toHaveLength(10)
      const parsed = lines.map(l => JSON.parse(l))
      expect(parsed.map(p => p.payload.seq)).toEqual([0,1,2,3,4,5,6,7,8,9])
      expect(sink.stats().eventCount).toBe(10)
      expect(sink.stats().droppedCount).toBe(0)
    } finally {
      await rm(dir, { recursive: true })
    }
  })

  test('flush() persists without closing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'samsinn-sink-'))
    try {
      const sink = await createJsonlFileSink({ dir, sessionId: 'beta' })
      sink.write(mkEvent('beta', 'x', 0))
      await sink.flush()
      const raw = await readFile(join(dir, 'beta.jsonl'), 'utf-8')
      expect(raw.trim().split('\n')).toHaveLength(1)
      // Sink still usable
      sink.write(mkEvent('beta', 'x', 1))
      await sink.close()
      const after = await readFile(join(dir, 'beta.jsonl'), 'utf-8')
      expect(after.trim().split('\n')).toHaveLength(2)
    } finally {
      await rm(dir, { recursive: true })
    }
  })
})

describe('createJsonlFileSink — rotation', () => {
  test('2-file ring: rotates active to .1, caps at most two files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'samsinn-sink-'))
    try {
      // Tiny threshold + flush between batches forces multiple rotations.
      // The 2-file ring drops anything older than .1, so total events
      // recovered from disk is a recent suffix of the writes, not all 20.
      const sink = await createJsonlFileSink({ dir, sessionId: 'gamma', rotateAtBytes: 200 })
      for (let i = 0; i < 20; i++) {
        sink.write(mkEvent('gamma', 'test.event', i))
        if (i % 5 === 4) await sink.flush()
      }
      await sink.close()

      const files = (await readdir(dir)).filter(f => f.startsWith('gamma'))
      // Active file always present; rolled file present after first rotation.
      expect(files.includes('gamma.jsonl')).toBe(true)
      expect(files.includes('gamma.1.jsonl')).toBe(true)
      // No higher rotation indices accumulate.
      expect(files.every(f => f === 'gamma.jsonl' || f === 'gamma.1.jsonl')).toBe(true)

      // Recovered events are a non-empty recent subset.
      let total = 0
      for (const f of files) {
        const lines = (await readFile(join(dir, f), 'utf-8')).trim().split('\n').filter(Boolean)
        total += lines.length
      }
      expect(total).toBeGreaterThan(0)
      expect(total).toBeLessThanOrEqual(20)
    } finally {
      await rm(dir, { recursive: true })
    }
  })

  test('B1: rotates a pre-existing file even when the very first batch lands immediately', async () => {
    // Regression for B1 — previously seedBytes() was fire-and-forget.
    // If a write hit before seedBytes() resolved, currentFileBytes was 0
    // and the rotation check (`currentFileBytes > 0` short-circuit) was
    // skipped. The pre-existing file kept growing past the cap.
    //
    // Now that createJsonlFileSink awaits seedBytes(), the constructor
    // returns with currentFileBytes already populated. The first batch
    // sees the correct size and rotates if needed.
    const dir = await mkdtemp(join(tmpdir(), 'samsinn-sink-seed-'))
    try {
      const sessionId = 'seed-test'
      const activePath = join(dir, `${sessionId}.jsonl`)
      const rolledPath = join(dir, `${sessionId}.1.jsonl`)
      // Pre-create a file at 90% of the rotation threshold.
      const rotateAtBytes = 200
      await Bun.write(activePath, 'x'.repeat(180))

      const sink = await createJsonlFileSink({ dir, sessionId, rotateAtBytes })
      // First batch — large enough to trigger rotation given the seeded size.
      for (let i = 0; i < 5; i++) sink.write(mkEvent(sessionId, 'test.event', i))
      await sink.flush()
      await sink.close()

      // Rotation must have happened: rolled file exists with the original
      // 180-byte body. Active file contains ONLY the new events (no
      // pre-existing 180 bytes carried over).
      const rolledContent = await Bun.file(rolledPath).text()
      expect(rolledContent.length).toBe(180)
      const activeContent = await Bun.file(activePath).text()
      expect(activeContent.includes('x'.repeat(180))).toBe(false)
      expect(activeContent.split('\n').filter(Boolean).length).toBe(5)
    } finally {
      await rm(dir, { recursive: true })
    }
  })
})

describe('createJsonlFileSink — overflow handling', () => {
  test('queue overflow drops oldest + emits synthetic log.dropped', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'samsinn-sink-'))
    try {
      // Silence the loud stderr warning for this test; we still want to
      // exercise the code path.
      const origErr = console.error
      console.error = () => {}

      const sink = await createJsonlFileSink({
        dir, sessionId: 'delta',
        queueCap: 5,
        flushIntervalMs: 1_000_000,  // effectively never auto-flush — force queue buildup
      })
      for (let i = 0; i < 10; i++) sink.write(mkEvent('delta', 'x', i))

      expect(sink.stats().droppedCount).toBe(5)
      await sink.close()
      console.error = origErr

      const raw = await readFile(join(dir, 'delta.jsonl'), 'utf-8')
      const parsed = raw.trim().split('\n').map(l => JSON.parse(l))
      // First line must be the synthetic drop notice
      expect(parsed[0].kind).toBe('log.dropped')
      expect(parsed[0].payload.count).toBe(5)
      // Remaining 5 real events
      expect(parsed.slice(1).map(p => p.payload.seq)).toEqual([5, 6, 7, 8, 9])
    } finally {
      await rm(dir, { recursive: true })
    }
  })
})

describe('createJsonlFileSink — error containment', () => {
  test('unwritable dir → no throw; droppedCount reflects loss', async () => {
    const origErr = console.error
    const errMsgs: string[] = []
    console.error = (msg: unknown) => { errMsgs.push(String(msg)) }

    try {
      const sink = await createJsonlFileSink({
        dir: '/this/path/should/not/exist/samsinn-sink-test-xyz',
        sessionId: 'e1',
        flushIntervalMs: 1_000_000,
      })
      sink.write(mkEvent('e1', 'x', 0))
      await sink.flush()  // triggers the real write attempt
      expect(sink.stats().droppedCount).toBeGreaterThan(0)
      // Sink must still accept subsequent writes without throwing
      sink.write(mkEvent('e1', 'x', 1))
      await sink.close()
    } finally {
      console.error = origErr
    }
  })
})

describe('createJsonlFileSink — stats', () => {
  test('stats reports currentFile + bytes + counts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'samsinn-sink-'))
    try {
      const sink = await createJsonlFileSink({ dir, sessionId: 'stats1' })
      sink.write(mkEvent('stats1', 'x', 0))
      sink.write(mkEvent('stats1', 'x', 1))
      await sink.flush()
      const s = sink.stats()
      expect(s.eventCount).toBe(2)
      expect(s.currentFile).toContain('stats1.jsonl')
      expect(s.currentFileBytes).toBeGreaterThan(0)
      expect(s.queuedCount).toBe(0)
      await sink.close()
    } finally {
      await rm(dir, { recursive: true })
    }
  })
})
