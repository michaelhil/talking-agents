import { describe, test, expect } from 'bun:test'
import { createUpdateBeatTool, type CastIdToNameMap } from './script-tools.ts'
import { createScriptRegistry } from '../../core/script-registry.ts'
import { createScriptRun } from '../../core/script-runs.ts'
import type { Script } from '../../core/types/script.ts'
import type { ToolContext } from '../../core/types/tool.ts'

const mkScript = (): Script => ({
  id: 'script-1',
  name: 'test',
  acts: {
    confess: { name: 'confess', description: 'admit' },
    deflect: { name: 'deflect', description: 'avoid' },
  },
  cast: [
    { name: 'Anna', kind: 'ai', agentConfig: { name: 'Anna', model: 'm', persona: 'p' } },
    { name: 'Bob',  kind: 'ai', agentConfig: { name: 'Bob',  model: 'm', persona: 'p' } },
  ],
  scenes: [
    {
      setup: 'evening',
      present: ['Anna', 'Bob'],
      objectives: {
        Anna: { want: 'get truth', signal: { acts: { Bob: ['confess'] } } },
        Bob:  { want: 'avoid', signal: { acts: { Bob: ['confess', 'deflect'] } } },
      },
    },
  ],
})

const mkSetup = () => {
  const registry = createScriptRegistry()
  const map: CastIdToNameMap = {
    get: (roomId: string, agentId: string) => {
      if (roomId !== 'room-1') return undefined
      if (agentId === 'agent-anna') return 'Anna'
      if (agentId === 'agent-bob') return 'Bob'
      return undefined
    },
  }
  const tool = createUpdateBeatTool(registry, map)
  const run = createScriptRun(mkScript(), 'room-1')
  registry.set('room-1', run)
  const ctx = (callerId: string): ToolContext => ({ callerId, callerName: callerId, roomId: 'room-1' })
  return { tool, run, ctx, registry, map }
}

describe('update_beat tool', () => {
  test('records a phase-1 beat (no speech_acts)', async () => {
    const { tool, run, ctx } = mkSetup()
    const result = await tool.execute({ status: 'pursuing', intent: 'speak', addressed_to: 'Bob' }, ctx('agent-anna'))
    expect(result.success).toBe(true)
    expect(run.beats).toHaveLength(1)
    expect(run.beats[0]!.character).toBe('Anna')
    expect(run.beats[0]!.addressedTo).toBe('Bob')
  })

  test('records a phase-2 beat with valid speech_acts', async () => {
    const { tool, run, ctx } = mkSetup()
    const result = await tool.execute(
      { status: 'pursuing', intent: 'speak', speech_acts: ['confess'] },
      ctx('agent-bob'),
    )
    expect(result.success).toBe(true)
    expect(run.beats[0]!.speechActs).toEqual(['confess'])
  })

  test('rejects unknown speech_acts', async () => {
    const { tool, ctx } = mkSetup()
    const result = await tool.execute(
      { status: 'pursuing', intent: 'speak', speech_acts: ['lie'] },
      ctx('agent-bob'),
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('Unknown speech-act')
  })

  test('rejects callers not in cast', async () => {
    const { tool, ctx } = mkSetup()
    const result = await tool.execute(
      { status: 'pursuing', intent: 'speak' },
      ctx('agent-stranger'),
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('not a member')
  })

  test('rejects no active run', async () => {
    const { tool, ctx, registry } = mkSetup()
    registry.clear('room-1')
    const result = await tool.execute({ status: 'pursuing', intent: 'speak' }, ctx('agent-anna'))
    expect(result.success).toBe(false)
    expect(result.error).toContain('No active script')
  })

  test('rejects addressed_to not in present cast', async () => {
    const { tool, ctx } = mkSetup()
    const result = await tool.execute(
      { status: 'pursuing', intent: 'speak', addressed_to: 'Stranger' },
      ctx('agent-anna'),
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('not in the present cast')
  })

  test('rejects bad status / intent values', async () => {
    const { tool, ctx } = mkSetup()
    const r1 = await tool.execute({ status: 'wat', intent: 'speak' }, ctx('agent-anna'))
    expect(r1.success).toBe(false)
    const r2 = await tool.execute({ status: 'pursuing', intent: 'wat' }, ctx('agent-anna'))
    expect(r2.success).toBe(false)
  })
})
