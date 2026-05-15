import { describe, expect, test } from 'bun:test'
import { resolveDefaultModel, type ProviderSnapshot } from './default-resolver.ts'

const p = (
  name: string,
  status: ProviderSnapshot['status'],
  modelIds: ReadonlyArray<string>,
): ProviderSnapshot => ({ name, status, models: modelIds.map(id => ({ id })) })

describe('resolveDefaultModel', () => {
  test('all healthy → first preference (anthropic) wins', () => {
    const out = resolveDefaultModel([
      p('anthropic', 'ok', ['claude-haiku-4-5']),
      p('groq', 'ok', ['llama-3.3-70b-versatile']),
    ])
    expect(out).toBe('claude-haiku-4-5')
  })

  test('anthropic missing key → falls through to next preference (gemini)', () => {
    const out = resolveDefaultModel([
      p('anthropic', 'no_key', []),
      p('gemini', 'ok', ['gemini-2.5-flash-lite']),
      p('groq', 'ok', ['llama-3.3-70b-versatile']),
    ])
    expect(out).toBe('gemini-2.5-flash-lite')
  })

  test('all cloud unconfigured, ollama running → ollama default (no prefix)', () => {
    const out = resolveDefaultModel([
      p('anthropic', 'no_key', []),
      p('gemini', 'no_key', []),
      p('ollama', 'ok', ['qwen2.5-coder']),
    ])
    expect(out).toBe('qwen2.5-coder')
  })

  test('no providers usable → empty string', () => {
    const out = resolveDefaultModel([
      p('anthropic', 'no_key', []),
      p('gemini', 'cooldown', ['gemini-2.5-flash-lite']),
      p('ollama', 'down', []),
    ])
    expect(out).toBe('')
  })

  test('first preference in cooldown → falls through (cooldown is not ok)', () => {
    const out = resolveDefaultModel([
      p('anthropic', 'cooldown', ['claude-haiku-4-5']),
      p('gemini', 'ok', ['gemini-2.5-flash-lite']),
    ])
    expect(out).toBe('gemini-2.5-flash-lite')
  })

  test('first preference ok but empty models → falls through', () => {
    const out = resolveDefaultModel([
      p('anthropic', 'ok', []),
      p('gemini', 'ok', ['gemini-2.5-flash-lite']),
    ])
    expect(out).toBe('gemini-2.5-flash-lite')
  })

  test('only non-curated provider configured → tail fallback picks it', () => {
    // mistral / openrouter / sambanova / ollama aren't in DEFAULT_PREFERENCE_ORDER.
    // The second pass should still find them.
    const out = resolveDefaultModel([
      p('mistral', 'ok', ['mistral-small-latest']),
    ])
    expect(out).toBe('mistral-small-latest')
  })

  // --- Thinking-model filter ---
  // resolveDefaultModel must never pick a thinking model for a fresh seed.
  // The kind tag lives in CURATED_MODELS; the resolver consults it.

  test('provider with only thinking-curated models → skipped, next preference wins', async () => {
    // Stub a thinking-only kimi catalog by injecting into CURATED_MODELS at
    // runtime. Reverting after asserts so cross-test bleed doesn't happen.
    const { CURATED_MODELS } = await import('./catalog.ts')
    const original = CURATED_MODELS.kimi
    ;(CURATED_MODELS as Record<string, ReadonlyArray<{ id: string; kind?: 'fast' | 'thinking' }>>).kimi = [
      { id: 'kimi-k2.6', kind: 'thinking' },
    ]
    try {
      const out = resolveDefaultModel([
        p('kimi', 'ok', ['kimi-k2.6']),
        p('gemini', 'ok', ['gemini-2.5-flash']),
      ])
      // kimi-k2.6 must be skipped; gemini picked.
      expect(out).toBe('gemini-2.5-flash')
    } finally {
      ;(CURATED_MODELS as Record<string, ReadonlyArray<{ id: string }> | undefined>).kimi = original
    }
  })

  test('provider with thinking AND fast curated → picks the fast one', async () => {
    const { CURATED_MODELS } = await import('./catalog.ts')
    const original = CURATED_MODELS.kimi
    ;(CURATED_MODELS as Record<string, ReadonlyArray<{ id: string; kind?: 'fast' | 'thinking' }>>).kimi = [
      { id: 'kimi-k2.6', kind: 'thinking' },
      { id: 'moonshot-v1-128k' /* default 'fast' */ },
    ]
    try {
      // Only kimi configured — second-pass fallback should still find the fast one.
      const out = resolveDefaultModel([
        p('kimi', 'ok', ['kimi-k2.6', 'moonshot-v1-128k']),
      ])
      expect(out).toBe('moonshot-v1-128k')
    } finally {
      ;(CURATED_MODELS as Record<string, ReadonlyArray<{ id: string }> | undefined>).kimi = original
    }
  })

  test('unknown model id (not in catalog) → treated as fast (default-allow)', () => {
    const out = resolveDefaultModel([
      p('mistral', 'ok', ['some-future-model-id-not-in-catalog']),
    ])
    expect(out).toBe('some-future-model-id-not-in-catalog')
  })
})
