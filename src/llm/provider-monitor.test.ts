import { describe, expect, test } from 'bun:test'
import { createProviderMonitor, type ProviderMonitor } from './provider-monitor.ts'
import { createCloudProviderError, createGatewayError } from './errors.ts'

const makeClock = (start = 1_700_000_000_000) => {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => { t += ms },
  }
}

const makeFakeTimers = () => {
  type Pending = { fn: () => void; at: number; id: number }
  let nextId = 1
  const pending: Pending[] = []
  let virtualNow = 0
  return {
    setTimeout: ((fn: () => void, ms: number) => {
      const id = nextId++
      pending.push({ fn, at: virtualNow + ms, id })
      return id as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout,
    clearTimeout: ((id: unknown) => {
      const idx = pending.findIndex(p => p.id === id)
      if (idx >= 0) pending.splice(idx, 1)
    }) as typeof clearTimeout,
    advance: (ms: number) => {
      virtualNow += ms
      const due = pending.filter(p => p.at <= virtualNow).sort((a, b) => a.at - b.at)
      for (const p of due) {
        const idx = pending.indexOf(p)
        if (idx >= 0) pending.splice(idx, 1)
        p.fn()
      }
    },
    pendingCount: () => pending.length,
  }
}

const baseConfig = (overrides: Record<string, unknown> = {}) => ({
  name: 'gemini',
  kind: 'cloud' as const,
  hasKey: () => true,
  isUserEnabled: () => true,
  ...overrides,
})

const makeMonitor = (overrides: Record<string, unknown> = {}, clock = makeClock()): {
  monitor: ProviderMonitor
  clock: ReturnType<typeof makeClock>
} => {
  const m = createProviderMonitor(baseConfig(overrides), { now: clock.now })
  return { monitor: m, clock }
}

describe('provider-monitor — initial state', () => {
  test('cloud with key + enabled starts ok', () => {
    const { monitor } = makeMonitor()
    expect(monitor.getState().sub).toBe('ok')
    expect(monitor.mayCall()).toBe(true)
  })

  test('cloud without key reports no_key', () => {
    const { monitor } = makeMonitor({ hasKey: () => false })
    expect(monitor.getState().sub).toBe('no_key')
    expect(monitor.mayCall()).toBe(false)
  })

  test('disabled overrides everything', () => {
    const { monitor } = makeMonitor({ isUserEnabled: () => false })
    expect(monitor.getState().sub).toBe('disabled')
    expect(monitor.mayCall()).toBe(false)
  })

  test('ollama needs no key', () => {
    const { monitor } = makeMonitor({ kind: 'ollama', hasKey: () => false })
    expect(monitor.getState().sub).toBe('ok')
  })
})

describe('provider-monitor — backoff transitions', () => {
  test('rate_limit error with Retry-After enters backoff', () => {
    const { monitor, clock } = makeMonitor()
    const err = createCloudProviderError({
      code: 'rate_limit', provider: 'gemini', message: 'rl',
      retryAfterMs: 5_000,
    })
    monitor.recordChatOutcome({ ok: false, error: err })
    const s = monitor.getState()
    expect(s.sub).toBe('backoff')
    expect(s.retryAt).toBe(clock.now() + 5_000)
    expect(monitor.mayCall()).toBe(false)
  })

  test('rate_limit without Retry-After uses default', () => {
    const { monitor, clock } = makeMonitor({ defaultRateLimitCooldownMs: 7_000 })
    monitor.recordChatOutcome({
      ok: false,
      error: createCloudProviderError({ code: 'rate_limit', provider: 'gemini', message: 'rl' }),
    })
    expect(monitor.getState().retryAt).toBe(clock.now() + 7_000)
  })

  test('mayCall returns true after retryAt elapses, transitioning to ok', () => {
    const { monitor, clock } = makeMonitor()
    monitor.recordChatOutcome({
      ok: false,
      error: createCloudProviderError({
        code: 'rate_limit', provider: 'gemini', message: 'rl', retryAfterMs: 1_000,
      }),
    })
    expect(monitor.mayCall()).toBe(false)
    clock.advance(1_001)
    expect(monitor.mayCall()).toBe(true)
    expect(monitor.getState().sub).toBe('ok')
  })

  test('quota cooldown defaults to long window', () => {
    const { monitor } = makeMonitor()
    monitor.recordChatOutcome({
      ok: false,
      error: createCloudProviderError({ code: 'quota', provider: 'gemini', message: 'q' }),
    })
    expect(monitor.getState().sub).toBe('backoff')
    expect(monitor.getState().reason).toBe('quota exceeded')
  })
})

describe('provider-monitor — unhealthy streak', () => {
  test('flips to unhealthy after threshold consecutive network failures', () => {
    const { monitor } = makeMonitor({ unhealthyThreshold: 3 })
    for (let i = 0; i < 2; i++) {
      monitor.recordChatOutcome({ ok: false, error: new Error('boom') })
      expect(monitor.getState().sub).toBe('ok')
    }
    monitor.recordChatOutcome({ ok: false, error: new Error('boom') })
    expect(monitor.getState().sub).toBe('unhealthy')
    // Still allows calls — unhealthy is a soft signal, traffic is how we
    // learn it recovered.
    expect(monitor.mayCall()).toBe(true)
  })

  test('success resets streak and returns to ok', () => {
    const { monitor } = makeMonitor({ unhealthyThreshold: 2 })
    monitor.recordChatOutcome({ ok: false, error: new Error('x') })
    monitor.recordChatOutcome({ ok: false, error: new Error('y') })
    expect(monitor.getState().sub).toBe('unhealthy')
    monitor.recordChatOutcome({ ok: true })
    expect(monitor.getState().sub).toBe('ok')
    expect(monitor.getState().consecutiveFailures).toBe(0)
  })
})

describe('provider-monitor — permanent + gateway errors do not affect health', () => {
  test('auth error does not bump streak', () => {
    const { monitor } = makeMonitor()
    monitor.recordChatOutcome({
      ok: false,
      error: createCloudProviderError({ code: 'auth', provider: 'gemini', message: 'bad key' }),
    })
    expect(monitor.getState().sub).toBe('ok')
    expect(monitor.getState().consecutiveFailures).toBe(0)
  })

  test('gateway shed errors do not bump streak', () => {
    const { monitor } = makeMonitor()
    monitor.recordChatOutcome({ ok: false, error: createGatewayError('queue_full', 'shed') })
    monitor.recordChatOutcome({ ok: false, error: createGatewayError('circuit_open', 'open') })
    expect(monitor.getState().sub).toBe('ok')
    expect(monitor.getState().consecutiveFailures).toBe(0)
  })
})

describe('provider-monitor — failure log', () => {
  test('records failures with model + agent', () => {
    const { monitor } = makeMonitor()
    monitor.recordChatOutcome({
      ok: false,
      error: createCloudProviderError({
        code: 'rate_limit', provider: 'gemini', message: 'rl', retryAfterMs: 1_000,
      }),
      model: 'gemini-2.5-pro',
      agentId: 'a1',
    })
    const log = monitor.getRecentFailures()
    expect(log.length).toBe(1)
    expect(log[0]?.model).toBe('gemini-2.5-pro')
    expect(log[0]?.agentId).toBe('a1')
    expect(log[0]?.code).toBe('rate_limit')
  })

  test('ring buffer caps at configured size', () => {
    const { monitor } = makeMonitor({ failureLogSize: 3 })
    for (let i = 0; i < 5; i++) {
      monitor.recordChatOutcome({
        ok: false,
        error: new Error(`e${i}`),
        model: 'm',
        agentId: 'a',
      })
    }
    expect(monitor.getRecentFailures().length).toBe(3)
  })
})

describe('provider-monitor — listeners', () => {
  test('onChange fires on sub-state transition', () => {
    const { monitor } = makeMonitor()
    const seen: string[] = []
    monitor.onChange(s => seen.push(s.sub))
    monitor.recordChatOutcome({
      ok: false,
      error: createCloudProviderError({
        code: 'rate_limit', provider: 'gemini', message: 'rl', retryAfterMs: 1_000,
      }),
    })
    expect(seen).toContain('backoff')
  })

  test('onChange does not fire when nothing observable changed', () => {
    const { monitor } = makeMonitor()
    let count = 0
    monitor.onChange(() => count++)
    monitor.recordChatOutcome({ ok: true })
    monitor.recordChatOutcome({ ok: true })
    expect(count).toBe(0)
  })

  test('listener throwing does not break others', () => {
    const { monitor } = makeMonitor()
    const seen: string[] = []
    monitor.onChange(() => { throw new Error('bad listener') })
    monitor.onChange(s => seen.push(s.sub))
    monitor.recordChatOutcome({
      ok: false,
      error: createCloudProviderError({ code: 'rate_limit', provider: 'gemini', message: 'rl', retryAfterMs: 1_000 }),
    })
    expect(seen).toContain('backoff')
  })
})

describe('provider-monitor — heartbeat scheduling', () => {
  const makeFakeGateway = (behaviour: { models?: ReadonlyArray<string>; throwOnRefresh?: unknown } = {}) => {
    let availableModels: ReadonlyArray<string> = behaviour.models ?? ['m1', 'm2']
    return {
      chat: async () => { throw new Error('not used') },
      models: async () => [...availableModels],
      runningModels: async () => [],
      getMetrics: () => ({} as never),
      getHealth: () => ({
        status: 'healthy' as const,
        latencyMs: 0,
        availableModels,
        lastCheckedAt: 0,
      }),
      getConfig: () => ({} as never),
      updateConfig: () => {},
      onHealthChange: () => {},
      resetCircuitBreaker: () => {},
      refreshModels: async () => {
        if (behaviour.throwOnRefresh) throw behaviour.throwOnRefresh
        // mutate to verify update path
        availableModels = behaviour.models ?? availableModels
      },
      recordExternalFailure: () => {},
      dispose: () => {},
    }
  }

  test('heartbeat does not run when isActive returns false', async () => {
    const timers = makeFakeTimers()
    let active = false
    const monitor = createProviderMonitor(
      baseConfig({ isActive: () => active, healthyIntervalMs: 1_000 }),
      { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
    )
    const gw = makeFakeGateway()
    let refreshCalls = 0
    const gwSpy = { ...gw, refreshModels: async () => { refreshCalls++ } }
    monitor.start(gwSpy as never)
    timers.advance(1_000)
    // First tick fires; isActive is false → reschedules without calling.
    await Promise.resolve()
    expect(refreshCalls).toBe(0)
    active = true
    timers.advance(1_000)
    await Promise.resolve()
    await Promise.resolve()
    expect(refreshCalls).toBe(1)
    monitor.dispose()
  })

  test('successful heartbeat updates modelCount and stays ok', async () => {
    const timers = makeFakeTimers()
    const monitor = createProviderMonitor(
      baseConfig({ healthyIntervalMs: 500 }),
      { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
    )
    const gw = makeFakeGateway({ models: ['a', 'b', 'c'] })
    monitor.start(gw as never)
    timers.advance(500)
    await Promise.resolve()
    await Promise.resolve()
    expect(monitor.getState().modelCount).toBe(3)
    expect(monitor.getState().sub).toBe('ok')
    monitor.dispose()
  })

  test('dispose cancels pending heartbeat', () => {
    const timers = makeFakeTimers()
    const monitor = createProviderMonitor(
      baseConfig({ healthyIntervalMs: 1_000 }),
      { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
    )
    const gw = makeFakeGateway()
    monitor.start(gw as never)
    expect(timers.pendingCount()).toBe(1)
    monitor.dispose()
    expect(timers.pendingCount()).toBe(0)
  })

  test('does not poll while inside backoff window', async () => {
    const clock = makeClock()
    const timers = makeFakeTimers()
    const monitor = createProviderMonitor(
      baseConfig({ healthyIntervalMs: 1_000 }),
      {
        now: clock.now,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
      },
    )
    let refreshCalls = 0
    const gw = { ...makeFakeGateway(), refreshModels: async () => { refreshCalls++ } }
    monitor.start(gw as never)
    monitor.recordChatOutcome({
      ok: false,
      error: createCloudProviderError({
        code: 'rate_limit', provider: 'gemini', message: 'rl', retryAfterMs: 5_000,
      }),
    })
    // Advance enough to fire several would-be heartbeats; none should fire
    // because retryAt is in the future.
    timers.advance(2_000)
    clock.advance(2_000)
    await Promise.resolve()
    expect(refreshCalls).toBe(0)
    expect(monitor.getState().sub).toBe('backoff')
    monitor.dispose()
  })
})

describe('provider-monitor — recovery after disable/re-enable', () => {
  test('toggling user-enabled flips static state', () => {
    let enabled = true
    const monitor = createProviderMonitor(baseConfig({ isUserEnabled: () => enabled }))
    expect(monitor.getState().sub).toBe('ok')
    enabled = false
    monitor.setUserEnabled(false)
    expect(monitor.getState().sub).toBe('disabled')
    enabled = true
    monitor.setUserEnabled(true)
    expect(monitor.getState().sub).toBe('ok')
  })
})
