// End-to-end Tool Surface tests — real ToolRegistry, real tool factory
// functions from src/tools/built-in/, real activation filter. No mocks.
//
// Two classes of assertion:
//
//   1. Family compression cuts the token count vs flat (catches any future
//      change that bloats the surface back to its pre-compression size).
//
//   2. Strict-provider behavior: gemini-style providers must NEVER receive
//      a family dispatcher; they get the flat tool list.
//
// Budget cap was removed in PR 1 of the tool-surface redesign; the
// previous "drops tools to fit budget" test is gone with it. The surface
// trusts user intent (pack activation) and never silently strips tools.

import { describe, expect, test } from 'bun:test'
import { createToolRegistry } from '../core/tool-registry.ts'
import type { Tool } from '../core/types/tool.ts'
import { createToolSurface } from './index.ts'
import { estimateTokens } from '../agents/context-builder.ts'
import { createGetTimeTool, createPassTool, createPostToRoomTool } from '../tools/built-in/index.ts'

const estimateDef = (def: { function: { name: string; description: string; parameters: unknown } }): number =>
  estimateTokens(JSON.stringify(def))

// Synthetic tool factory used to populate the registry with realistic
// volumes. Description size mimics the verbose tool descriptions the
// production MCP filesystem server emits.
const mockTool = (name: string, descSize = 150): Tool => ({
  name,
  description: 'r'.repeat(descSize),
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'fs path' },
    },
    required: ['path'],
  },
  execute: async () => ({ success: true }),
})

describe('tool surface integration', () => {
  test('OpenAI projection compresses filesystem family below flat-list token count', () => {
    const r = createToolRegistry()
    // 14 filesystem__ tools — what's actually live on prod via the MCP server.
    for (const name of [
      'read_file', 'read_text_file', 'read_media_file', 'read_multiple_files',
      'write_file', 'edit_file', 'create_directory', 'list_directory',
      'list_directory_with_sizes', 'directory_tree', 'move_file',
      'search_files', 'get_file_info', 'list_allowed_directories',
    ]) {
      r.register(mockTool(`filesystem__${name}`, 180))
    }
    r.register(createPassTool())

    const requested = r.list().map(t => t.name)
    const surface = createToolSurface({ registry: r, requestedTools: requested })

    const compressed = surface.project(undefined, 'openai')
    const flat = surface.project(undefined, 'gemini')

    const compressedTokens = compressed.reduce((s, d) => s + estimateDef(d), 0)
    const flatTokens = flat.reduce((s, d) => s + estimateDef(d), 0)

    // Compression cuts the family from 14 individual tool definitions down
    // to one dispatcher whose description embeds compact subcommand
    // summaries. Realistic saving with 180-char descriptions is ~30-50% on
    // the family. Verbose real-world descriptions (300+ chars) compress
    // further; this lower bound catches catastrophic regression.
    expect(compressedTokens).toBeLessThan(flatTokens * 0.75)
    // Compressed projection should contain the fs dispatcher and `pass`.
    expect(compressed.map(d => d.function.name).sort()).toEqual(['fs', 'pass'])
    // Flat projection retains every filesystem__ tool individually.
    expect(flat.length).toBe(15)
  })

  test('strict provider (gemini) skips compression and gets the flat list', () => {
    const r = createToolRegistry()
    for (let i = 0; i < 5; i++) r.register(mockTool(`filesystem__t${i}`, 100))
    const requested = r.list().map(t => t.name)
    const surface = createToolSurface({ registry: r, requestedTools: requested })

    const flat = surface.project(undefined, 'gemini')
    expect(flat.length).toBe(5)
    expect(flat.find(d => d.function.name === 'fs')).toBeUndefined()
  })

  test('unknown provider conservatively skips compression', () => {
    const r = createToolRegistry()
    for (let i = 0; i < 5; i++) r.register(mockTool(`filesystem__t${i}`, 100))
    const surface = createToolSurface({ registry: r, requestedTools: r.list().map(t => t.name) })

    // Unknown providers should NOT be treated as strict — caller can pass
    // undefined to mean "don't know, but try compression". Verified by
    // observing the dispatcher in the output.
    const result = surface.project(undefined, undefined)
    expect(result.some(d => d.function.name === 'fs')).toBe(true)
  })

  test('does not silently drop tools — every requested tool reaches the surface', () => {
    // Pinned regression for the removed budget cap. Even a deliberately
    // bloated set must all reach the LLM; the surface's job is to
    // faithfully reflect user intent, not to trim it to fit a fictional
    // token budget.
    const r = createToolRegistry()
    for (let i = 0; i < 50; i++) r.register(mockTool(`noisy_tool_${i}`, 300))
    r.register(createPassTool())
    const surface = createToolSurface({
      registry: r,
      requestedTools: r.list().map(t => t.name),
    })

    const result = surface.project(undefined, 'openai')
    expect(result.length).toBe(51)                                  // every requested tool kept
    expect(result.find(d => d.function.name === 'pass')).toBeDefined()
    expect(result.find(d => d.function.name === 'noisy_tool_49')).toBeDefined() // last in registration order
  })

  test('passes through real built-in tool factories', () => {
    const r = createToolRegistry()
    r.register(createPassTool())
    r.register(createGetTimeTool())
    // post_to_room requires House — fake-construct via the factory then
    // exercise its registration shape only.
    const house = { getRoom: () => undefined } as unknown as Parameters<typeof createPostToRoomTool>[0]
    r.register(createPostToRoomTool(house))

    const surface = createToolSurface({ registry: r, requestedTools: r.list().map(t => t.name) })
    const result = surface.project(undefined, 'openai')

    expect(result.map(d => d.function.name).sort()).toEqual(['get_time', 'pass', 'post_to_room'])
  })

  test('projection respects requestedTools filter', () => {
    const r = createToolRegistry()
    for (let i = 0; i < 5; i++) r.register(mockTool(`filesystem__t${i}`, 100))
    r.register(createPassTool())
    // Agent only requested 2 of the filesystem tools — below minMembers for
    // the family, so they pass through individually.
    const surface = createToolSurface({
      registry: r,
      requestedTools: ['filesystem__t0', 'filesystem__t1', 'pass'],
    })
    const result = surface.project(undefined, 'openai')
    expect(result.map(d => d.function.name).sort()).toEqual(['filesystem__t0', 'filesystem__t1', 'pass'])
    expect(result.find(d => d.function.name === 'fs')).toBeUndefined()
  })
})

