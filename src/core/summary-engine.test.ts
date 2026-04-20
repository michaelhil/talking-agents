import { describe, test, expect } from 'bun:test'
import { createRoom } from './room.ts'
import type { ChatRequest, LLMProvider, StreamChunk } from './types/llm.ts'
import type { RoomProfile } from './types/messaging.ts'
import { DEFAULT_SUMMARY_CONFIG } from './types/summary.ts'
import { compressionDue, createSummaryEngine, pickCompressionCandidates } from './summary-engine.ts'

const makeProfile = (): RoomProfile => ({
  id: 'r1', name: 'Test', createdBy: 'system', createdAt: Date.now(),
})

// A real in-process LLM that deterministically streams a fixed output.
// Not a mock — it's a concrete provider implementation used in tests.
const makeStreamingProvider = (output: string): LLMProvider => ({
  chat: async () => ({ content: output, generationMs: 1, tokensUsed: { prompt: 0, completion: 0 } }),
  stream: async function* (_req: ChatRequest): AsyncIterable<StreamChunk> {
    for (const ch of output) {
      yield { delta: ch, done: false }
    }
    yield { delta: '', done: true }
  },
  models: async () => ['fake'],
})

const configureCompression = (room: ReturnType<typeof createRoom>, keepFresh: number, batchSize: number): void => {
  room.setSummaryConfig({
    ...DEFAULT_SUMMARY_CONFIG,
    compression: {
      ...DEFAULT_SUMMARY_CONFIG.compression,
      enabled: true,
      keepFresh,
      batchSize,
    },
  })
}

describe('summary-engine', () => {
  test('compressionDue returns false when disabled', () => {
    const room = createRoom(makeProfile())
    for (let i = 0; i < 100; i++) room.post({ senderId: 'a', content: `m${i}`, type: 'chat' })
    expect(compressionDue(room)).toBe(false)
  })

  test('compressionDue fires only when uncompressed >= keepFresh + batchSize', () => {
    const room = createRoom(makeProfile())
    configureCompression(room, 5, 3)
    for (let i = 0; i < 7; i++) room.post({ senderId: 'a', content: `m${i}`, type: 'chat' })
    expect(compressionDue(room)).toBe(false)
    room.post({ senderId: 'a', content: 'm7', type: 'chat' })
    expect(compressionDue(room)).toBe(true)
  })

  test('pickCompressionCandidates returns the oldest batchSize messages', () => {
    const room = createRoom(makeProfile())
    configureCompression(room, 3, 2)
    for (let i = 0; i < 5; i++) room.post({ senderId: 'a', content: `m${i}`, type: 'chat' })
    const picks = pickCompressionCandidates(room)
    expect(picks.map(m => m.content)).toEqual(['m0', 'm1'])
  })

  test('runCompression replaces oldest batch with a room_summary at the top', async () => {
    const room = createRoom(makeProfile())
    configureCompression(room, 3, 2)
    for (let i = 0; i < 6; i++) room.post({ senderId: 'a', content: `msg-${i}`, type: 'chat' })
    const engine = createSummaryEngine({ llm: makeStreamingProvider('compressed blob'), defaultModel: () => 'fake' })
    const result = await engine.runCompression(room)
    expect(result).not.toBeNull()
    expect(result!.text).toBe('compressed blob')
    const recent = room.getRecent(room.getMessageCount())
    expect(recent[0]!.type).toBe('room_summary')
    expect(recent[0]!.content).toBe('compressed blob')
    // 2 compressed + previous 4 remaining (msg-2..msg-5) + 1 room_summary at top = 5 total
    expect(recent).toHaveLength(5)
    expect(recent.slice(1).map(m => m.content)).toEqual(['msg-2', 'msg-3', 'msg-4', 'msg-5'])
    expect(room.getCompressedIds().size).toBe(2)
  })

  test('second compression replaces the prior room_summary (single evolving summary)', async () => {
    const room = createRoom(makeProfile())
    configureCompression(room, 2, 2)
    for (let i = 0; i < 4; i++) room.post({ senderId: 'a', content: `a${i}`, type: 'chat' })
    const engine1 = createSummaryEngine({ llm: makeStreamingProvider('gen1'), defaultModel: () => 'fake' })
    await engine1.runCompression(room)
    // add more messages to exceed the threshold again
    for (let i = 0; i < 2; i++) room.post({ senderId: 'a', content: `b${i}`, type: 'chat' })
    const engine2 = createSummaryEngine({ llm: makeStreamingProvider('gen2'), defaultModel: () => 'fake' })
    await engine2.runCompression(room)
    const recent = room.getRecent(room.getMessageCount())
    const summaries = recent.filter(m => m.type === 'room_summary')
    expect(summaries).toHaveLength(1)
    expect(summaries[0]!.content).toBe('gen2')
  })

  test('runSummary streams deltas and sets latestSummary', async () => {
    const room = createRoom(makeProfile())
    room.post({ senderId: 'a', content: 'hello', type: 'chat' })
    const engine = createSummaryEngine({ llm: makeStreamingProvider('summary text'), defaultModel: () => 'fake' })
    const deltas: string[] = []
    await engine.runSummary(room, { onDelta: d => deltas.push(d) })
    expect(deltas.join('')).toBe('summary text')
    expect(room.getLatestSummary()).toBe('summary text')
  })
})
