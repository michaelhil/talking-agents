import { describe, test, expect } from 'bun:test'
import { createTriggerScheduler } from './scheduler.ts'
import type { Trigger } from './types.ts'

// Minimal fakes — the scheduler only needs:
//   team.listAgents / getAgent
//   house.getRoom
//   agent.kind / state / getTriggers / markTriggerFired
//   Room.post (post-mode dispatch)
//   AIAgent.fireTriggerExecute (execute-mode dispatch)

interface FakeAgent {
  id: string
  name: string
  kind: 'ai' | 'human'
  state: { get: () => 'idle' | 'generating'; getContext: () => string | undefined; subscribe: () => () => void }
  triggers: Trigger[]
  postedFromTrigger: Array<{ content: string }>
  executedPrompts: string[]
  getTriggers(): Trigger[]
  markTriggerFired(id: string, when: number): void
  fireTriggerExecute?(prompt: string, _roomId: string): Promise<void>
  receive(): void
  join(): Promise<void>
  leave(): void
  metadata: Record<string, unknown>
}

const mkAgent = (id: string, kind: 'ai' | 'human', triggers: Trigger[]): FakeAgent => {
  const a: FakeAgent = {
    id,
    name: id,
    kind,
    state: { get: () => 'idle', getContext: () => undefined, subscribe: () => () => {} },
    triggers,
    postedFromTrigger: [],
    executedPrompts: [],
    getTriggers: () => a.triggers,
    markTriggerFired: (tid, when) => {
      const idx = a.triggers.findIndex(t => t.id === tid)
      if (idx < 0) return
      a.triggers[idx] = { ...a.triggers[idx]!, lastFiredAt: when }
    },
    receive: () => {},
    join: async () => {},
    leave: () => {},
    metadata: {},
  }
  if (kind === 'ai') {
    a.fireTriggerExecute = async (prompt) => { a.executedPrompts.push(prompt) }
  }
  return a
}

const mkRoom = (id: string, agent: FakeAgent) => ({
  profile: { id, name: id, createdAt: 0, createdBy: 'test' },
  post: (params: { content: string; senderId: string; senderName: string; type: string }) => {
    agent.postedFromTrigger.push({ content: params.content })
    return { id: 'msg-' + Math.random(), roomId: id, senderId: params.senderId, content: params.content, type: params.type, timestamp: Date.now() }
  },
})

