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
    expect(out).toBe('anthropic:claude-haiku-4-5')
  })

  test('anthropic missing key → falls through to next preference (gemini)', () => {
    const out = resolveDefaultModel([
      p('anthropic', 'no_key', []),
      p('gemini', 'ok', ['gemini-2.5-flash-lite']),
      p('groq', 'ok', ['llama-3.3-70b-versatile']),
    ])
    expect(out).toBe('gemini:gemini-2.5-flash-lite')
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
    expect(out).toBe('gemini:gemini-2.5-flash-lite')
  })

  test('first preference ok but empty models → falls through', () => {
    const out = resolveDefaultModel([
      p('anthropic', 'ok', []),
      p('gemini', 'ok', ['gemini-2.5-flash-lite']),
    ])
    expect(out).toBe('gemini:gemini-2.5-flash-lite')
  })

  test('only non-curated provider configured → tail fallback picks it', () => {
    // mistral / openrouter / sambanova / ollama aren't in DEFAULT_PREFERENCE_ORDER.
    // The second pass should still find them.
    const out = resolveDefaultModel([
      p('mistral', 'ok', ['mistral-small-latest']),
    ])
    expect(out).toBe('mistral:mistral-small-latest')
  })
})
