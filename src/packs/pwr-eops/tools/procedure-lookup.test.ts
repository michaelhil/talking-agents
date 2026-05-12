import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createProcedureLookupTool } from './procedure-lookup.ts'
import type { WikiSourceBinding } from '../../types.ts'

const BINDING: WikiSourceBinding = {
  org: 'samsinn-wikis',
  repo: 'pwr-eops',
  branch: 'main',
  procedureDir: 'wiki/procedures',
  indexFile: 'wiki/index.md',
  citationBase: 'https://samsinn-wikis.github.io/pwr-eops/procedures/',
}

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, '..', 'fixtures', name), 'utf-8')

const installFetchMock = (responder: (url: string) => Response | Promise<Response>) => {
  const original = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString()
    return Promise.resolve(responder(url))
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

const fixtureResponder = (url: string): Response => {
  if (url.endsWith('/wiki/index.md')) return new Response(fixture('index.md'), { status: 200 })
  if (url.endsWith('/wiki/procedures/E-0.md')) return new Response(fixture('E-0.md'), { status: 200 })
  if (url.endsWith('/wiki/procedures/FR-S.1.md')) return new Response(fixture('FR-S.1.md'), { status: 200 })
  return new Response('not found', { status: 404 })
}

const ctx = { callerId: 't', callerName: 't' }

describe('procedure_lookup — integration with mocked GitHub', () => {
  let restore: () => void
  beforeEach(() => { restore = installFetchMock(fixtureResponder) })
  afterEach(() => restore())

  test('no id → returns index of procedures from real fixture', async () => {
    const tool = createProcedureLookupTool(BINDING, 'PWR EOPs', 'https://samsinn-wikis.github.io/pwr-eops/')
    const r = await tool.execute({}, ctx)
    expect(r.success).toBe(true)
    const data = r.data as string
    expect(data).toContain('## PWR EOPs')
    expect(data).toContain('`E-0`')
  })

  test('id="E-0" → returns rendered markdown with mermaid', async () => {
    const tool = createProcedureLookupTool(BINDING, 'PWR EOPs', 'https://samsinn-wikis.github.io/pwr-eops/')
    const r = await tool.execute({ id: 'E-0' }, ctx)
    expect(r.success).toBe(true)
    const data = r.data as string
    expect(data).toMatch(/^## E-0 — Reactor Trip/)
    expect(data).toContain('```mermaid')
    expect(data).toContain('Source: [E-0 — Reactor Trip')
    expect(data).toContain('https://samsinn-wikis.github.io/pwr-eops/procedures/E-0/')
  })

  test('unknown id → structured error with fuzzy suggestions', async () => {
    const tool = createProcedureLookupTool(BINDING, 'PWR EOPs', 'https://samsinn-wikis.github.io/pwr-eops/')
    const r = await tool.execute({ id: 'E-0X' }, ctx)
    expect(r.success).toBe(false)
    expect(r.error).toContain('E-0X')
    expect(r.error).toMatch(/(Did you mean|Available)/)
  })

  test('case-sensitive id lookup (wiki uses canonical ids)', async () => {
    const tool = createProcedureLookupTool(BINDING, 'PWR EOPs', 'https://samsinn-wikis.github.io/pwr-eops/')
    const r = await tool.execute({ id: 'e-0' }, ctx)  // lowercase
    expect(r.success).toBe(false)  // wiki ids are canonical-case
  })
})

describe('procedure_lookup — failure modes', () => {
  let restore: () => void
  afterEach(() => restore?.())

  test('GitHub 5xx on procedure fetch → structured error mentioning the id', async () => {
    restore = installFetchMock((url) => {
      if (url.endsWith('/wiki/index.md')) return new Response(fixture('index.md'), { status: 200 })
      return new Response('boom', { status: 503 })
    })
    const tool = createProcedureLookupTool(BINDING, 'PWR EOPs', 'https://samsinn-wikis.github.io/pwr-eops/')
    const r = await tool.execute({ id: 'E-0' }, ctx)
    expect(r.success).toBe(false)
    expect(r.error).toContain('E-0')
    expect(r.error).toMatch(/(HTTP 503|fetch)/)
  })

  test('GitHub error on index fetch → user-facing message names the wiki', async () => {
    restore = installFetchMock(() => new Response('', { status: 503 }))
    const tool = createProcedureLookupTool(BINDING, 'PWR EOPs', 'https://samsinn-wikis.github.io/pwr-eops/')
    const r = await tool.execute({}, ctx)
    expect(r.success).toBe(false)
    expect(r.error).toContain('PWR EOPs')
  })
})
