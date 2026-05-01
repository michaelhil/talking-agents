// Summary & Compression engine.
//
// Two operations, both operate on a Room and stream deltas back to callers:
//   - runSummary: rolling user-readable overview of all messages.
//   - runCompression: rewrite the Y oldest uncompressed messages into a single
//     evolving `room_summary` at the top of the stream, which also feeds
//     the LLM via context-builder.
//
// Both are independent; callers may fire both in parallel via Promise.all.
// The shared prompt prefix (system + message history) lets provider-side
// prompt caching amortise the cost.

import type { LLMProvider, StreamChunk } from '../types/llm.ts'
import type { Message } from '../types/messaging.ts'
import type { Room } from '../types/room.ts'
import type { Aggressiveness } from '../types/summary.ts'

export interface SummaryEngineDeps {
  readonly llm: { readonly stream?: LLMProvider['stream'] }
  // Fallback model when the room config doesn't pin one.
  readonly defaultModel: () => string
}

export interface RunOptions {
  readonly abort?: AbortSignal
  readonly onDelta?: (delta: string) => void
  // Optional override — otherwise the room's configured aggressiveness is used.
  readonly aggressivenessOverride?: Aggressiveness
  // Optional override — otherwise the room's configured model is used.
  readonly modelOverride?: string
}

export interface CompressionResult {
  readonly text: string
  readonly compressedIds: ReadonlyArray<string>
}

const AGGRESSIVENESS_GUIDE: Record<Aggressiveness, string> = {
  low: 'Preserve most details. Keep quotes, names, decisions, numbers. Length can be long.',
  med: 'Keep the essentials: decisions, who-said-what, open questions, key facts. Moderate length.',
  high: 'Be very terse. Only the most load-bearing outcomes, decisions, and unresolved items. Short.',
}

const SUMMARY_SYSTEM = (aggressiveness: Aggressiveness) => `You are summarising a multi-agent chat room for a human reader who needs to catch up quickly.
${AGGRESSIVENESS_GUIDE[aggressiveness]}
Use [ParticipantName] when referring to speakers. Preserve factual claims from any prior [Room Summary] entries and only extend — never contradict what was previously established. Respond with plain prose only, no preamble, no meta-commentary.`

const COMPRESSION_SYSTEM = (aggressiveness: Aggressiveness) => `You are compressing the oldest part of a multi-agent chat room so later agents can still recall it without having the raw messages.
${AGGRESSIVENESS_GUIDE[aggressiveness]}
Use [ParticipantName] when referring to speakers. Preserve factual claims from any prior [Room Summary] entries and extend — never contradict. The output replaces the old messages in context, so it must be self-contained and faithful. Respond with plain prose only, no preamble.`

// --- Message formatting for the LLM prompt ---

const formatMessagesForPrompt = (msgs: ReadonlyArray<Message>): string =>
  msgs
    .filter(m => m.type === 'chat' || m.type === 'room_summary')
    .map(m => {
      const name = m.type === 'room_summary' ? 'Room Summary' : (m.senderName ?? m.senderId)
      return `[${name}]: ${m.content}`
    })
    .join('\n')

// --- Candidate selection ---

// The single evolving compression (if any) always lives at index 0.
const findPriorSummary = (all: ReadonlyArray<Message>): Message | undefined =>
  all.find(m => m.type === 'room_summary')

// Messages eligible for compression (not the prior summary itself).
const uncompressedMessages = (all: ReadonlyArray<Message>): ReadonlyArray<Message> =>
  all.filter(m => m.type !== 'room_summary')

export const compressionDue = (
  room: Pick<Room, 'summaryConfig' | 'getRecent' | 'getMessageCount'>,
): boolean => {
  const cfg = room.summaryConfig.compression
  if (!cfg.enabled) return false
  const all = room.getRecent(room.getMessageCount())
  const uncompressed = uncompressedMessages(all)
  return uncompressed.length >= cfg.keepFresh + cfg.batchSize
}

export const pickCompressionCandidates = (
  room: Pick<Room, 'summaryConfig' | 'getRecent' | 'getMessageCount'>,
): ReadonlyArray<Message> => {
  const cfg = room.summaryConfig.compression
  const all = room.getRecent(room.getMessageCount())
  const uncompressed = uncompressedMessages(all)
  if (uncompressed.length < cfg.keepFresh + cfg.batchSize) return []
  return uncompressed.slice(0, cfg.batchSize)
}

// --- Streaming helper ---

const streamToString = async (
  stream: AsyncIterable<StreamChunk>,
  onDelta?: (d: string) => void,
): Promise<string> => {
  let out = ''
  for await (const chunk of stream) {
    if (chunk.delta) {
      out += chunk.delta
      onDelta?.(chunk.delta)
    }
    if (chunk.done) break
  }
  return out.trim()
}

// --- Engine ---

export const createSummaryEngine = (deps: SummaryEngineDeps) => {
  const resolveModel = (room: Room, override: string | undefined): string =>
    override ?? room.summaryConfig.model ?? deps.defaultModel()

  const resolveAggressiveness = (room: Room, override: Aggressiveness | undefined): Aggressiveness =>
    override ?? room.summaryConfig.compression.aggressiveness

  const requireStream = (): NonNullable<LLMProvider['stream']> => {
    if (!deps.llm.stream) {
      throw new Error('Summary engine requires an LLM provider with streaming support')
    }
    return deps.llm.stream
  }

  const runSummary = async (room: Room, opts: RunOptions = {}): Promise<string> => {
    const stream = requireStream()
    const all = room.getRecent(room.getMessageCount())
    if (all.length === 0) return ''
    const aggressiveness = resolveAggressiveness(room, opts.aggressivenessOverride)
    const model = resolveModel(room, opts.modelOverride)
    const systemPrompt = SUMMARY_SYSTEM(aggressiveness)
    const userContent = `Room: "${room.profile.name}"\n\nTranscript:\n${formatMessagesForPrompt(all)}`
    const iter = stream({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0.3,
    }, opts.abort)
    const text = await streamToString(iter, opts.onDelta)
    if (text) room.setLatestSummary(text)
    return text
  }

  const runCompression = async (
    room: Room,
    opts: RunOptions = {},
  ): Promise<CompressionResult | null> => {
    const stream = requireStream()
    const all = room.getRecent(room.getMessageCount())
    const prior = findPriorSummary(all)
    const cfg = room.summaryConfig.compression
    const uncompressed = uncompressedMessages(all)
    if (uncompressed.length < cfg.keepFresh + cfg.batchSize) return null
    const candidates = uncompressed.slice(0, cfg.batchSize)
    const aggressiveness = resolveAggressiveness(room, opts.aggressivenessOverride)
    const model = resolveModel(room, opts.modelOverride)
    const systemPrompt = COMPRESSION_SYSTEM(aggressiveness)
    const priorBlock = prior ? `Prior summary (extend — do not contradict):\n${prior.content}\n\n` : ''
    const userContent = `Room: "${room.profile.name}"\n\n${priorBlock}Messages to compress:\n${formatMessagesForPrompt(candidates)}`
    const iter = stream({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0.3,
    }, opts.abort)
    const text = await streamToString(iter, opts.onDelta)
    if (!text) return null
    const compressedIds = candidates.map(m => m.id)
    room.replaceCompression(compressedIds, text)
    return { text, compressedIds }
  }

  return { runSummary, runCompression }
}

export type SummaryEngine = ReturnType<typeof createSummaryEngine>
