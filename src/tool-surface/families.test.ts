// Pure unit tests for family compression. Real ToolRegistry instances,
// real Tool definitions — no mocks (per feedback_no_mocks.md).

import { describe, expect, test } from 'bun:test'
import { createToolRegistry } from '../core/tool-registry.ts'
import type { Tool } from '../core/types/tool.ts'
import {
  BUILT_IN_FAMILIES,
  ENUM_MAX_MEMBERS,
  compressFamilies,
  createFamilyDispatcher,
  createFamilyDispatcherTrampoline,
  resolveFamilyMembers,
} from './families.ts'

const tool = (name: string, description = `description for ${name}`): Tool => ({
  name,
  description,
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  execute: async (params, _ctx) => ({ success: true, data: { echo: params } }),
})

describe('compressFamilies', () => {
  test('compresses filesystem family when ≥ minMembers present', () => {
    const r = createToolRegistry()
    r.register(tool('filesystem__read_file'))
    r.register(tool('filesystem__write_file'))
    r.register(tool('filesystem__list_directory'))
    r.register(tool('filesystem__search_files'))
    r.register(tool('pass'))      // unrelated — should pass through

    const all = new Set(['filesystem__read_file', 'filesystem__write_file', 'filesystem__list_directory', 'filesystem__search_files', 'pass'])
    const { dispatchers, absorbedNames, passthroughEntries } = compressFamilies(r, all)

    expect(dispatchers.length).toBe(1)
    expect(dispatchers[0]!.name).toBe('fs')
    expect(absorbedNames.size).toBe(4)
    expect(passthroughEntries.map(e => e.tool.name)).toEqual(['pass'])
  })

  test('skips family below minMembers', () => {
    const r = createToolRegistry()
    // Only 2 filesystem tools — minMembers is 3 → no dispatcher
    r.register(tool('filesystem__read_file'))
    r.register(tool('filesystem__write_file'))
    const all = new Set(['filesystem__read_file', 'filesystem__write_file'])
    const { dispatchers, absorbedNames, passthroughEntries } = compressFamilies(r, all)

    expect(dispatchers.length).toBe(0)
    expect(absorbedNames.size).toBe(0)
    expect(passthroughEntries.length).toBe(2)
  })

  test('respects candidate filter — absent tools do not contribute', () => {
    const r = createToolRegistry()
    r.register(tool('filesystem__read_file'))
    r.register(tool('filesystem__write_file'))
    r.register(tool('filesystem__list_directory'))
    // Only 2 of 3 in the candidate set → below minMembers
    const candidates = new Set(['filesystem__read_file', 'filesystem__write_file'])
    const { dispatchers } = compressFamilies(r, candidates)
    expect(dispatchers.length).toBe(0)
  })

  test('multiple families compress independently', () => {
    const r = createToolRegistry()
    for (const n of ['filesystem__a', 'filesystem__b', 'filesystem__c']) r.register(tool(n))
    for (const n of ['geo_lookup', 'geo_add', 'geo_remove']) r.register(tool(n))
    r.register(tool('pass'))

    const all = new Set(r.list().map(t => t.name))
    const { dispatchers, absorbedNames } = compressFamilies(r, all)

    expect(new Set(dispatchers.map(d => d.name))).toEqual(new Set(['fs', 'geo_tools']))
    expect(absorbedNames.size).toBe(6)
  })
})