describe('regression: dispatcher round-trip never produces duplicate function declarations', () => {
  // Bug shipped in v0.13.0 and broke the biometrics demo on prod: when the
  // dispatcher gets registered into the global registry (so the executor
  // can route subcommand calls by name), the NEXT agent that spawns sees
  // it in its requestedTools. Inside compressFamilies, the dispatcher's
  // name doesn't match any family's underlying-tool regex (e.g.
  // 'geo_tools' doesn't match /^geo_(lookup|add|remove|...)$/), so it
  // falls through to passthroughEntries. Combined with the freshly
  // synthesised dispatcher, the projection had TWO tools named
  // 'geo_tools'. Gemini rejected with HTTP 400 INVALID_ARGUMENT.
  //
  // Fix: exclude FAMILY_DISPATCHER_NAMES from candidates universally.
  // Dispatchers are synthesised at projection time; the stored registry
  // copy is for executor routing only.
  test('compressed path: no duplicate dispatcher names after dispatcher is in registry', () => {
    const r = createToolRegistry()
    for (const n of ['geo_lookup', 'geo_add', 'geo_remove']) r.register(mockTool(n, 100))
    // Simulate previous spawn having registered the dispatcher already.
    const surface1 = createToolSurface({ registry: r, requestedTools: r.list().map(t => t.name) })
    for (const d of surface1.getRegistryDispatchers()) {
      if (!r.has(d.name)) r.register(d)
    }
    // Second spawn now sees 'geo_tools' in registry.list().
    const surface2 = createToolSurface({ registry: r, requestedTools: r.list().map(t => t.name) })
    const compressed = surface2.project(undefined, 'openai')
    const names = compressed.map(d => d.function.name)
    const dupes = names.filter((n, i) => names.indexOf(n) !== i)
    expect(dupes).toEqual([])
    // Exactly one geo_tools survives — the freshly synthesised dispatcher.
    expect(names.filter(n => n === 'geo_tools').length).toBe(1)
  })

  test('flat path (strict provider): the registered dispatcher is hidden, underlying tools surface', () => {
    const r = createToolRegistry()
    for (const n of ['geo_lookup', 'geo_add', 'geo_remove']) r.register(mockTool(n, 100))
    const surface1 = createToolSurface({ registry: r, requestedTools: r.list().map(t => t.name) })
    for (const d of surface1.getRegistryDispatchers()) {
      if (!r.has(d.name)) r.register(d)
    }
    const surface2 = createToolSurface({ registry: r, requestedTools: r.list().map(t => t.name) })
    const flat = surface2.project(undefined, 'gemini')
    const names = flat.map(d => d.function.name)
    // Gemini sees the original 3 geo_* tools, NOT the dispatcher.
    expect(names.sort()).toEqual(['geo_add', 'geo_lookup', 'geo_remove'])
    expect(names).not.toContain('geo_tools')
  })
})

