import { describe, test, expect } from 'bun:test'
import { createOllamaProvider } from './ollama.ts'
import { DEFAULTS } from '../core/types.ts'

const FAST_MODEL = 'llama3.2:latest'

describe('OllamaProvider', () => {
  const provider = createOllamaProvider(DEFAULTS.ollamaBaseUrl)

  test('lists available models', async () => {
    const modelList = await provider.models()
    expect(modelList.length).toBeGreaterThan(0)
    expect(modelList).toContain(FAST_MODEL)
  })

  test('sends a chat request and gets a response', async () => {
    const response = await provider.chat({
      model: FAST_MODEL,
      messages: [
        { role: 'user', content: 'Reply with exactly the word: pong' },
      ],
    })

    expect(response.content.length).toBeGreaterThan(0)
    expect(response.generationMs).toBeGreaterThan(0)
    expect(response.tokensUsed.prompt).toBeGreaterThan(0)
    expect(response.tokensUsed.completion).toBeGreaterThan(0)
  }, 30_000)

  test('supports JSON mode', async () => {
    const response = await provider.chat({
      model: FAST_MODEL,
      messages: [
        { role: 'system', content: 'Respond only with valid JSON.' },
        { role: 'user', content: 'Return {"status": "ok"}' },
      ],
      jsonMode: true,
    })

    const parsed = JSON.parse(response.content)
    expect(parsed).toBeDefined()
    expect(typeof parsed).toBe('object')
  }, 30_000)

  test('supports temperature parameter', async () => {
    const response = await provider.chat({
      model: FAST_MODEL,
      messages: [
        { role: 'user', content: 'Say hello' },
      ],
      temperature: 0.0,
    })

    expect(response.content.length).toBeGreaterThan(0)
  }, 30_000)

  test('throws on invalid model', async () => {
    await expect(
      provider.chat({
        model: 'nonexistent-model-xyz',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow()
  }, 30_000)
})
