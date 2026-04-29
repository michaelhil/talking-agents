// Integration test: per-call effective-model resolution wired through the
// agent. Validates the full chain — agent stores preferred, eval resolves
// effective at call time, model_fallback warning fires once per fallback
// target, and the LLM provider receives the effective (not preferred) model.

import { describe, expect, test } from 'bun:test'
import type { LLMProvider, ChatRequest } from '../core/types/llm.ts'
import type { AIAgentConfig } from '../core/types/agent.ts'
import type { Message } from '../core/types/messaging.ts'
import type { EvalEvent } from '../core/types/agent-eval.ts'
import { createAIAgent } from './ai-agent.ts'
import { resolveEffectiveModel } from './resolve-model.ts'

const makeMessage = (over: Partial<Message> = {}): Message => ({
  id: 'm1',
  senderId: 'alice',
  content: 'hello',
  timestamp: Date.now(),
  type: 'chat',
  roomId: 'room-1',
  ...over,
})

describe('Effective-model resolution wired through agent', () => {
  test('preferred unavailable → eval calls LLM with fallback model + emits one-shot warning', async () => {
    const seenModels: string[] = []
    const provider: LLMProvider = {
      chat: async (req: ChatRequest) => {
        seenModels.push(req.model)
        return { content: 'ok', generationMs: 1, tokensUsed: { prompt: 1, completion: 1 } }
      },
      models: async () => ['groq:llama-3.3-70b-versatile'],
    }

    const events: Array<{ name: string; event: EvalEvent }> = []
    const config: AIAgentConfig = { name: 'A', model: 'anthropic:claude-haiku-4-5', persona: 'p' }
    const agent = createAIAgent(config, provider, () => {}, {
      onEvalEvent: (name, event) => events.push({ name, event }),
      resolveEffectiveModel: (preferred) =>
        resolveEffectiveModel(
          preferred,
          (m) => m === 'groq:llama-3.3-70b-versatile',
          'groq:llama-3.3-70b-versatile',
        ),
    })

    agent.receive(makeMessage())
    await agent.whenIdle()

    // The LLM was called with the fallback, not the preferred.
    expect(seenModels).toContain('groq:llama-3.3-70b-versatile')
    expect(seenModels).not.toContain('anthropic:claude-haiku-4-5')

    // model_fallback was emitted exactly once.
    const fallbackEvents = events.filter(e => e.event.kind === 'model_fallback')
    expect(fallbackEvents).toHaveLength(1)
    if (fallbackEvents[0]!.event.kind === 'model_fallback') {
      expect(fallbackEvents[0]!.event.preferred).toBe('anthropic:claude-haiku-4-5')
      expect(fallbackEvents[0]!.event.effective).toBe('groq:llama-3.3-70b-versatile')
      expect(fallbackEvents[0]!.event.reason).toBe('preferred_unavailable')
    }
  })

  test('repeated calls with same fallback target → only one warning emitted', async () => {
    const provider: LLMProvider = {
      chat: async () => ({ content: 'ok', generationMs: 1, tokensUsed: { prompt: 1, completion: 1 } }),
      models: async () => ['groq:llama-3.3-70b-versatile'],
    }

    const events: Array<{ name: string; event: EvalEvent }> = []
    const config: AIAgentConfig = { name: 'A', model: 'anthropic:claude-haiku-4-5', persona: 'p' }
    const agent = createAIAgent(config, provider, () => {}, {
      onEvalEvent: (name, event) => events.push({ name, event }),
      resolveEffectiveModel: (preferred) =>
        resolveEffectiveModel(
          preferred,
          (m) => m === 'groq:llama-3.3-70b-versatile',
          'groq:llama-3.3-70b-versatile',
        ),
    })

    for (let i = 0; i < 3; i++) {
      agent.receive(makeMessage({ id: `m${i}`, senderId: 'alice' }))
      await agent.whenIdle()
    }

    const fallbackEvents = events.filter(e => e.event.kind === 'model_fallback')
    expect(fallbackEvents).toHaveLength(1) // not 3
  })

  test('preferred available → no fallback event, LLM gets preferred', async () => {
    const seenModels: string[] = []
    const provider: LLMProvider = {
      chat: async (req: ChatRequest) => {
        seenModels.push(req.model)
        return { content: 'ok', generationMs: 1, tokensUsed: { prompt: 1, completion: 1 } }
      },
      models: async () => ['anthropic:claude-haiku-4-5'],
    }

    const events: Array<{ name: string; event: EvalEvent }> = []
    const config: AIAgentConfig = { name: 'A', model: 'anthropic:claude-haiku-4-5', persona: 'p' }
    const agent = createAIAgent(config, provider, () => {}, {
      onEvalEvent: (name, event) => events.push({ name, event }),
      resolveEffectiveModel: (preferred) =>
        resolveEffectiveModel(
          preferred,
          (m) => m === 'anthropic:claude-haiku-4-5',
          'anthropic:claude-haiku-4-5',
        ),
    })

    agent.receive(makeMessage())
    await agent.whenIdle()

    expect(seenModels).toEqual(['anthropic:claude-haiku-4-5'])
    expect(events.filter(e => e.event.kind === 'model_fallback')).toHaveLength(0)
  })

  test('preferred recovers then breaks again → warning re-emitted', async () => {
    let availableSet = new Set(['anthropic:claude-haiku-4-5'])
    const provider: LLMProvider = {
      chat: async () => ({ content: 'ok', generationMs: 1, tokensUsed: { prompt: 1, completion: 1 } }),
      models: async () => [...availableSet],
    }

    const events: Array<{ name: string; event: EvalEvent }> = []
    const config: AIAgentConfig = { name: 'A', model: 'anthropic:claude-haiku-4-5', persona: 'p' }
    const agent = createAIAgent(config, provider, () => {}, {
      onEvalEvent: (name, event) => events.push({ name, event }),
      resolveEffectiveModel: (preferred) =>
        resolveEffectiveModel(
          preferred,
          (m) => availableSet.has(m),
          [...availableSet][0] ?? 'groq:llama-3.3-70b-versatile',
        ),
    })

    // 1st: preferred available, no warning.
    agent.receive(makeMessage({ id: 'm1' }))
    await agent.whenIdle()

    // 2nd: preferred goes away, fallback fires.
    availableSet = new Set(['groq:llama-3.3-70b-versatile'])
    agent.receive(makeMessage({ id: 'm2', senderId: 'alice' }))
    await agent.whenIdle()

    // 3rd: preferred recovers.
    availableSet = new Set(['anthropic:claude-haiku-4-5'])
    agent.receive(makeMessage({ id: 'm3', senderId: 'alice' }))
    await agent.whenIdle()

    // 4th: preferred breaks again — warning should re-emit (lastFallbackTarget cleared on recovery).
    availableSet = new Set(['groq:llama-3.3-70b-versatile'])
    agent.receive(makeMessage({ id: 'm4', senderId: 'alice' }))
    await agent.whenIdle()

    const fallbackEvents = events.filter(e => e.event.kind === 'model_fallback')
    expect(fallbackEvents).toHaveLength(2) // once on m2, once on m4
  })
})
