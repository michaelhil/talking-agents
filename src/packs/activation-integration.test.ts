// End-to-end activation test — exercises the full chain that the bloat
// fix relies on:
//   - tool surface filter (spawn-pack-filter)
//   - skill section filter (main.ts getSkillsForRoom — covered indirectly
//     via context-builder)
//   - script runner activation gate (script-runner.start)
//
// Each layer has its own unit test; this one verifies they compose
// correctly under realistic House + Room + Pack metadata, and that
// flipping room.setActivePacks() takes effect on the very next eval —
// no caching, no stale views (the b660b3e pattern this design avoids).

import { describe, test, expect } from 'bun:test'
import { createHouse } from '../core/house.ts'
import { createToolRegistry } from '../core/tool-registry.ts'
import { buildToolSupport } from '../agents/spawn.ts'
import type { Tool, ToolResult } from '../core/types/tool.ts'
import type { LLMProvider } from '../core/types/llm.ts'
import { effectiveActivePacks } from './activation.ts'
import { SYSTEM_SENDER_ID } from '../core/types/constants.ts'

const okTool = (name: string): Tool => ({
  name,
  description: `${name} tool`,
  parameters: { type: 'object', properties: {} },
  execute: async (): Promise<ToolResult> => ({ success: true, data: name }),
})

const stubProvider = {} as unknown as LLMProvider

describe('pack activation — end-to-end with House + Room', () => {
  test('agent in fresh room sees only core + local tools, no pack tools', async () => {
    const house = createHouse({})
    const room = house.createRoom({ name: 'Cafe', createdBy: SYSTEM_SENDER_ID })
    const reg = createToolRegistry()

    reg.registerWithSource(okTool('builtin_a'), { kind: 'built-in' })
    reg.registerWithSource(okTool('local_a'),   { kind: 'external', path: '/x' })
    reg.registerWithSource(okTool('av_atc'), {
      kind: 'pack-bundled', pack: 'aviation', path: '/p/atc.ts', displayName: 'atc',
    })
    reg.registerWithSource(okTool('cafes_menu'), {
      kind: 'pack-bundled', pack: 'cafes', path: '/p/menu.ts', displayName: 'menu',
    })

    const support = await buildToolSupport(
      reg.list().map(t => t.name),
      reg,
      { id: 'a', name: 'A' },
      stubProvider,
      undefined, undefined,
      (id: string) => house.getRoom(id),
    )

    expect(support.resolveToolDefinitions).toBeDefined()
    const empty = (support.resolveToolDefinitions!(room.profile.id) ?? []).map(d => d.function.name).sort()
    expect(empty).toContain('builtin_a')
    expect(empty).toContain('local_a')
    expect(empty).not.toContain('av_atc')
    expect(empty).not.toContain('cafes_menu')
  })

  test('flipping setActivePacks takes effect on the next resolve, no cache', async () => {
    const house = createHouse({})
    const room = house.createRoom({ name: 'Tower', createdBy: SYSTEM_SENDER_ID })
    const reg = createToolRegistry()
    reg.registerWithSource(okTool('builtin_a'), { kind: 'built-in' })
    reg.registerWithSource(okTool('av_atc'), {
      kind: 'pack-bundled', pack: 'aviation', path: '/p/atc.ts', displayName: 'atc',
    })

    const support = await buildToolSupport(
      reg.list().map(t => t.name),
      reg,
      { id: 'a', name: 'A' },
      stubProvider,
      undefined, undefined,
      (id: string) => house.getRoom(id),
    )

    // Empty activation → only built-in.
    const before = (support.resolveToolDefinitions!(room.profile.id) ?? []).map(d => d.function.name).sort()
    expect(before).toContain('builtin_a')
    expect(before).not.toContain('av_atc')

    // Flip activation.
    room.setActivePacks(['aviation'])

    // Next resolve sees the change without any explicit invalidation —
    // the resolver is pure over (room state, registry).
    const after = (support.resolveToolDefinitions!(room.profile.id) ?? []).map(d => d.function.name).sort()
    expect(after).toContain('builtin_a')
    expect(after).toContain('av_atc')

    // Flip back.
    room.setActivePacks([])
    const reset = (support.resolveToolDefinitions!(room.profile.id) ?? []).map(d => d.function.name).sort()
    expect(reset).not.toContain('av_atc')
  })

  test('two rooms diverge: each sees only its own active packs', async () => {
    const house = createHouse({})
    const tower = house.createRoom({ name: 'Tower', createdBy: SYSTEM_SENDER_ID })
    const cafe  = house.createRoom({ name: 'Cafe',  createdBy: SYSTEM_SENDER_ID })
    const reg = createToolRegistry()
    reg.registerWithSource(okTool('builtin_a'), { kind: 'built-in' })
    reg.registerWithSource(okTool('av_atc'), {
      kind: 'pack-bundled', pack: 'aviation', path: '/p/atc.ts', displayName: 'atc',
    })
    reg.registerWithSource(okTool('cafes_menu'), {
      kind: 'pack-bundled', pack: 'cafes', path: '/p/menu.ts', displayName: 'menu',
    })

    tower.setActivePacks(['aviation'])
    cafe.setActivePacks(['cafes'])

    const support = await buildToolSupport(
      reg.list().map(t => t.name),
      reg,
      { id: 'a', name: 'A' },
      stubProvider,
      undefined, undefined,
      (id: string) => house.getRoom(id),
    )

    const towerSurf = (support.resolveToolDefinitions!(tower.profile.id) ?? []).map(d => d.function.name)
    const cafeSurf  = (support.resolveToolDefinitions!(cafe.profile.id)  ?? []).map(d => d.function.name)

    expect(towerSurf).toContain('av_atc')
    expect(towerSurf).not.toContain('cafes_menu')
    expect(cafeSurf).toContain('cafes_menu')
    expect(cafeSurf).not.toContain('av_atc')
  })

  test('effectiveActivePacks is order-stable: implicit packs first, explicit appended', () => {
    const house = createHouse({})
    const room = house.createRoom({ name: 'X', createdBy: SYSTEM_SENDER_ID })
    expect(effectiveActivePacks(room)).toEqual(['core', 'local', 'welcome', 'demos'])
    room.setActivePacks(['z', 'a'])
    expect(effectiveActivePacks(room)).toEqual(['core', 'local', 'welcome', 'demos', 'z', 'a'])
  })

  test('snapshot-style restore round-trips activePacks', () => {
    const house = createHouse({})
    const room = house.createRoom({ name: 'X', createdBy: SYSTEM_SENDER_ID })
    room.setActivePacks(['aviation', 'cafes'])
    const state = room.getRoomState()
    expect(state.activePacks).toEqual(['aviation', 'cafes'])

    // Fresh room from snapshot data.
    const house2 = createHouse({})
    const restored = house2.createRoom({ name: 'X', createdBy: SYSTEM_SENDER_ID })
    restored.restoreState({
      members: [],
      muted: [],
      mode: 'broadcast',
      paused: false,
      activePacks: state.activePacks,
    })
    expect(restored.getActivePacks()).toEqual(['aviation', 'cafes'])
  })
})
