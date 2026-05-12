// Regression test for the 2026-05-12 removal of skill-level `allowed-tools`
// runtime enforcement.
//
// The deleted code (spawn.ts createToolExecutor's skillWhitelist branch)
// took the union of `allowed-tools` across in-scope skills and BLOCKED
// tool calls that weren't in that union. This contradicted README.md's
// documented "metadata-only" semantic for skill `allowed-tools` and
// produced silent tool_loop_exceeded errors in rooms with restrictively-
// declared skills (real prod incident: biometric-awareness skill active
// in Cafe room → agent's map-rendering tools rejected → 5-iteration loop).
//
// New semantic: tool access is gated by (a) agent's spawn-time
// `allowedTools` list and (b) per-room pack activation. Skill metadata
// is not consulted by the executor.
//
// This file locks that contract. If a future change re-introduces a
// skill-level executor gate, these tests fail.

import { describe, expect, test } from 'bun:test'
import { __testSeam } from './spawn.ts'
import { createToolRegistry } from '../core/tool-registry.ts'
import type { Tool, ToolContext } from '../core/types/tool.ts'

const { createToolExecutor } = __testSeam

const mockTool = (name: string): Tool => ({
  name,
  description: `desc for ${name}`,
  parameters: { type: 'object', properties: {} },
  execute: async () => ({ success: true, data: { called: name } }),
})

const fakeContext: ToolContext = { callerId: 'a-1', callerName: 'TestAgent' }

describe('executor: skill `allowed-tools` is no longer a runtime gate', () => {
  test('tool calls are NOT gated by any skill whitelist — pack activation alone decides', async () => {
    // Repros the Cafe-room incident: a skill declared a narrow tool list
    // and the executor blocked everything else. With the new semantic the
    // executor consults only (allowedTools ∪ pack-activation) — skill
    // metadata is irrelevant.
    const registry = createToolRegistry()
    registry.register(mockTool('biometrics_start'))
    registry.register(mockTool('geo_list_features'))

    // Pack activation surfaces both tools (core/local implicit).
    const getRoomActivation = (roomId: string) =>
      roomId === 'room-cafe' ? { getActivePacks: () => [] } : undefined

    const executor = createToolExecutor(
      registry,
      ['biometrics_start', 'geo_list_features'],   // agent's spawn-time list
      fakeContext,
      getRoomActivation,
    )

    // Call geo_list_features. Pre-fix this would have been blocked if a
    // skill in scope declared allowed-tools: [biometrics_start, ...] — now
    // no such gate exists.
    const results = await executor(
      [{ tool: 'geo_list_features', arguments: {} }],
      'room-cafe',
    )
    expect(results[0]!.success).toBe(true)
  })

  test('agent allowlist still gates: tool not in allowedTools and not pack-active → rejected', async () => {
    // Regression guard for the OTHER gate. Removing the skill whitelist
    // must NOT loosen the agent's own allowed-tools list.
    const registry = createToolRegistry()
    registry.register(mockTool('pass'))
    registry.register(mockTool('forbidden_tool'))

    const executor = createToolExecutor(
      registry,
      ['pass'],                                     // forbidden_tool NOT here
      fakeContext,
      () => undefined,                              // no pack activation
    )

    const results = await executor(
      [{ tool: 'forbidden_tool', arguments: {} }],
      'room-x',
    )
    expect(results[0]!.success).toBe(false)
    expect(results[0]!.error).toContain('is not available')
  })

  test('pack-activation gate still works: pack-tool callable in active room, not in inactive', async () => {
    // Defends the second gate (pack activation). The skill removal must
    // not weaken this either.
    const registry = createToolRegistry()
    registry.registerWithSource(mockTool('aviation_lookup'), { kind: 'pack-bundled', pack: 'aviation' })

    const getRoomActivation = (roomId: string) =>
      roomId === 'room-active' ? { getActivePacks: () => ['aviation'] }
        : roomId === 'room-inactive' ? { getActivePacks: () => [] }
          : undefined

    const executor = createToolExecutor(
      registry,
      [],                                           // not in agent's spawn-time list
      fakeContext,
      getRoomActivation,
    )

    const activeRoom = await executor([{ tool: 'aviation_lookup', arguments: {} }], 'room-active')
    expect(activeRoom[0]!.success).toBe(true)

    const inactiveRoom = await executor([{ tool: 'aviation_lookup', arguments: {} }], 'room-inactive')
    expect(inactiveRoom[0]!.success).toBe(false)
    expect(inactiveRoom[0]!.error).toContain('is not available')
  })

  test('no "not allowed by active skills" error string is ever emitted', async () => {
    // The deleted error message MUST NOT come back. If it does, the
    // skill-level gate has been re-introduced and this PR's intent is
    // undone.
    const registry = createToolRegistry()
    registry.register(mockTool('any_tool'))
    const executor = createToolExecutor(
      registry,
      ['any_tool'],
      fakeContext,
      () => ({ getActivePacks: () => [] }),
    )
    const results = await executor([{ tool: 'any_tool', arguments: {} }], 'room')
    // Doesn't matter if the call succeeded or not — the specific
    // skill-whitelist error must not be the reason.
    if (!results[0]!.success) {
      expect(results[0]!.error).not.toContain('not allowed by active skills')
    }
  })
})
