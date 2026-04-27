// Per-turn allowed-tools enforcement at the tool executor.
// Skills are room-scoped; agents can be members of multiple rooms; therefore
// the whitelist must resolve per-call (using the executor's roomId arg) —
// not at agent-spawn time.

import { describe, test, expect } from 'bun:test'
import { __testSeam } from './spawn.ts'
import { createToolRegistry } from '../core/tool-registry.ts'
import type { Tool, ToolContext } from '../core/types/tool.ts'

const { createToolExecutor } = __testSeam

const mkTool = (name: string): Tool => ({
  name,
  description: `tool ${name}`,
  parameters: { type: 'object', properties: {} },
  execute: async () => ({ success: true, data: name }),
})

const baseCtx: ToolContext = { callerId: 'a', callerName: 'Alice' }

describe('createToolExecutor — per-room allowed-tools enforcement', () => {
  test('no resolver: agent can call any of its spawn-time tools (back-compat)', async () => {
    const reg = createToolRegistry()
    reg.register(mkTool('web_search'))
    reg.register(mkTool('web_fetch'))
    const exec = createToolExecutor(reg, ['web_search', 'web_fetch'], baseCtx)
    const results = await exec([{ tool: 'web_fetch', arguments: {} }], 'room-1')
    expect(results[0]!.success).toBe(true)
  })

  test('resolver returns null: unrestricted (back-compat)', async () => {
    const reg = createToolRegistry()
    reg.register(mkTool('web_fetch'))
    const exec = createToolExecutor(reg, ['web_fetch'], baseCtx, () => null)
    const results = await exec([{ tool: 'web_fetch', arguments: {} }], 'room-1')
    expect(results[0]!.success).toBe(true)
  })

  test('resolver returns whitelist: tool in whitelist runs', async () => {
    const reg = createToolRegistry()
    reg.register(mkTool('web_search'))
    reg.register(mkTool('web_fetch'))
    const exec = createToolExecutor(
      reg, ['web_search', 'web_fetch'], baseCtx,
      () => new Set(['web_search']),
    )
    const results = await exec([{ tool: 'web_search', arguments: {} }], 'room-1')
    expect(results[0]!.success).toBe(true)
  })

  test('resolver returns whitelist: tool NOT in whitelist is rejected with useful error', async () => {
    const reg = createToolRegistry()
    reg.register(mkTool('web_search'))
    reg.register(mkTool('web_fetch'))
    const exec = createToolExecutor(
      reg, ['web_search', 'web_fetch'], baseCtx,
      () => new Set(['web_search']),
    )
    const results = await exec([{ tool: 'web_fetch', arguments: {} }], 'room-1')
    expect(results[0]!.success).toBe(false)
    expect(results[0]!.error).toContain('not allowed by active skills')
    expect(results[0]!.error).toContain('Allowed: web_search')
  })

  test('pass tool is always permitted (agents must be able to decline)', async () => {
    const reg = createToolRegistry()
    reg.register(mkTool('pass'))
    reg.register(mkTool('web_search'))
    const exec = createToolExecutor(
      reg, ['pass', 'web_search'], baseCtx,
      () => new Set(['web_search']),  // whitelist EXCLUDES pass
    )
    const results = await exec([{ tool: 'pass', arguments: {} }], 'room-1')
    expect(results[0]!.success).toBe(true)
  })

  test('different rooms get different whitelists (per-call resolution)', async () => {
    const reg = createToolRegistry()
    reg.register(mkTool('web_search'))
    reg.register(mkTool('web_fetch'))
    const perRoom: Record<string, Set<string>> = {
      'room-A': new Set(['web_search']),
      'room-B': new Set(['web_fetch']),
    }
    const exec = createToolExecutor(
      reg, ['web_search', 'web_fetch'], baseCtx,
      (roomId) => perRoom[roomId] ?? null,
    )
    const a = await exec([{ tool: 'web_fetch', arguments: {} }], 'room-A')
    const b = await exec([{ tool: 'web_fetch', arguments: {} }], 'room-B')
    expect(a[0]!.success).toBe(false)  // not in room-A whitelist
    expect(b[0]!.success).toBe(true)   // in room-B whitelist
  })

  test('no roomId passed: skipped (resolver only fires when roomId present)', async () => {
    const reg = createToolRegistry()
    reg.register(mkTool('web_fetch'))
    let resolverCalled = false
    const exec = createToolExecutor(
      reg, ['web_fetch'], baseCtx,
      () => { resolverCalled = true; return new Set() },
    )
    const results = await exec([{ tool: 'web_fetch', arguments: {} }])  // no roomId
    expect(results[0]!.success).toBe(true)
    expect(resolverCalled).toBe(false)
  })

  test('tool not in spawn-time toolset is rejected before whitelist check', async () => {
    const reg = createToolRegistry()
    reg.register(mkTool('web_search'))
    const exec = createToolExecutor(
      reg, ['web_search'], baseCtx,  // agent does NOT have web_fetch
      () => new Set(['web_fetch']),  // whitelist would allow it, but it's not in spawn-time set
    )
    const results = await exec([{ tool: 'web_fetch', arguments: {} }], 'room-1')
    expect(results[0]!.success).toBe(false)
    expect(results[0]!.error).toContain('is not available')  // existing error message
  })
})
