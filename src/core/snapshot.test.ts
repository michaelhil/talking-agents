import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { serializeSystem, saveSnapshot, loadSnapshot, restoreFromSnapshot } from './snapshot.ts'
import type { SystemSnapshot } from './snapshot.ts'
import { createHouse } from './house.ts'
import { createTeam } from '../agents/team.ts'
import type { DeliverFn, Room, Message, RoomProfile } from './types.ts'
import { SYSTEM_SENDER_ID } from './types.ts'
import { unlink, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const TEST_SNAPSHOT_DIR = resolve(import.meta.dir, '../../data/test')
const TEST_SNAPSHOT_PATH = resolve(TEST_SNAPSHOT_DIR, 'test-snapshot.json')

// Minimal deliver function
const noopDeliver: DeliverFn = () => {}

// Helper: create a minimal system-like object with a default room
const createTestSystem = () => {
  const team = createTeam()
  const house = createHouse(noopDeliver)
  // Create default room (main.ts does this in createSystem, but we're testing standalone)
  house.createRoom({ name: 'Introductions', visibility: 'public', createdBy: 'system' })
  return { house, team }
}

describe('Snapshot', () => {
  afterEach(async () => {
    try { await unlink(TEST_SNAPSHOT_PATH) } catch { /* ignore */ }
    try { await unlink(`${TEST_SNAPSHOT_PATH}.tmp`) } catch { /* ignore */ }
  })

  describe('serializeSystem', () => {
    test('serializes empty system', () => {
      const system = createTestSystem()
      const snapshot = serializeSystem(system)

      expect(snapshot.version).toBe('1')
      expect(snapshot.timestamp).toBeGreaterThan(0)
      expect(snapshot.house.housePrompt).toBeTruthy()
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

    test('serializes flows', () => {
      const system = createTestSystem()
      const room = system.house.getRoom('Introductions')!

      room.addMember('agent-1')
      room.addMember('agent-2')
      room.addFlow({
        name: 'Test Flow',
        steps: [
          { agentId: 'agent-1', agentName: 'Alpha' },
          { agentId: 'agent-2', agentName: 'Beta', stepPrompt: 'Be concise' },
        ],
        loop: true,
      })

      const snapshot = serializeSystem(system)
      const roomSnap = snapshot.rooms[0]!

      expect(roomSnap.flows.length).toBe(1)
      expect(roomSnap.flows[0]!.name).toBe('Test Flow')
      expect(roomSnap.flows[0]!.steps.length).toBe(2)
      expect(roomSnap.flows[0]!.loop).toBe(true)
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
      expect(loaded!.version).toBe('1')
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

      expect(restoredRoom!.paused).toBe(true) // always starts paused
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

    test('restores flows', async () => {
      const original = createTestSystem()
      const origRoom = original.house.getRoom('Introductions')!
      origRoom.addMember('a1')
      origRoom.addFlow({
        name: 'Pipeline',
        steps: [{ agentId: 'a1', agentName: 'Alpha' }],
        loop: false,
      })

      const snapshot = serializeSystem(original)

      const fresh = createTestSystem()
      const defaultIntro = fresh.house.getRoom('Introductions')
      if (defaultIntro) fresh.house.removeRoom(defaultIntro.profile.id)

      await restoreFromSnapshot({ house: fresh.house, spawnAIAgent: async () => {} }, snapshot)

      const restoredRoom = fresh.house.getRoom('Introductions')!
      const flows = restoredRoom.getFlows()
      expect(flows.length).toBe(1)
      expect(flows[0]!.name).toBe('Pipeline')
    })

  })
})
