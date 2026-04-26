import { describe, test, expect } from 'bun:test'
import { __test, classifyWhisper } from './script-whisper.ts'
import type { LLMProvider, ChatRequest, ChatResponse } from './types/llm.ts'

const present = ['Alex', 'Sam']

describe('validate', () => {
  test('accepts minimal valid whisper', () => {
    const r = __test.validate({ ready_to_advance: true }, present)
    expect('whisper' in r).toBe(true)
  })

  test('accepts whisper with all optional fields', () => {
    const r = __test.validate({
      ready_to_advance: false,
      notes: 'cost concern',
      addressing: 'Sam',
      role_update: 'sceptic',
    }, present)
    expect('whisper' in r && r.whisper.notes).toBe('cost concern')
    expect('whisper' in r && r.whisper.addressing).toBe('Sam')
  })

  test('rejects missing ready_to_advance', () => {
    const r = __test.validate({}, present)
    expect('error' in r).toBe(true)
  })

  test('rejects non-boolean ready_to_advance', () => {
    const r = __test.validate({ ready_to_advance: 'yes' }, present)
    expect('error' in r).toBe(true)
  })

  test('rejects addressing not in present cast', () => {
    const r = __test.validate({ ready_to_advance: true, addressing: 'Stranger' }, present)
    expect('error' in r && r.error).toMatch(/Stranger/)
  })

  test('rejects notes > 200 chars', () => {
    const r = __test.validate({ ready_to_advance: true, notes: 'x'.repeat(201) }, present)
    expect('error' in r).toBe(true)
  })

  test('drops empty-string addressing without error', () => {
    const r = __test.validate({ ready_to_advance: true, addressing: '' }, present)
    expect('whisper' in r && r.whisper.addressing).toBeUndefined()
  })

  test('drops null addressing without error', () => {
    const r = __test.validate({ ready_to_advance: true, addressing: null }, present)
    expect('whisper' in r && r.whisper.addressing).toBeUndefined()
  })
})

describe('buildPrompt', () => {
  test('includes the message text and present cast names', () => {
    const p = __test.buildPrompt({
      llm: {} as LLMProvider,
      model: 'm',
      message: 'I knew about it.',
      scriptContext: 'Step 2/4',
      presentCast: ['Alex', 'Sam'],
    })
    expect(p).toContain('I knew about it.')
    expect(p).toContain('Alex, Sam')
    expect(p).toContain('ready_to_advance')
  })
})

describe('classifyWhisper end-to-end', () => {
  const mkLLM = (responses: string[]): LLMProvider => {
    let i = 0
    return {
      chat: async (_req: ChatRequest): Promise<ChatResponse> => {
        const content = responses[Math.min(i, responses.length - 1)]!
        i += 1
        return {
          content,
          generationMs: 0,
          tokensUsed: { prompt: 0, completion: 0 },
        }
      },
    } as unknown as LLMProvider
  }

  test('happy first-try parse', async () => {
    const llm = mkLLM([JSON.stringify({ ready_to_advance: true, notes: 'done' })])
    const result = await classifyWhisper({
      llm, model: 'm', message: 'x', scriptContext: 'ctx', presentCast: present,
    })
    expect(result.usedFallback).toBe(false)
    expect(result.whisper.ready_to_advance).toBe(true)
    expect(result.whisper.notes).toBe('done')
  })

  test('first-try malformed → second-try succeeds', async () => {
    const llm = mkLLM(['not valid json {{', JSON.stringify({ ready_to_advance: false })])
    const result = await classifyWhisper({
      llm, model: 'm', message: 'x', scriptContext: 'ctx', presentCast: present,
    })
    expect(result.usedFallback).toBe(false)
    expect(result.whisper.ready_to_advance).toBe(false)
  })

  test('both attempts fail → fallback', async () => {
    const llm = mkLLM(['nope', 'still nope'])
    const result = await classifyWhisper({
      llm, model: 'm', message: 'x', scriptContext: 'ctx', presentCast: present,
    })
    expect(result.usedFallback).toBe(true)
    expect(result.whisper.ready_to_advance).toBe(false)
  })

  test('chat throws → captured as failure → fallback', async () => {
    const llm = {
      chat: async () => { throw new Error('rate limit') },
    } as unknown as LLMProvider
    const result = await classifyWhisper({
      llm, model: 'm', message: 'x', scriptContext: 'ctx', presentCast: present,
    })
    expect(result.usedFallback).toBe(true)
  })
})
