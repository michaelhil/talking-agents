import { describe, expect, test } from 'bun:test'
import {
  classifyHttpFailure,
  discoverFromGitHub,
  type GHRepo,
  type FetchFn,
} from './github-discovery.ts'

const makeRes = (init: { status: number; headers?: Record<string, string>; body?: string; json?: unknown }): Response => {
  const headers = new Headers(init.headers ?? {})
  if (init.body !== undefined) {
    return new Response(init.body, { status: init.status, headers })
  }
  return new Response(JSON.stringify(init.json ?? {}), {
    status: init.status,
    headers: { ...Object.fromEntries(headers.entries()), 'content-type': 'application/json' },
  })
}

describe('classifyHttpFailure', () => {
  test('401 → auth', async () => {
    const f = await classifyHttpFailure(makeRes({ status: 401 }), 'org', 'TOKEN_VAR')
    expect(f.reason).toBe('auth')
    expect(f.message).toContain('TOKEN_VAR')
  })

  test('404 → not_found', async () => {
    const f = await classifyHttpFailure(makeRes({ status: 404 }), 'missing-org', 'TOKEN_VAR')
    expect(f.reason).toBe('not_found')
    expect(f.message).toContain('missing-org')
  })

  test('403 with X-RateLimit-Remaining: 0 → rate_limit', async () => {
    const f = await classifyHttpFailure(
      makeRes({ status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
      'org', 'TOKEN_VAR',
    )
    expect(f.reason).toBe('rate_limit')
    expect(f.message).toContain('TOKEN_VAR')
  })

  test('403 with body containing "secondary rate limit" → secondary_limit', async () => {
    const f = await classifyHttpFailure(
      makeRes({ status: 403, body: '{"message":"You have exceeded a secondary rate limit"}' }),
      'org', 'TOKEN_VAR',
    )
    expect(f.reason).toBe('secondary_limit')
  })

  test('403 with body containing "abuse" → secondary_limit', async () => {
    const f = await classifyHttpFailure(
      makeRes({ status: 403, body: '{"message":"abuse detection mechanism"}' }),
      'org', 'TOKEN_VAR',
    )
    expect(f.reason).toBe('secondary_limit')
  })

  test('403 with body containing only "rate limit" → rate_limit fallback', async () => {
    const f = await classifyHttpFailure(
      makeRes({ status: 403, body: '{"message":"API rate limit exceeded"}' }),
      'org', 'TOKEN_VAR',
    )
    expect(f.reason).toBe('rate_limit')
  })

  test('403 with no rate-limit signature → auth', async () => {
    const f = await classifyHttpFailure(
      makeRes({ status: 403, body: '{"message":"forbidden"}' }),
      'org', 'TOKEN_VAR',
    )
    expect(f.reason).toBe('auth')
  })

  test('500 → http (generic)', async () => {
    const f = await classifyHttpFailure(makeRes({ status: 500 }), 'org', 'TOKEN_VAR')
    expect(f.reason).toBe('http')
    expect(f.status).toBe(500)
  })
})

// Build a fetch fake that responds based on URL pattern. No mocking framework
// — just a function honouring the FetchFn contract. Per no-mocks rule, this
// is a real implementation, not a stub.
const makeFetchFake = (table: Record<string, () => Response>): FetchFn => {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    for (const pattern of Object.keys(table)) {
      if (url.includes(pattern)) return table[pattern]!()
    }
    return new Response('not found', { status: 404 })
  }) as FetchFn
}

const ghRepo = (name: string, full: string, descr: string | null = null): GHRepo => ({
  name, full_name: full, description: descr, html_url: `https://github.com/${full}`,
})

