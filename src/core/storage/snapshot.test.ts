import { describe, test, expect, afterEach } from 'bun:test'
import { serializeSystem, saveSnapshot, loadSnapshot, restoreFromSnapshot, appendPendingScrub, SNAPSHOT_VERSION, createAutoSaver } from './snapshot.ts'
import { stat } from 'node:fs/promises'
import { createHouse } from '../house.ts'
import { createTeam } from '../../agents/team.ts'
import type { DeliverFn } from '../types/messaging.ts'
import { unlink, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const TEST_SNAPSHOT_DIR = resolve(import.meta.dir, '../../data/test')
const TEST_SNAPSHOT_PATH = resolve(TEST_SNAPSHOT_DIR, 'test-snapshot.json')

// Minimal deliver function
const noopDeliver: DeliverFn = () => {}

// Helper: create a minimal system-like object with a default room
const createTestSystem = () => {
  const team = createTeam()
  const house = createHouse({ deliver: noopDeliver })
  // Create default room (main.ts does this in createSystem, but we're testing standalone)
  house.createRoom({ name: 'Introductions', createdBy: 'system' })
  return { house, team }
}

describe('Snapshot', () => {
  afterEach(async () => {
    try { await unlink(TEST_SNAPSHOT_PATH) } catch { /* ignore */ }
    try { await unlink(`${TEST_SNAPSHOT_PATH}.tmp`) } catch { /* ignore */ }
  })

  describe('old-version rejection', () => {
    test('rejects any non-current snapshot version', async () => {
      await mkdir(TEST_SNAPSHOT_DIR, { recursive: true })
      for (const v of ['3', '6', '7']) {
        const stale = { version: v, timestamp: Date.now(), rooms: [], agents: [] }
        await Bun.write(TEST_SNAPSHOT_PATH, JSON.stringify(stale))
        const loaded = await loadSnapshot(TEST_SNAPSHOT_PATH)
        expect(loaded).toBeNull()
      }
    })
  })

  describe('bookmarks round-trip', () => {
    test('serializes and restores bookmarks, newest-first', () => {
      const system = createTestSystem()
      const first = system.house.addBookmark('first message')
      const second = system.house.addBookmark('second message')

      const snapshot = serializeSystem(system)
      expect(snapshot.bookmarks?.length).toBe(2)
      // addBookmark prepends → second comes first in the list
      expect(snapshot.bookmarks?.[0]?.id).toBe(second.id)
      expect(snapshot.bookmarks?.[1]?.id).toBe(first.id)

      // Restore into a fresh house
      const fresh = createHouse({ deliver: noopDeliver })
      fresh.restoreBookmarks(snapshot.bookmarks ?? [])
      expect(fresh.listBookmarks().map(b => b.content)).toEqual(['second message', 'first message'])
    })

    test('update preserves position; delete removes', () => {
      const system = createTestSystem()
      const a = system.house.addBookmark('a')
      const b = system.house.addBookmark('b')
      const c = system.house.addBookmark('c')
      // Order after adds: [c, b, a]
      expect(system.house.listBookmarks().map(x => x.id)).toEqual([c.id, b.id, a.id])

      system.house.updateBookmark(b.id, 'B!')
      expect(system.house.listBookmarks().map(x => x.id)).toEqual([c.id, b.id, a.id])
      expect(system.house.listBookmarks().find(x => x.id === b.id)?.content).toBe('B!')

      expect(system.house.deleteBookmark(a.id)).toBe(true)
      expect(system.house.listBookmarks().map(x => x.id)).toEqual([c.id, b.id])
    })
  })

  describe('serializeSystem', () => {
    test('serializes empty system', () => {
      const system = createTestSystem()
      const snapshot = serializeSystem(system)

      expect(snapshot.version).toBe('23')
      expect(snapshot.timestamp).toBeGreaterThan(0)
      expect(snapshot.rooms.length).toBe(1) // default Introductions room
      expect(snapshot.agents.length).toBe(0)
    })

    test('serializes rooms with messages', () => {
      const system = createTestSystem()
      const room = system.house.getRoom('Introductions')!

      room.post({ senderId: 'agent-1', senderName: 'Alpha', content: 'Hello', type: 'chat' })
      room.post({ senderId: 'agent-2', senderName: 'Beta', content: 'Hi there', type: 'chat' })

      const snapshot = serializeSystem(system)
      const roomSnap = snapshot.rooms[0]!

      expect(roomSnap.messages.length).toBeGreaterThanOrEqual(2)
      const chatMsgs = roomSnap.messages.filter(m => m.type === 'chat')
      expect(chatMsgs.length).toBe(2)
      expect(chatMsgs[0]!.content).toBe('Hello')
      expect(chatMsgs[1]!.content).toBe('Hi there')
    })

    test('serializes room delivery state', () => {
      const system = createTestSystem()
      const room = system.house.getRoom('Introductions')!

      room.addMember('agent-1')
      room.setMuted('agent-1', true)

      const snapshot = serializeSystem(system)
      const roomSnap = snapshot.rooms[0]!

      expect(roomSnap.deliveryMode).toBe('broadcast')
      expect(roomSnap.muted).toContain('agent-1')
      expect(roomSnap.members).toContain('agent-1')
    })

  })

  describe('saveSnapshot / loadSnapshot', () => {
    test('round-trips through disk', async () => {
      const system = createTestSystem()
      const room = system.house.getRoom('Introductions')!
      room.post({ senderId: 'agent-1', senderName: 'Alpha', content: 'Persisted', type: 'chat' })

      const snapshot = serializeSystem(system)
      await saveSnapshot(snapshot, TEST_SNAPSHOT_PATH)

      const loaded = await loadSnapshot(TEST_SNAPSHOT_PATH)
      expect(loaded).not.toBeNull()
      expect(loaded!.version).toBe('23')
      expect(loaded!.rooms.length).toBe(snapshot.rooms.length)

      const chatMsgs = loaded!.rooms[0]!.messages.filter(m => m.type === 'chat')
      expect(chatMsgs.some(m => m.content === 'Persisted')).toBe(true)
    })

    test('returns null for missing file', async () => {
      const loaded = await loadSnapshot('/nonexistent/path.json')
      expect(loaded).toBeNull()
    })

    test('returns null for invalid version', async () => {
      await mkdir(TEST_SNAPSHOT_DIR, { recursive: true })
      await Bun.write(TEST_SNAPSHOT_PATH, JSON.stringify({ version: '999', timestamp: 0, house: {}, rooms: [], agents: [] }))
      const loaded = await loadSnapshot(TEST_SNAPSHOT_PATH)
      expect(loaded).toBeNull()
    })

    test('A3: empty-transition deletes the on-disk snapshot file', async () => {
      await mkdir(TEST_SNAPSHOT_DIR, { recursive: true })
      const system = createTestSystem()

      // First save: non-empty (default Introductions room exists). With a
      // bookmark added, isEmptySnapshot is false.
      system.house.addBookmark('keep me alive')
      const saver = createAutoSaver(system, TEST_SNAPSHOT_PATH, 0)
      await saver.flush()
      let exists = false
      try { await stat(TEST_SNAPSHOT_PATH); exists = true } catch { /* expected fail */ }
      expect(exists).toBe(true)

      // Now empty the system: remove default room + bookmarks. isEmptySnapshot
      // becomes true and the next save must rm the file.
      const room = system.house.getRoom('Introductions')!
      system.house.removeRoom(room.profile.id)
      // Manually clear bookmarks via the same path used in tests.
      system.house.restoreBookmarks([])
      await saver.flush()

      let stillExists = false
      try { await stat(TEST_SNAPSHOT_PATH); stillExists = true } catch { /* expected */ }
      expect(stillExists).toBe(false)
      saver.dispose()
    })

    test('A3: empty save when no file exists is a no-op (no error)', async () => {
      const system = createTestSystem()
      const room = system.house.getRoom('Introductions')!
      system.house.removeRoom(room.profile.id)
      // Empty system, no prior file. flush() should not throw.
      const saver = createAutoSaver(system, TEST_SNAPSHOT_PATH, 0)
      await saver.flush()
      saver.dispose()

      let exists = false
      try { await stat(TEST_SNAPSHOT_PATH); exists = true } catch { /* expected */ }
      expect(exists).toBe(false)
    })
  })

  describe('restoreFromSnapshot', () => {
    test('restores rooms with messages and state', async () => {
      // 1. Create original system and populate
      const original = createTestSystem()
      const origRoom = original.house.getRoom('Introductions')!
      origRoom.addMember('agent-1')
      origRoom.post({ senderId: 'agent-1', senderName: 'Alpha', content: 'Before restart', type: 'chat' })
      origRoom.setMuted('agent-1', true)

      // 2. Serialize
      const snapshot = serializeSystem(original)

      // 3. Create fresh system and restore
      const fresh = createTestSystem()
      // Remove the default intro room since restore will recreate it
      const defaultIntro = fresh.house.getRoom('Introductions')
      if (defaultIntro) fresh.house.removeRoom(defaultIntro.profile.id)

      // Minimal restorableSystem
      const restorableSystem = {
        house: fresh.house,
        spawnAIAgent: async () => {},
      }
      await restoreFromSnapshot(restorableSystem, snapshot)

      // 4. Verify
      const restoredRoom = fresh.house.getRoom('Introductions')
      expect(restoredRoom).toBeTruthy()

      const msgs = restoredRoom!.getRecent(100)
      const chatMsgs = msgs.filter(m => m.type === 'chat')
      expect(chatMsgs.some(m => m.content === 'Before restart')).toBe(true)

      expect(restoredRoom!.paused).toBe(false) // restores saved paused state (was false)
      expect(restoredRoom!.isMuted('agent-1')).toBe(true)
    })

    test('preserves room IDs', async () => {
      const original = createTestSystem()
      const origRoom = original.house.getRoom('Introductions')!
      const origRoomId = origRoom.profile.id

      const snapshot = serializeSystem(original)

      const fresh = createTestSystem()
      const defaultIntro = fresh.house.getRoom('Introductions')
      if (defaultIntro) fresh.house.removeRoom(defaultIntro.profile.id)

      await restoreFromSnapshot({ house: fresh.house, spawnAIAgent: async () => {} }, snapshot)

      const restoredRoom = fresh.house.getRoom(origRoomId)
      expect(restoredRoom).toBeTruthy()
      expect(restoredRoom!.profile.id).toBe(origRoomId)
    })

  })

  describe('pendingScrubs (M1: cross-instance pack uninstall)', () => {
    test('appendPendingScrub queues a namespace and dedupes repeats', async () => {
      await mkdir(TEST_SNAPSHOT_DIR, { recursive: true })
      const system = createTestSystem()
      const room = system.house.getRoom('Introductions')!
      room.setActivePacks(['aviation', 'cafes'])
      await saveSnapshot(serializeSystem(system), TEST_SNAPSHOT_PATH)

      const r1 = await appendPendingScrub(TEST_SNAPSHOT_PATH, { namespace: 'aviation', scheduledAt: '2026-05-06T00:00:00.000Z' })
      expect(r1.applied).toBe(true)

      // Repeat same namespace — must dedupe.
      const r2 = await appendPendingScrub(TEST_SNAPSHOT_PATH, { namespace: 'aviation', scheduledAt: '2026-05-06T00:01:00.000Z' })
      expect(r2.applied).toBe(false)
      expect(r2.reason).toBe('already queued')

      // Different namespace appends.
      const r3 = await appendPendingScrub(TEST_SNAPSHOT_PATH, { namespace: 'cafes', scheduledAt: '2026-05-06T00:02:00.000Z' })
      expect(r3.applied).toBe(true)

      const reloaded = await loadSnapshot(TEST_SNAPSHOT_PATH)
      expect(reloaded?.pendingScrubs?.length).toBe(2)
      expect(reloaded?.pendingScrubs?.map(p => p.namespace).sort()).toEqual(['aviation', 'cafes'])
    })

    test('appendPendingScrub refuses missing snapshot file', async () => {
      const result = await appendPendingScrub(TEST_SNAPSHOT_PATH, { namespace: 'x', scheduledAt: '2026-05-06T00:00:00.000Z' })
      expect(result.applied).toBe(false)
      expect(result.reason).toBe('no snapshot file')
    })

    test('appendPendingScrub refuses incompatible-version snapshot', async () => {
      await mkdir(TEST_SNAPSHOT_DIR, { recursive: true })
      await Bun.write(TEST_SNAPSHOT_PATH, JSON.stringify({ version: '7', timestamp: Date.now(), rooms: [], agents: [] }))
      const result = await appendPendingScrub(TEST_SNAPSHOT_PATH, { namespace: 'x', scheduledAt: '2026-05-06T00:00:00.000Z' })
      expect(result.applied).toBe(false)
      expect(result.reason).toContain('incompatible snapshot version')
    })

    test('restoreFromSnapshot drains pendingScrubs from room.activePacks', async () => {
      await mkdir(TEST_SNAPSHOT_DIR, { recursive: true })
      const system = createTestSystem()
      const room = system.house.getRoom('Introductions')!
      room.setActivePacks(['aviation', 'cafes', 'maritime'])
      await saveSnapshot(serializeSystem(system), TEST_SNAPSHOT_PATH)

      // Schedule scrubs for aviation and maritime — cafes should remain.
      await appendPendingScrub(TEST_SNAPSHOT_PATH, { namespace: 'aviation', scheduledAt: '2026-05-06T00:00:00.000Z' })
      await appendPendingScrub(TEST_SNAPSHOT_PATH, { namespace: 'maritime', scheduledAt: '2026-05-06T00:01:00.000Z' })

      const loaded = await loadSnapshot(TEST_SNAPSHOT_PATH)
      expect(loaded).not.toBeNull()

      const fresh = createTestSystem()
      const defaultIntro = fresh.house.getRoom('Introductions')
      if (defaultIntro) fresh.house.removeRoom(defaultIntro.profile.id)
      await restoreFromSnapshot({ house: fresh.house, spawnAIAgent: async () => {} }, loaded!)

      const restored = fresh.house.getRoom(room.profile.id)!
      expect(restored.getActivePacks()).toEqual(['cafes'])

      // Re-serialise and verify pendingScrubs is gone (serializeSystem
      // never writes the field; the next save naturally drops it).
      const reSerialised = serializeSystem(fresh)
      expect(reSerialised.pendingScrubs).toBeUndefined()
    })

    test('SNAPSHOT_VERSION is current', () => {
      expect(SNAPSHOT_VERSION).toBe(23)
    })
  })

  describe('A2: house-level state persistence (v21)', () => {
    test('default housePrompt + responseFormat are omitted from snapshot', () => {
      const system = createTestSystem()
      const snapshot = serializeSystem(system)
      expect(snapshot.housePrompt).toBeUndefined()
      expect(snapshot.responseFormat).toBeUndefined()
    })

    test('customised housePrompt round-trips through serialise + restore', async () => {
      const system = createTestSystem()
      system.house.setHousePrompt('CUSTOM HOUSE PROMPT')
      const snapshot = serializeSystem(system)
      expect(snapshot.housePrompt).toBe('CUSTOM HOUSE PROMPT')

      const fresh = createTestSystem()
      const defaultIntro = fresh.house.getRoom('Introductions')
      if (defaultIntro) fresh.house.removeRoom(defaultIntro.profile.id)
      await restoreFromSnapshot({ house: fresh.house, spawnAIAgent: async () => {} }, snapshot)
      expect(fresh.house.getHousePrompt()).toBe('CUSTOM HOUSE PROMPT')
    })

    test('customised responseFormat round-trips', async () => {
      const system = createTestSystem()
      system.house.setResponseFormat('-- pirate-style only --')
      const snapshot = serializeSystem(system)
      expect(snapshot.responseFormat).toBe('-- pirate-style only --')

      const fresh = createTestSystem()
      const defaultIntro = fresh.house.getRoom('Introductions')
      if (defaultIntro) fresh.house.removeRoom(defaultIntro.profile.id)
      await restoreFromSnapshot({ house: fresh.house, spawnAIAgent: async () => {} }, snapshot)
      expect(fresh.house.getResponseFormat()).toBe('-- pirate-style only --')
    })

    test('absent housePrompt in restored snapshot leaves the in-memory default', async () => {
      const fresh = createTestSystem()
      const defaultPrompt = fresh.house.getHousePrompt()
      const snapshotMissingHouse = { version: '23' as const, timestamp: 0, rooms: [], agents: [], humans: [] }
      await restoreFromSnapshot({ house: fresh.house, spawnAIAgent: async () => {} }, snapshotMissingHouse)
      expect(fresh.house.getHousePrompt()).toBe(defaultPrompt)
    })
  })

  describe('A4: concurrent writes are serialised — no JSON corruption', () => {
    test('25 concurrent appendPendingScrub calls all land', async () => {
      // Realistic scenario: cross-instance uninstall fires multiple
      // appendPendingScrubs against the same evicted-instance snapshot
      // file. Without the write chain, two concurrent read-modify-writes
      // can lose the earlier append.
      //
      // Note: saveSnapshot vs appendPendingScrub is NOT a relevant race
      // because saveSnapshot only runs for LIVE instances and
      // appendPendingScrub only runs for EVICTED ones — the registry
      // mutex guarantees the instance is in exactly one state.
      await mkdir(TEST_SNAPSHOT_DIR, { recursive: true })
      const system = createTestSystem()
      await saveSnapshot(serializeSystem(system), TEST_SNAPSHOT_PATH)

      const ops: Promise<unknown>[] = []
      for (let i = 0; i < 25; i++) {
        ops.push(appendPendingScrub(TEST_SNAPSHOT_PATH, {
          namespace: `ns-${i}`,
          scheduledAt: `2026-05-06T10:${String(i).padStart(2, '0')}:00.000Z`,
        }))
      }
      await Promise.all(ops)

      const loaded = await loadSnapshot(TEST_SNAPSHOT_PATH)
      expect(loaded).not.toBeNull()
      expect(loaded!.pendingScrubs?.length).toBe(25)
      const namespaces = new Set(loaded!.pendingScrubs!.map(p => p.namespace))
      expect(namespaces.size).toBe(25)
    })

    test('concurrent saveSnapshots against the same path produce a valid final file', async () => {
      // Live-instance debounced saves can fire close together (e.g. M5
      // flushNow racing with the auto-saver's pending timer). The chain
      // ensures the final file is whichever save was scheduled last,
      // never a half-written interleave.
      await mkdir(TEST_SNAPSHOT_DIR, { recursive: true })
      const system = createTestSystem()
      const room = system.house.getRoom('Introductions')!
      const ops: Promise<unknown>[] = []
      for (let i = 0; i < 20; i++) {
        room.post({ senderId: 'agent-1', senderName: 'A', content: `msg-${i}`, type: 'chat' })
        ops.push(saveSnapshot(serializeSystem(system), TEST_SNAPSHOT_PATH))
      }
      await Promise.all(ops)

      const loaded = await loadSnapshot(TEST_SNAPSHOT_PATH)
      expect(loaded).not.toBeNull()
      // Final state contains all 20 messages (last write wins; the chain
      // guarantees the last-submitted save is the last one to rename).
      const chatMsgs = loaded!.rooms[0]!.messages.filter(m => m.type === 'chat')
      expect(chatMsgs.length).toBe(20)
    })
  })
})
