// Verifies the pack-aware tool surface filter — the structural fix for
// tool-context bloat. An agent in a room with no activated packs sees only
// 'core' (built-in) and 'local' (external) tools; activating a pack adds
// only its own tools.

import { describe, expect, test } from 'bun:test'
import { buildToolSupport } from './spawn.ts'
import { createToolRegistry } from '../core/tool-registry.ts'
import type { Tool, ToolResult } from '../core/types/tool.ts'
import type { LLMProvider } from '../core/types/llm.ts'

const okTool = (name: string): Tool => ({
  name,
  description: `${name} tool`,
  parameters: { type: 'object', properties: {} },
  execute: async (): Promise<ToolResult> => ({ success: true, data: name }),
})

// Provider isn't actually exercised — buildToolSupport just threads it into
// the lazy ToolContext for sub-LLM calls inside tool execute().
const stubProvider = {} as unknown as LLMProvider

const makeRoom = (activePacks: string[]) => ({ getActivePacks: () => activePacks })

describe('pack-aware tool surface filter', () => {
  test('with no activation, agent sees core (built-in) + local (external) only', async () => {
    const registry = createToolRegistry()
    registry.registerWithSource(okTool('core_tool'), { kind: 'built-in' })
    registry.registerWithSource(okTool('local_tool'), { kind: 'external', path: '/x.ts' })
    registry.registerWithSource(okTool('aviation_atc'), {
      kind: 'pack-bundled', pack: 'aviation', path: '/p/atc.ts', displayName: 'atc',
    })
    registry.registerWithSource(okTool('cafes_menu'), {
      kind: 'pack-bundled', pack: 'cafes', path: '/p/menu.ts', displayName: 'menu',
    })

    const support = await buildToolSupport(
      registry.list().map(t => t.name),
      registry,
      { id: 'a', name: 'Alice' },
      stubProvider,
      undefined, undefined,
      (roomId) => roomId === 'r1' ? makeRoom([]) : undefined,
    )

    expect(support.resolveToolDefinitions).toBeDefined()
    const defs = support.resolveToolDefinitions!('r1')
    expect(defs).not.toBeNull()
    const names = (defs ?? []).map(d => d.function.name).sort()
    // 'pass' is auto-injected as kind='built-in', so it shows up in core too.
    expect(names).toContain('core_tool')
    expect(names).toContain('local_tool')
    expect(names).not.toContain('aviation_atc')
    expect(names).not.toContain('cafes_menu')
  })

  test('activating a pack exposes only that pack', async () => {
    const registry = createToolRegistry()
    registry.registerWithSource(okTool('core_tool'), { kind: 'built-in' })
    registry.registerWithSource(okTool('aviation_atc'), {
      kind: 'pack-bundled', pack: 'aviation', path: '/p/atc.ts', displayName: 'atc',
    })
    registry.registerWithSource(okTool('cafes_menu'), {
      kind: 'pack-bundled', pack: 'cafes', path: '/p/menu.ts', displayName: 'menu',
    })

    const support = await buildToolSupport(
      registry.list().map(t => t.name),
      registry,
      { id: 'a', name: 'Alice' },
      stubProvider,
      undefined, undefined,
      (roomId) => roomId === 'tower' ? makeRoom(['aviation']) : undefined,
    )

    const defs = support.resolveToolDefinitions!('tower')
    const names = (defs ?? []).map(d => d.function.name)
    expect(names).toContain('core_tool')
    expect(names).toContain('aviation_atc')
    expect(names).not.toContain('cafes_menu')
  })

  test('unknown room → resolver returns null (caller falls back to static)', async () => {
    const registry = createToolRegistry()
    registry.registerWithSource(okTool('core_tool'), { kind: 'built-in' })

    const support = await buildToolSupport(
      registry.list().map(t => t.name),
      registry,
      { id: 'a', name: 'Alice' },
      stubProvider,
      undefined, undefined,
      () => undefined,
    )

    expect(support.resolveToolDefinitions!('does-not-exist')).toBeNull()
  })

  test('without getRoomActivation, support has no resolver (legacy behavior)', async () => {
    const registry = createToolRegistry()
    registry.registerWithSource(okTool('core_tool'), { kind: 'built-in' })

    const support = await buildToolSupport(
      ['core_tool'],
      registry,
      { id: 'a', name: 'Alice' },
      stubProvider,
    )
    expect(support.resolveToolDefinitions).toBeUndefined()
    // toolDefinitions still set — the maximal set the agent was spawned with.
    expect(support.toolDefinitions?.length).toBeGreaterThan(0)
  })
})