describe('discoverFromGitHub', () => {
  test('happy path: org listing returns matching repos', async () => {
    const fetchFn = makeFetchFake({
      '/users/acme-packs/repos': () => new Response(JSON.stringify([
        ghRepo('samsinn-pack-foo', 'acme-packs/samsinn-pack-foo'),
        ghRepo('not-a-pack', 'acme-packs/not-a-pack'),
      ]), { status: 200 }),
    })
    const result = await discoverFromGitHub({
      sources: ['acme-packs'],
      ownerOnlyPolicy: (o) => o === 'acme-packs',  // owner-only treats everything as a pack
      repoFilter: () => true,
      repoToItem: (r) => ({ id: r.name, source: r.full_name }),
      dedupeKey: (i) => i.source,
      token: '',
      tokenEnvVar: 'TOK',
      userAgent: 'test',
      fetchFn,
    })
    expect(result.items.length).toBe(2)
    expect(result.failures).toEqual([])
  })

  test('repoFilter applied for non-owner-only sources', async () => {
    const fetchFn = makeFetchFake({
      '/users/me/repos': () => new Response(JSON.stringify([
        ghRepo('samsinn-pack-foo', 'me/samsinn-pack-foo'),
        ghRepo('not-a-pack', 'me/not-a-pack'),
      ]), { status: 200 }),
    })
    const result = await discoverFromGitHub({
      sources: ['me'],
      ownerOnlyPolicy: () => false,  // me is a user, not a *-packs org
      repoFilter: (r) => r.name.startsWith('samsinn-pack-'),
      repoToItem: (r) => ({ id: r.name, source: r.full_name }),
      dedupeKey: (i) => i.source,
      token: '',
      tokenEnvVar: 'TOK',
      userAgent: 'test',
      fetchFn,
    })
    expect(result.items.length).toBe(1)
    expect(result.items[0]!.id).toBe('samsinn-pack-foo')
  })

  test('rate-limit failure surfaces in result.failures', async () => {
    const fetchFn = makeFetchFake({
      '/users/some-org/repos': () => new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0' },
      }),
    })
    const result = await discoverFromGitHub({
      sources: ['some-org'],
      ownerOnlyPolicy: () => true,
      repoFilter: () => true,
      repoToItem: (r) => ({ id: r.name, source: r.full_name }),
      dedupeKey: (i) => i.source,
      token: '',
      tokenEnvVar: 'TOK',
      userAgent: 'test',
      fetchFn,
    })
    expect(result.items).toEqual([])
    expect(result.failures.length).toBe(1)
    expect(result.failures[0]!.reason).toBe('rate_limit')
    expect(result.failures[0]!.message).toContain('TOK')
  })

  test('per-repo source path (owner/repo)', async () => {
    const fetchFn = makeFetchFake({
      '/repos/acme/single-pack': () => new Response(JSON.stringify(
        ghRepo('single-pack', 'acme/single-pack', 'A single pack'),
      ), { status: 200 }),
    })
    const result = await discoverFromGitHub({
      sources: ['acme/single-pack'],
      ownerOnlyPolicy: () => false,
      repoFilter: () => true,
      repoToItem: (r) => ({ id: r.name, source: r.full_name }),
      dedupeKey: (i) => i.source,
      token: '',
      tokenEnvVar: 'TOK',
      userAgent: 'test',
      fetchFn,
    })
    expect(result.items.length).toBe(1)
    expect(result.items[0]!.id).toBe('single-pack')
  })

  test('dedupe across multiple sources', async () => {
    const fetchFn = makeFetchFake({
      '/users/a/repos': () => new Response(JSON.stringify([
        ghRepo('shared', 'a/shared'),
      ]), { status: 200 }),
      '/repos/a/shared': () => new Response(JSON.stringify(
        ghRepo('shared', 'a/shared'),
      ), { status: 200 }),
    })
    const result = await discoverFromGitHub({
      sources: ['a', 'a/shared'],
      ownerOnlyPolicy: () => true,
      repoFilter: () => true,
      repoToItem: (r) => ({ id: r.name, source: r.full_name }),
      dedupeKey: (i) => i.source,
      token: '',
      tokenEnvVar: 'TOK',
      userAgent: 'test',
      fetchFn,
    })
    expect(result.items.length).toBe(1)
  })

  test('archived + fork repos are filtered out', async () => {
    const fetchFn = makeFetchFake({
      '/users/x/repos': () => new Response(JSON.stringify([
        { ...ghRepo('alive', 'x/alive') },
        { ...ghRepo('zombie', 'x/zombie'), archived: true },
        { ...ghRepo('clone', 'x/clone'), fork: true },
      ]), { status: 200 }),
    })
    const result = await discoverFromGitHub({
      sources: ['x'],
      ownerOnlyPolicy: () => true,
      repoFilter: () => true,
      repoToItem: (r) => ({ id: r.name, source: r.full_name }),
      dedupeKey: (i) => i.source,
      token: '',
      tokenEnvVar: 'TOK',
      userAgent: 'test',
      fetchFn,
    })
    expect(result.items.length).toBe(1)
    expect(result.items[0]!.id).toBe('alive')
  })

  test('network failure (fetch throws) → network failure entry', async () => {
    const fetchFn = (async () => { throw new Error('ECONNREFUSED') }) as FetchFn
    const result = await discoverFromGitHub({
      sources: ['x'],
      ownerOnlyPolicy: () => true,
      repoFilter: () => true,
      repoToItem: (r) => ({ id: r.name, source: r.full_name }),
      dedupeKey: (i) => i.source,
      token: '',
      tokenEnvVar: 'TOK',
      userAgent: 'test',
      fetchFn,
    })
    expect(result.items).toEqual([])
    expect(result.failures.length).toBe(1)
    expect(result.failures[0]!.reason).toBe('network')
  })

  test('Authorization header sent when token provided', async () => {
    let sawAuth: string | null = null
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers ?? {})
      sawAuth = headers.get('authorization')
      return new Response('[]', { status: 200 })
    }) as FetchFn
    await discoverFromGitHub({
      sources: ['x'],
      ownerOnlyPolicy: () => true,
      repoFilter: () => true,
      repoToItem: (r) => ({ id: r.name, source: r.full_name }),
      dedupeKey: (i) => i.source,
      token: 'ghp_secret123',
      tokenEnvVar: 'TOK',
      userAgent: 'test',
      fetchFn,
    })
    expect(sawAuth).toBe('Bearer ghp_secret123')
  })
})
