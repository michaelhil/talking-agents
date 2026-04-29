import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadGithubTokens,
  saveGithubTokens,
  mergeWithEnv,
  maskKey,
  envVarFor,
  STORE_VERSION,
} from './github-tokens.ts'

const ENV_KEYS = ['SAMSINN_PACK_REGISTRY_TOKEN', 'SAMSINN_WIKI_REGISTRY_TOKEN'] as const
const restoreEnv: Partial<Record<typeof ENV_KEYS[number], string | undefined>> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    restoreEnv[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (restoreEnv[k] === undefined) delete process.env[k]
    else process.env[k] = restoreEnv[k]!
  }
})

describe('github-tokens store', () => {
  test('load missing file → empty default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gt-test-'))
    try {
      const data = await loadGithubTokens(join(dir, 'missing.json'))
      expect(data.tokens).toEqual({})
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('round-trip save → load', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gt-test-'))
    try {
      const path = join(dir, 't.json')
      await saveGithubTokens(path, {
        version: STORE_VERSION,
        tokens: {
          packRegistry: { apiKey: 'ghp_pack' },
          wikiRegistry: { apiKey: 'ghp_wiki' },
        },
      })
      const loaded = await loadGithubTokens(path)
      expect(loaded.tokens.packRegistry?.apiKey).toBe('ghp_pack')
      expect(loaded.tokens.wikiRegistry?.apiKey).toBe('ghp_wiki')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('save sets file mode 0600', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gt-test-'))
    try {
      const path = join(dir, 't.json')
      await saveGithubTokens(path, { version: STORE_VERSION, tokens: { packRegistry: { apiKey: 'k' } } })
      const s = await stat(path)
      expect(s.mode & 0o777).toBe(0o600)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('load drops empty/non-string apiKeys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gt-test-'))
    try {
      const { writeFile } = await import('node:fs/promises')
      const path = join(dir, 't.json')
      await writeFile(path, JSON.stringify({
        version: 1,
        tokens: {
          packRegistry: { apiKey: '' },
          wikiRegistry: { apiKey: 42 },
        },
      }))
      const loaded = await loadGithubTokens(path)
      expect(loaded.tokens).toEqual({})
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('mergeWithEnv', () => {
  test('env wins over stored', () => {
    process.env.SAMSINN_PACK_REGISTRY_TOKEN = 'env_pack'
    const merged = mergeWithEnv({
      version: STORE_VERSION,
      tokens: { packRegistry: { apiKey: 'stored_pack' } },
    })
    expect(merged.packRegistry.apiKey).toBe('env_pack')
    expect(merged.packRegistry.source).toBe('env')
  })

  test('stored used when env missing', () => {
    const merged = mergeWithEnv({
      version: STORE_VERSION,
      tokens: { packRegistry: { apiKey: 'stored_pack' } },
    })
    expect(merged.packRegistry.apiKey).toBe('stored_pack')
    expect(merged.packRegistry.source).toBe('stored')
  })

  test("source 'none' when neither set", () => {
    const merged = mergeWithEnv({ version: STORE_VERSION, tokens: {} })
    expect(merged.packRegistry.apiKey).toBe('')
    expect(merged.packRegistry.source).toBe('none')
    expect(merged.wikiRegistry.source).toBe('none')
  })

  test('empty-string env falls through to stored', () => {
    process.env.SAMSINN_WIKI_REGISTRY_TOKEN = '   '
    const merged = mergeWithEnv({
      version: STORE_VERSION,
      tokens: { wikiRegistry: { apiKey: 'stored_wiki' } },
    })
    expect(merged.wikiRegistry.apiKey).toBe('stored_wiki')
    expect(merged.wikiRegistry.source).toBe('stored')
  })
})

describe('maskKey', () => {
  test('long key shows last 4', () => {
    expect(maskKey('ghp_abcdef1234567890')).toBe('•••7890')
  })
  test('short key fully masked', () => {
    expect(maskKey('abc')).toBe('•••')
  })
  test('empty string', () => {
    expect(maskKey('')).toBe('')
  })
})

describe('envVarFor', () => {
  test('packRegistry → SAMSINN_PACK_REGISTRY_TOKEN', () => {
    expect(envVarFor('packRegistry')).toBe('SAMSINN_PACK_REGISTRY_TOKEN')
  })
  test('wikiRegistry → SAMSINN_WIKI_REGISTRY_TOKEN', () => {
    expect(envVarFor('wikiRegistry')).toBe('SAMSINN_WIKI_REGISTRY_TOKEN')
  })
})