describe('createFamilyDispatcher', () => {
  test('routes subcommand to underlying tool execute()', async () => {
    const r = createToolRegistry()
    r.register(tool('filesystem__read_file'))
    r.register(tool('filesystem__write_file'))
    r.register(tool('filesystem__list_directory'))
    const all = new Set(r.list().map(t => t.name))
    const family = BUILT_IN_FAMILIES.find(f => f.name === 'fs')!
    const members = r.listEntries().filter(e => family.match(e))
    const dispatcher = createFamilyDispatcher(family, members)

    const ctx = { callerId: 'test', callerName: 'Test' }
    const result = await dispatcher.execute(
      { subcommand: 'read_file', args: { path: '/tmp/x' } },
      ctx,
    )
    expect(result.success).toBe(true)
    expect((result.data as { echo: Record<string, unknown> }).echo).toEqual({ path: '/tmp/x' })
    void all
  })

  test('rejects unknown subcommand with helpful error', async () => {
    const r = createToolRegistry()
    for (const n of ['filesystem__a', 'filesystem__b', 'filesystem__c']) r.register(tool(n))
    const family = BUILT_IN_FAMILIES.find(f => f.name === 'fs')!
    const members = r.listEntries().filter(e => family.match(e))
    const dispatcher = createFamilyDispatcher(family, members)

    const ctx = { callerId: 'test', callerName: 'Test' }
    const result = await dispatcher.execute({ subcommand: 'nope', args: {} }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('unknown subcommand "nope"')
    expect(result.error).toContain('a, b, c')
  })

  test('rejects missing subcommand', async () => {
    const r = createToolRegistry()
    for (const n of ['filesystem__a', 'filesystem__b', 'filesystem__c']) r.register(tool(n))
    const family = BUILT_IN_FAMILIES.find(f => f.name === 'fs')!
    const dispatcher = createFamilyDispatcher(family, r.listEntries().filter(e => family.match(e)))
    const result = await dispatcher.execute({ args: {} }, { callerId: 't', callerName: 'T' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('missing required `subcommand`')
  })

  test('uses enum schema when members ≤ ENUM_MAX_MEMBERS', () => {
    const r = createToolRegistry()
    for (let i = 0; i < 5; i++) r.register(tool(`filesystem__t${i}`))
    const family = BUILT_IN_FAMILIES.find(f => f.name === 'fs')!
    const dispatcher = createFamilyDispatcher(family, r.listEntries().filter(e => family.match(e)))
    const params = dispatcher.parameters as { properties: { subcommand: Record<string, unknown> } }
    expect(params.properties.subcommand).toHaveProperty('enum')
    expect(Array.isArray((params.properties.subcommand as { enum?: unknown[] }).enum)).toBe(true)
  })

  test('uses string-with-description when members > ENUM_MAX_MEMBERS', () => {
    const r = createToolRegistry()
    for (let i = 0; i < ENUM_MAX_MEMBERS + 5; i++) r.register(tool(`filesystem__t${i}`))
    const family = BUILT_IN_FAMILIES.find(f => f.name === 'fs')!
    const dispatcher = createFamilyDispatcher(family, r.listEntries().filter(e => family.match(e)))
    const params = dispatcher.parameters as { properties: { subcommand: Record<string, unknown> } }
    expect(params.properties.subcommand).not.toHaveProperty('enum')
    expect(params.properties.subcommand.type).toBe('string')
    expect((params.properties.subcommand.description as string)).toContain('One of:')
  })

  test('preserves ToolContext when forwarding to underlying tool', async () => {
    let receivedCallerId = ''
    const probeTool: Tool = {
      name: 'filesystem__probe',
      description: 'probe',
      parameters: { type: 'object', properties: {} },
      execute: async (_p, ctx) => {
        receivedCallerId = ctx.callerId
        return { success: true }
      },
    }
    const r = createToolRegistry()
    r.register(probeTool)
    r.register(tool('filesystem__a'))
    r.register(tool('filesystem__b'))
    const family = BUILT_IN_FAMILIES.find(f => f.name === 'fs')!
    const dispatcher = createFamilyDispatcher(family, r.listEntries().filter(e => family.match(e)))

    await dispatcher.execute(
      { subcommand: 'probe', args: {} },
      { callerId: 'agent-X', callerName: 'X' },
    )
    expect(receivedCallerId).toBe('agent-X')
  })
})

describe('createFamilyDispatcherTrampoline (late binding)', () => {
  const ctx = { callerId: 'test', callerName: 'Test' }
  const family = BUILT_IN_FAMILIES.find(f => f.name === 'geo_tools')!

  test('routes to a member added to the registry AFTER trampoline creation', async () => {
    // The bug this fixes: pre-trampoline, the dispatcher captured a
    // memberMap at registration time. Members added later were
    // advertised by the (per-projection) LLM-facing dispatcher but the
    // executor's registry.get() returned the stale closure → "unknown
    // subcommand" for the new member.
    const r = createToolRegistry()
    r.register(tool('geo_lookup'))
    r.register(tool('geo_add'))
    r.register(tool('geo_remove'))
    const dispatcher = createFamilyDispatcherTrampoline(family, r)

    // Add a new family member AFTER the trampoline exists.
    r.register(tool('geo_list_categories'))

    const result = await dispatcher.execute(
      { subcommand: 'list_categories', args: { path: '/x' } },
      ctx,
    )
    expect(result.success).toBe(true)
  })

  test('returns "family disabled" when member count drops below minMembers', async () => {
    // User-answered behaviour: an LLM that cached the family name from a
    // prior turn could still call it after a pack uninstall. The
    // trampoline returns a coherent refusal rather than routing into a
    // degenerate state.
    const r = createToolRegistry()
    r.register(tool('geo_lookup'))
    r.register(tool('geo_add'))
    r.register(tool('geo_remove'))
    const dispatcher = createFamilyDispatcherTrampoline(family, r)

    // Drop two members → only 1 remains, below minMembers (3).
    r.unregister('geo_add')
    r.unregister('geo_remove')

    const result = await dispatcher.execute(
      { subcommand: 'lookup', args: { path: '/x' } },
      ctx,
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('family disabled')
    expect(result.error).toContain('1 of 3')
  })

  test('returns unknown subcommand with current-valid list (not stale)', async () => {
    const r = createToolRegistry()
    r.register(tool('geo_lookup'))
    r.register(tool('geo_add'))
    r.register(tool('geo_remove'))
    const dispatcher = createFamilyDispatcherTrampoline(family, r)

    // Add a member; the error message should include it as a valid name.
    r.register(tool('geo_list_categories'))

    const result = await dispatcher.execute(
      { subcommand: 'nope', args: {} },
      ctx,
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('unknown subcommand "nope"')
    expect(result.error).toContain('list_categories')
  })

  test('rejects missing subcommand parameter', async () => {
    const r = createToolRegistry()
    for (const n of ['geo_lookup', 'geo_add', 'geo_remove']) r.register(tool(n))
    const dispatcher = createFamilyDispatcherTrampoline(family, r)
    const result = await dispatcher.execute({ args: {} }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('missing required `subcommand`')
  })

  test('forwards ToolContext to the routed member', async () => {
    let receivedCallerId = ''
    const probeTool: Tool = {
      name: 'geo_lookup',
      description: 'probe',
      parameters: { type: 'object', properties: {} },
      execute: async (_p, c) => { receivedCallerId = c.callerId; return { success: true } },
    }
    const r = createToolRegistry()
    r.register(probeTool)
    r.register(tool('geo_add'))
    r.register(tool('geo_remove'))
    const dispatcher = createFamilyDispatcherTrampoline(family, r)

    await dispatcher.execute(
      { subcommand: 'lookup', args: {} },
      { callerId: 'agent-X', callerName: 'X' },
    )
    expect(receivedCallerId).toBe('agent-X')
  })
})

describe('resolveFamilyMembers', () => {
  test('returns one entry per family, regardless of member count', () => {
    const r = createToolRegistry()
    r.register(tool('filesystem__a'))
    r.register(tool('pass'))
    const all = new Set(r.list().map(t => t.name))
    const result = resolveFamilyMembers(r, BUILT_IN_FAMILIES, all)
    expect(result.length).toBe(BUILT_IN_FAMILIES.length)
    expect(result.find(r => r.family.name === 'fs')?.members.length).toBe(1)
  })
})