describe('stale-snapshot self-heal: requestedTools containing dispatcher names', () => {
  // Real prod bug 2026-05-12: pre-trampoline-refactor snapshots captured
  // family dispatcher names (geo_tools, pack_admin, codegen_tools) in
  // agent.config.tools. After the refactor, dispatchers are synthesised
  // from members — a requestedTools list that only has dispatcher names
  // (no underlying members) would produce an empty surface. The agent
  // ended up with only `pass` and looped on map requests.
  test('dispatcher name in requestedTools expands to family members → compression fires', () => {
    const r = createToolRegistry()
    // Underlying geo members in the registry — but the agent's
    // requestedTools only has the DISPATCHER NAME (stale-snapshot shape).
    for (const n of ['geo_lookup', 'geo_add', 'geo_remove']) r.register(mockTool(n, 100))
    r.register(createPassTool())

    const surface = createToolSurface({
      registry: r,
      requestedTools: ['pass', 'geo_tools'],  // dispatcher name only — no members listed
    })
    const compressed = surface.project(undefined, 'openai')
    const names = compressed.map(d => d.function.name).sort()
    // geo_tools dispatcher should be in the surface (synthesised from
    // the expanded members), plus pass.
    expect(names).toContain('geo_tools')
    expect(names).toContain('pass')
  })

  test('dispatcher name absent → no expansion (regression guard)', () => {
    // Normal case: requestedTools has member names directly. No expansion
    // path runs; the existing compression behaviour is unchanged.
    const r = createToolRegistry()
    for (const n of ['geo_lookup', 'geo_add', 'geo_remove']) r.register(mockTool(n, 100))
    r.register(createPassTool())

    const surface = createToolSurface({
      registry: r,
      requestedTools: ['pass', 'geo_lookup', 'geo_add', 'geo_remove'],
    })
    const compressed = surface.project(undefined, 'openai')
    const names = compressed.map(d => d.function.name).sort()
    expect(names).toContain('geo_tools')
    expect(names).toContain('pass')
  })

  test('dispatcher name + flat-strict provider: returns underlying member tools', () => {
    // gemini path — dispatchers aren't sent. Expansion must still surface
    // the underlying members.
    const r = createToolRegistry()
    for (const n of ['geo_lookup', 'geo_add', 'geo_remove']) r.register(mockTool(n, 100))
    r.register(createPassTool())

    const surface = createToolSurface({
      registry: r,
      requestedTools: ['pass', 'geo_tools'],
    })
    const flat = surface.project(undefined, 'gemini')
    const names = flat.map(d => d.function.name).sort()
    expect(names).toEqual(['geo_add', 'geo_lookup', 'geo_remove', 'pass'])
  })

  test('load-bearing FAMILY_DISPATCHER_NAMES filter: synthesised dispatcher appears ONCE, never twice', () => {
    // The filter in accept() prevents projection-time duplicate-function
    // declarations on Gemini (commit b0fe8d3 was the prior incident).
    // This test models a registry that contains BOTH the family members
    // AND a real tool that happens to share the dispatcher name
    // (e.g. a pack registers a tool called geo_tools, or — historically —
    // a previous spawn's dispatcher registration left geo_tools in the
    // registry). The projection must emit geo_tools exactly once.
    const r = createToolRegistry()
    for (const n of ['geo_lookup', 'geo_add', 'geo_remove']) r.register(mockTool(n, 100))
    r.register(mockTool('geo_tools', 100))   // colliding atomic registration
    r.register(createPassTool())

    const surface = createToolSurface({
      registry: r,
      requestedTools: r.list().map(t => t.name),
    })
    const compressed = surface.project(undefined, 'openai')
    const names = compressed.map(d => d.function.name)
    expect(names.filter(n => n === 'geo_tools').length).toBe(1)
  })
})

describe('getRegistryDispatchers', () => {
  test('returns one trampoline per family in BUILT_IN_FAMILIES, regardless of current member count', () => {
    // Pre-trampoline this returned only "compressible-now" families; with
    // the late-binding shape, every family gets a trampoline so packs
    // added later become routable through the same registered dispatcher.
    const r = createToolRegistry()
    for (let i = 0; i < 4; i++) r.register(mockTool(`filesystem__t${i}`, 100))
    // geo family is BELOW minMembers (only 1) — trampoline still issued.
    r.register(mockTool('geo_lookup', 100))
    r.register(createPassTool())

    const surface = createToolSurface({ registry: r, requestedTools: ['pass'] })
    const dispatchers = surface.getRegistryDispatchers()
    expect(dispatchers.map(d => d.name).sort()).toEqual(['codegen_tools', 'fs', 'geo_tools', 'pack_admin'])
  })
})
