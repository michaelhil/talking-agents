import { describe, expect, test } from 'bun:test'
import { resolveEmbedder } from './embed-resolver.ts'
import type { MergedProviders, MergedProviderEntry } from '../llm/providers-store.ts'

const mkEntry = (overrides: Partial<MergedProviderEntry>): MergedProviderEntry => ({
  apiKey: '',
  source: 'none',
  enabled: false,
  maxConcurrent: undefined,
  maskedKey: '',
  pinnedModels: [],
  baseUrl: undefined,
  embeddingModel: undefined,
  ...overrides,
})

const mkProviders = (cloud: Partial<MergedProviders['cloud']>): MergedProviders => ({
  cloud,
  ollama: { enabled: false, maxConcurrent: undefined },
})

describe('embed-resolver', () => {
  test('fresh: picks openai when both keys present', () => {
    const r = resolveEmbedder({
      providers: mkProviders({
        openai: mkEntry({ apiKey: 'sk-aaa', source: 'env', enabled: true, maskedKey: '•••aaa' }),
        gemini: mkEntry({ apiKey: 'g-bbb', source: 'env', enabled: true, maskedKey: '•••bbb' }),
      }),
      bound: null,
    })
    expect(r.status).toBe('ok')
    if (r.status === 'ok') {
      expect(r.provider).toBe('openai')
      expect(r.model).toBe('text-embedding-3-small')
    }
  })

  test('fresh: falls through to gemini when openai not configured', () => {
    const r = resolveEmbedder({
      providers: mkProviders({
        gemini: mkEntry({ apiKey: 'g-bbb', source: 'env', enabled: true, maskedKey: '•••bbb' }),
      }),
      bound: null,
    })
    expect(r.status).toBe('ok')
    if (r.status === 'ok') {
      expect(r.provider).toBe('gemini')
      expect(r.model).toBe('text-embedding-004')
    }
  })

  test('fresh: returns unconfigured when no provider has a key', () => {
    const r = resolveEmbedder({
      providers: mkProviders({}),
      bound: null,
    })
    expect(r.status).toBe('unconfigured')
  })

  test('fresh: honours stored embeddingModel override', () => {
    const r = resolveEmbedder({
      providers: mkProviders({
        openai: mkEntry({
          apiKey: 'sk-aaa', source: 'stored', enabled: true,
          maskedKey: '•••aaa', embeddingModel: 'text-embedding-3-large',
        }),
      }),
      bound: null,
    })
    expect(r.status).toBe('ok')
    if (r.status === 'ok') {
      expect(r.model).toBe('text-embedding-3-large')
    }
  })

  test('bound: continues with same provider/model when key still present', () => {
    const r = resolveEmbedder({
      providers: mkProviders({
        openai: mkEntry({ apiKey: 'sk-aaa', source: 'env', enabled: true, maskedKey: '•••aaa' }),
        gemini: mkEntry({ apiKey: 'g-bbb', source: 'env', enabled: true, maskedKey: '•••bbb' }),
      }),
      bound: { provider: 'gemini', model: 'text-embedding-004', dim: 768 },
    })
    expect(r.status).toBe('ok')
    if (r.status === 'ok') {
      expect(r.provider).toBe('gemini')
      expect(r.model).toBe('text-embedding-004')
    }
  })

  test('bound: returns stuck when bound provider key was removed', () => {
    const r = resolveEmbedder({
      providers: mkProviders({
        openai: mkEntry({ apiKey: 'sk-aaa', source: 'env', enabled: true, maskedKey: '•••aaa' }),
      }),
      bound: { provider: 'gemini', model: 'text-embedding-004', dim: 768 },
    })
    expect(r.status).toBe('stuck')
    if (r.status === 'stuck') {
      expect(r.binding?.provider).toBe('gemini')
    }
  })

  test('bound: stuck includes a clear remediation message', () => {
    const r = resolveEmbedder({
      providers: mkProviders({}),
      bound: { provider: 'openai', model: 'text-embedding-3-small', dim: 1536 },
    })
    expect(r.status).toBe('stuck')
    if (r.status === 'stuck') {
      expect(r.reason).toContain('OPENAI_API_KEY')
    }
  })
})
