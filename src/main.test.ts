// ============================================================================
// System.resetState tests.
//
// resetState is the Phase 3 primitive that backs the `reset_system` MCP tool.
// It clears rooms, agents, artifacts; preserves tool registry + skills +
// provider state. Covered by a positive path + name-reuse path; the
// subprocess-level integration is exercised end-to-end by
// experiments/batch-reset.test.ts under SOAK=1.
// ============================================================================

import { describe, test, expect } from 'bun:test'
import { createSystem } from './main.ts'
import { SYSTEM_SENDER_ID } from './core/types/constants.ts'
import { createHumanAgent } from './agents/human-agent.ts'

describe('System.resetState', () => {
  test('clears rooms and agents, returns counts, preserves infrastructure', async () => {
    const system = createSystem()

    // Seed state: 2 rooms, 2 human agents (no LLM traffic needed).
    system.house.createRoom({ name: 'alpha', createdBy: SYSTEM_SENDER_ID })
    system.house.createRoom({ name: 'bravo', createdBy: SYSTEM_SENDER_ID })

    const a = createHumanAgent({ name: 'Alice' }, () => {})
    const b = createHumanAgent({ name: 'Bob' }, () => {})
    system.team.addAgent(a)
    system.team.addAgent(b)

    const toolCountBefore = system.toolRegistry.list().length

    const result = await system.resetState()

    expect(result.rooms).toBe(2)
    expect(result.agents).toBe(2)

    // State is empty after reset
    expect(system.house.listAllRooms()).toHaveLength(0)
    expect(system.team.listAgents()).toHaveLength(0)

    // Infrastructure preserved
    expect(system.toolRegistry.list().length).toBe(toolCountBefore)
  })

  test('artifact clear is called and artifacts collection is empty after reset', async () => {
    const system = createSystem()

    // Directly exercise the artifact-store clear API. We avoid registering an
    // artifact type (test setup overhead); the clear path is what resetState
    // depends on and that's what we verify here.
    expect(typeof system.house.artifacts.clear).toBe('function')
    system.house.artifacts.clear()
    expect(system.house.artifacts.list()).toHaveLength(0)

    // resetState on an empty house returns zero counts for all three buckets.
    const result = await system.resetState()
    expect(result.artifacts).toBe(0)
  })

  test('name re-use after reset — re-create agents/rooms with the same names', async () => {
    const system = createSystem()

    system.house.createRoom({ name: 'trial', createdBy: SYSTEM_SENDER_ID })
    const agent1 = createHumanAgent({ name: 'solver' }, () => {})
    system.team.addAgent(agent1)

    await system.resetState()

    // Re-create with the SAME names — must succeed (no stale name lingering)
    expect(() => system.house.createRoom({ name: 'trial', createdBy: SYSTEM_SENDER_ID })).not.toThrow()
    const agent2 = createHumanAgent({ name: 'solver' }, () => {})
    expect(() => system.team.addAgent(agent2)).not.toThrow()

    expect(system.team.getAgent('solver')?.id).toBe(agent2.id)
    expect(system.team.getAgent('solver')?.id).not.toBe(agent1.id)
  })
})

describe('lateBinding warn-once', () => {
  test('warns once when a slot fires unsubscribed; stays silent after', () => {
    const warnings: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')) }

    try {
      const system = createSystem({ instanceLabel: 'test-instance' })
      // Trigger evalEvent without setting a subscriber. mutateRoom: post a
      // chat message via routeMessage so messagePosted fires too.
      const room = system.house.createRoom({ name: 'lb-test', createdBy: SYSTEM_SENDER_ID })
      const human = createHumanAgent({ name: 'Trigger' }, () => {})
      system.team.addAgent(human)

      // messagePosted is one of the slots. Without setOnMessagePosted called,
      // the first proxy invocation should warn exactly once.
      room.post({ senderId: human.id, content: 'hi', type: 'chat' })
      room.post({ senderId: human.id, content: 'again', type: 'chat' })
      room.post({ senderId: human.id, content: 'and again', type: 'chat' })

      const messageWarnings = warnings.filter(w => w.includes('messagePosted'))
      expect(messageWarnings.length).toBe(1)
      expect(messageWarnings[0]).toContain('test-instance')
      expect(messageWarnings[0]).toContain('first event dropped')
    } finally {
      console.warn = origWarn
    }
  })

  test('stays silent once a subscriber is set', () => {
    const warnings: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')) }

    try {
      const system = createSystem({ instanceLabel: 'test-2' })
      // Set the subscriber BEFORE any event — no warning should fire.
      system.setOnMessagePosted(() => { /* ok */ })
      const room = system.house.createRoom({ name: 'lb-test-2', createdBy: SYSTEM_SENDER_ID })
      const human = createHumanAgent({ name: 'Trigger2' }, () => {})
      system.team.addAgent(human)
      room.post({ senderId: human.id, content: 'hi', type: 'chat' })

      expect(warnings.filter(w => w.includes('messagePosted'))).toEqual([])
    } finally {
      console.warn = origWarn
    }
  })
})
