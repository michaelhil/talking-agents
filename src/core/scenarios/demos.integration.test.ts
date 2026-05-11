// Integration tests for the bundled `demos` pack. Each test asserts that the
// scenario loads, parses, and the parts that don't depend on a live LLM
// execute correctly (room created, agents spawned, scripted post-message
// posts visible). Demos with `wait { type: llm-response }` ops can't run to
// completion in unit tests (no real provider) — they're tested for parse +
// initial setup only; see "halts at first llm-response wait" assertion.

import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSystemRegistry, type SystemRegistry } from '../instances/system-registry.ts'
import { createSharedRuntime } from '../shared-runtime.ts'
import { generateInstanceId } from '../../api/instance-cookie.ts'

describe('synthetic-demos pack', () => {
  let originalHome: string | undefined
  let originalSeedFlag: string | undefined
  let homeDir: string
  let registry: SystemRegistry

  beforeEach(async () => {
    originalHome = process.env.SAMSINN_HOME
    originalSeedFlag = process.env.SAMSINN_SEED_EXAMPLE
    homeDir = await mkdtemp(join(tmpdir(), 'samsinn-demos-'))
    process.env.SAMSINN_HOME = homeDir
    process.env.PROVIDER = 'ollama'
    // Skip the welcome auto-seed — these tests assert the demos pack
    // independently and shouldn't carry over Cafe/AI/Human from welcome.
    process.env.SAMSINN_SEED_EXAMPLE = '0'
    const shared = createSharedRuntime()
    registry = createSystemRegistry({ shared, idleMs: 1_000_000 })
  })

  afterEach(async () => {
    await registry.shutdown()
    if (originalHome === undefined) delete process.env.SAMSINN_HOME
    else process.env.SAMSINN_HOME = originalHome
    if (originalSeedFlag === undefined) delete process.env.SAMSINN_SEED_EXAMPLE
    else process.env.SAMSINN_SEED_EXAMPLE = originalSeedFlag
    delete process.env.PROVIDER
    await rm(homeDir, { recursive: true, force: true })
  })

  it('catalog lists welcome + first-conversation + diagram-thinking', async () => {
    const id = generateInstanceId()
    const system = await registry.getOrLoad(id)
    // SAMSINN_SEED_EXAMPLE=0 skips the registry's explicit await of
    // scenarioStore.reload(); the createSystem fire-and-forget reload may
    // not have completed yet, so await it here.
    await system.scenarioStore.reload()
    const ids = system.scenarioStore.list().map(s => s.id).sort()
    expect(ids).toEqual([
      'demos/biometric-awareness',
      'demos/diagram-thinking',
      'demos/first-conversation',
      'welcome/getting-started',
    ])
  })

  it('first-conversation creates the room and agents on run', async () => {
    const id = generateInstanceId()
    const system = await registry.getOrLoad(id)
    // SAMSINN_SEED_EXAMPLE=0 skips the registry's explicit await of
    // scenarioStore.reload(); the createSystem fire-and-forget reload may
    // not have completed yet, so await it here.
    await system.scenarioStore.reload()
    const scenario = system.scenarioStore.get('demos/first-conversation')!
    expect(scenario).toBeDefined()
    const result = await system.scenarioRunner.run(scenario)
    expect(result.ok).toBe(true)
    // First wait is `llm-response` after the user-prompted post; in tests
    // there's no real provider so the eval won't complete. The setup ops
    // (create-room, spawn-agent, spawn-human, post-message system, guide-
    // tooltip, post-message Human) all run before the wait. We assert the
    // setup state is correct; the run itself stays in 'awaiting'.
    const deadline = Date.now() + 1_500
    while (Date.now() < deadline) {
      const r = system.scenarioRunner.getRun(result.runId!)
      if (r && (r.status === 'awaiting' || r.status === 'failed')) break
      await new Promise(res => setTimeout(res, 25))
    }
    const room = system.house.getRoom('First steps')
    expect(room).toBeDefined()
    expect(system.team.getAgent('Guide')?.kind).toBe('ai')
    expect(system.team.getAgent('You')?.kind).toBe('human')
    // The system-typed welcome post should be visible (the chat post from
    // "You" needs the user to type, which won't happen in this test).
    const messages = room!.getRecent(20)
    expect(messages.some(m => m.type === 'system' && m.content.includes('First conversation tour'))).toBe(true)
    // Cleanup so afterEach doesn't trip on the still-active run.
    system.scenarioRunner.stop(result.runId!)
  })

  it('diagram-thinking creates Cartographer + posts the user-prompt', async () => {
    const id = generateInstanceId()
    const system = await registry.getOrLoad(id)
    // SAMSINN_SEED_EXAMPLE=0 skips the registry's explicit await of
    // scenarioStore.reload(); the createSystem fire-and-forget reload may
    // not have completed yet, so await it here.
    await system.scenarioStore.reload()
    const scenario = system.scenarioStore.get('demos/diagram-thinking')!
    expect(scenario).toBeDefined()
    const result = await system.scenarioRunner.run(scenario)
    expect(result.ok).toBe(true)
    const deadline = Date.now() + 1_500
    while (Date.now() < deadline) {
      const r = system.scenarioRunner.getRun(result.runId!)
      if (r && (r.status === 'awaiting' || r.status === 'failed' || r.status === 'completed')) break
      await new Promise(res => setTimeout(res, 25))
    }
    const room = system.house.getRoom('Diagrams')
    expect(room).toBeDefined()
    const cartographer = system.team.getAgent('Cartographer')
    expect(cartographer?.kind).toBe('ai')
    const messages = room!.getRecent(20)
    // System scene-setter post.
    expect(messages.some(m => m.type === 'system' && m.content.includes('Cartographer will draw'))).toBe(true)
    // The "How does an LLM..." post from "You".
    expect(messages.some(m => m.content.includes('How does an LLM process a prompt'))).toBe(true)
    system.scenarioRunner.stop(result.runId!)
  })
})