describe('createTriggerScheduler', () => {
  test('post-mode trigger dispatches via room.post', async () => {
    const trigger: Trigger = {
      id: 't1', name: 'morning briefing', prompt: 'morning briefing time',
      mode: 'post', intervalSec: 60, enabled: true, roomId: 'r1',
      lastFiredAt: 0,  // overdue immediately
    }
    const agent = mkAgent('Reminder', 'human', [trigger])
    const room = mkRoom('r1', agent)
    let nowMs = 1_000_000
    const sched = createTriggerScheduler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      team: { listAgents: () => [agent as any], getAgent: () => agent as any } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      house: { getRoom: () => room as any } as any,
      now: () => nowMs,
    })
    const due = await sched.tickNow()
    expect(due).toEqual([{ agentId: 'Reminder', triggerId: 't1' }])
    expect(agent.postedFromTrigger).toEqual([{ content: 'morning briefing time' }])
    expect(agent.triggers[0]!.lastFiredAt).toBe(nowMs)
    sched.stop()
  })

  test('execute-mode trigger dispatches via fireTriggerExecute on AI agent', async () => {
    const trigger: Trigger = {
      id: 't1', name: 'check vatsim', prompt: 'check vatsim and report changes',
      mode: 'execute', intervalSec: 60, enabled: true, roomId: 'r1',
      lastFiredAt: 0,
    }
    const agent = mkAgent('Echo', 'ai', [trigger])
    const room = mkRoom('r1', agent)
    const sched = createTriggerScheduler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      team: { listAgents: () => [agent as any], getAgent: () => agent as any } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      house: { getRoom: () => room as any } as any,
      now: () => 1_000_000,
    })
    await sched.tickNow()
    expect(agent.executedPrompts).toEqual(['check vatsim and report changes'])
    expect(agent.postedFromTrigger).toEqual([])  // execute does NOT post-as-agent
    sched.stop()
  })

  test('first-fire stagger: undefined lastFiredAt becomes now() at stagger time', async () => {
    const trigger: Trigger = {
      id: 't1', name: 'x', prompt: 'y', mode: 'post', intervalSec: 60,
      enabled: true, roomId: 'r1',  // no lastFiredAt
    }
    const agent = mkAgent('A', 'human', [trigger])
    const room = mkRoom('r1', agent)
    let nowMs = 1_000_000
    const sched = createTriggerScheduler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      team: { listAgents: () => [agent as any], getAgent: () => agent as any } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      house: { getRoom: () => room as any } as any,
      now: () => nowMs,
    })
    // Stagger ran on construction → lastFiredAt should equal current now().
    expect(agent.triggers[0]!.lastFiredAt).toBe(1_000_000)

    // Now+30s: tick should NOT fire (interval is 60s).
    nowMs = 1_000_000 + 30_000
    await sched.tickNow()
    expect(agent.postedFromTrigger).toHaveLength(0)

    // Now+61s: tick SHOULD fire.
    nowMs = 1_000_000 + 61_000
    await sched.tickNow()
    expect(agent.postedFromTrigger).toHaveLength(1)
    sched.stop()
  })

  test('runtime-added trigger does not fire immediately after stagger', async () => {
    // Simulate a trigger added via REST after the scheduler has been running:
    // start scheduler with no triggers (anyTriggers=false), then add a trigger
    // at a much later time and call invalidate. The runtime-added trigger
    // must wait one interval, not fire on the next tick.
    const agent = mkAgent('A', 'human', [])
    const room = mkRoom('r1', agent)
    let nowMs = 1_000_000   // "boot" time
    const sched = createTriggerScheduler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      team: { listAgents: () => [agent as any], getAgent: () => agent as any } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      house: { getRoom: () => room as any } as any,
      now: () => nowMs,
    })

    // Time passes — server has been running for an hour.
    nowMs = 1_000_000 + 3_600_000

    // User adds a trigger via REST: agent gains it, then invalidate.
    agent.triggers = [{
      id: 't1', name: 'x', prompt: 'y', mode: 'post', intervalSec: 60,
      enabled: true, roomId: 'r1',  // undefined lastFiredAt — this is the bug case
    }]
    sched.invalidate()
    expect(agent.triggers[0]!.lastFiredAt).toBe(1_000_000 + 3_600_000)  // now, not bootTime

    // Tick immediately after add: must NOT fire (waits one interval).
    await sched.tickNow()
    expect(agent.postedFromTrigger).toHaveLength(0)

    // After interval has passed: fires.
    nowMs += 61_000
    await sched.tickNow()
    expect(agent.postedFromTrigger).toHaveLength(1)
    sched.stop()
  })

  test('disabled triggers are not fired', async () => {
    const trigger: Trigger = {
      id: 't1', name: 'x', prompt: 'y', mode: 'post', intervalSec: 60,
      enabled: false, roomId: 'r1', lastFiredAt: 0,
    }
    const agent = mkAgent('A', 'human', [trigger])
    const room = mkRoom('r1', agent)
    const sched = createTriggerScheduler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      team: { listAgents: () => [agent as any], getAgent: () => agent as any } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      house: { getRoom: () => room as any } as any,
      now: () => 1_000_000,
    })
    await sched.tickNow()
    expect(agent.postedFromTrigger).toHaveLength(0)
    sched.stop()
  })

  test('orphaned trigger (deleted room) is silently skipped', async () => {
    const trigger: Trigger = {
      id: 't1', name: 'x', prompt: 'y', mode: 'post', intervalSec: 60,
      enabled: true, roomId: 'gone', lastFiredAt: 0,
    }
    const agent = mkAgent('A', 'human', [trigger])
    const sched = createTriggerScheduler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      team: { listAgents: () => [agent as any], getAgent: () => agent as any } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      house: { getRoom: () => undefined } as any,
      now: () => 1_000_000,
    })
    await sched.tickNow()
    expect(agent.postedFromTrigger).toHaveLength(0)
    sched.stop()
  })
})
