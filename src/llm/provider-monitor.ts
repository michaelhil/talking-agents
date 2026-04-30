// ============================================================================
// Provider Monitor — single source of truth for "is provider X usable now?"
//
// Replaces the previously-independent router cooldown map and ad-hoc health
// derivation in routes/providers.ts. The gateway's circuit breaker still
// exists as a local short-circuit for the gateway's own request flow, but
// the router asks the monitor — never the breaker directly — whether to send.
//
// Two named sub-states preserve a real semantic distinction:
//   - 'backoff'    explicit Retry-After window (rate_limit, quota,
//                  provider_down WITH header). Has a known retryAt.
//   - 'unhealthy'  inferred from a streak of failures without a known
//                  recovery time. Self-tested via heartbeat.
// Plus the static states: 'no_key', 'disabled', 'down', 'ok'.
//
// Heartbeat is a /models call (metadata, no token cost on any provider).
// Pacing:
//   - 'ok'        : every 90s
//   - 'unhealthy' : 30s → 60s → 120s → 300s (cap)
//   - 'backoff'   : no poll until retryAt elapses; then one immediate probe
//   - 'no_key' / 'disabled' / 'down' : no poll
// Polling is paused entirely when isActive() returns false (no WS clients).
// Result: an idle Samsinn tab (or none at all) consumes zero requests.
// ============================================================================

import type { ProviderGateway } from './provider-gateway.ts'
import { isCloudProviderError, isFallbackable, isGatewayError } from './errors.ts'

export type MonitorSubState =
  | 'ok'
  | 'backoff'
  | 'unhealthy'
  | 'no_key'
  | 'disabled'
  | 'down'

export interface MonitorState {
  readonly sub: MonitorSubState
  readonly reason: string
  readonly since: number
  readonly retryAt: number | null
  readonly modelCount: number
  readonly lastError: { code: string; message: string } | null
  readonly lastErrorAt: number | null
  readonly consecutiveFailures: number
}

export interface FailureRecord {
  readonly when: number
  readonly provider: string
  readonly model: string | null
  readonly agentId: string | null
  readonly code: string
  readonly reason: string
}

export type MonitorListener = (state: MonitorState) => void

export interface ProviderMonitorConfig {
  readonly name: string
  readonly kind: 'cloud' | 'ollama'
  readonly hasKey: () => boolean
  readonly isUserEnabled: () => boolean
  // Returns true when the system has at least one connected client. When false,
  // the heartbeat is paused so an idle/closed tab incurs zero requests.
  readonly isActive?: () => boolean
  // Cap of recent failures to retain (ring buffer).
  readonly failureLogSize?: number
  // Cadence overrides (test hook).
  readonly healthyIntervalMs?: number
  readonly unhealthyBackoffMsSequence?: ReadonlyArray<number>
  // Default cooldowns when an error has no Retry-After.
  readonly defaultRateLimitCooldownMs?: number
  readonly defaultQuotaCooldownMs?: number
  readonly defaultProviderDownCooldownMs?: number
  // Streak threshold to flip from 'ok' → 'unhealthy' on inferred failures.
  readonly unhealthyThreshold?: number
}

export interface ProviderMonitorDeps {
  readonly now?: () => number
  readonly setInterval?: typeof setInterval
  readonly clearInterval?: typeof clearInterval
  readonly setTimeout?: typeof setTimeout
  readonly clearTimeout?: typeof clearTimeout
}

export interface ProviderMonitor {
  readonly name: string
  readonly mayCall: () => boolean
  readonly getState: () => MonitorState
  readonly recordChatOutcome: (
    outcome:
      | { ok: true }
      | { ok: false; error: unknown; model?: string; agentId?: string | null },
  ) => void
  readonly recordHeartbeat: (ok: boolean, modelCount?: number, error?: unknown) => void
  // Force the monitor into 'unhealthy' with a specific reason, bypassing the
  // streak threshold. Used by explicit test calls (Providers panel "Test"
  // button): when the user-initiated test fails with a permanent error like
  // auth, that's authoritative — one failed test means the key is broken,
  // there's no point waiting for 5 consecutive failures.
  readonly markUnhealthy: (reason: string, code?: string) => void
  readonly setHasKey: (has: boolean) => void
  readonly setUserEnabled: (enabled: boolean) => void
  // Replace the isActive predicate after construction. Bootstrap uses this
  // to wire the WS-client counter once the WSManager exists (the providers
  // are built before the WSManager). When isActive returns false the
  // heartbeat becomes a no-op, so an idle Samsinn (no clients) hits zero
  // network traffic.
  readonly setIsActive: (fn: () => boolean) => void
  readonly recordFailure: (entry: Omit<FailureRecord, 'when' | 'provider'>) => void
  readonly getRecentFailures: () => ReadonlyArray<FailureRecord>
  readonly onChange: (listener: MonitorListener) => () => void
  readonly start: (gateway: ProviderGateway) => void
  readonly dispose: () => void
}

const DEFAULT_HEALTHY_MS = 90_000
const DEFAULT_UNHEALTHY_SEQ = [30_000, 60_000, 120_000, 300_000] as const
const DEFAULT_RATE_LIMIT_MS = 60_000
const DEFAULT_QUOTA_MS = 60 * 60_000
const DEFAULT_PROVIDER_DOWN_MS = 30_000
const DEFAULT_UNHEALTHY_THRESHOLD = 5
const DEFAULT_FAILURE_LOG_SIZE = 50

export const createProviderMonitor = (
  config: ProviderMonitorConfig,
  deps: ProviderMonitorDeps = {},
): ProviderMonitor => {
  const now = deps.now ?? Date.now
  const setT = deps.setTimeout ?? setTimeout
  const clearT = deps.clearTimeout ?? clearTimeout
  // Mutable so bootstrap can rewire it after WSManager is constructed.
  // The providers stack is built before the WSManager exists.
  let isActive: () => boolean = config.isActive ?? (() => true)
  const healthyMs = config.healthyIntervalMs ?? DEFAULT_HEALTHY_MS
  const unhealthySeq = config.unhealthyBackoffMsSequence ?? DEFAULT_UNHEALTHY_SEQ
  const rateLimitMs = config.defaultRateLimitCooldownMs ?? DEFAULT_RATE_LIMIT_MS
  const quotaMs = config.defaultQuotaCooldownMs ?? DEFAULT_QUOTA_MS
  const providerDownMs = config.defaultProviderDownCooldownMs ?? DEFAULT_PROVIDER_DOWN_MS
  const unhealthyThreshold = config.unhealthyThreshold ?? DEFAULT_UNHEALTHY_THRESHOLD
  const logSize = config.failureLogSize ?? DEFAULT_FAILURE_LOG_SIZE

  let state: MonitorState = {
    sub: deriveStaticSub(config.kind, config.hasKey(), config.isUserEnabled()),
    reason: '',
    since: now(),
    retryAt: null,
    modelCount: 0,
    lastError: null,
    lastErrorAt: null,
    consecutiveFailures: 0,
  }

  const listeners: MonitorListener[] = []
  const failures: FailureRecord[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let gateway: ProviderGateway | null = null
  let unhealthyStep = 0

  const setState = (next: Partial<MonitorState>): void => {
    const merged: MonitorState = { ...state, ...next }
    if (
      merged.sub === state.sub
      && merged.reason === state.reason
      && merged.retryAt === state.retryAt
      && merged.modelCount === state.modelCount
      && merged.consecutiveFailures === state.consecutiveFailures
    ) {
      // No observable change → skip emit (and skip 'since' bump).
      state = merged
      return
    }
    state = merged.sub !== state.sub ? { ...merged, since: now() } : merged
    for (const l of listeners) {
      try { l(state) } catch (err) {
        console.warn(`[provider-monitor:${config.name}] listener threw:`, err)
      }
    }
  }

  const transitionToOk = (modelCount?: number): void => {
    unhealthyStep = 0
    setState({
      sub: 'ok',
      reason: '',
      retryAt: null,
      consecutiveFailures: 0,
      ...(modelCount !== undefined ? { modelCount } : {}),
    })
  }

  const transitionToBackoff = (cooldownMs: number, reason: string): void => {
    unhealthyStep = 0
    setState({
      sub: 'backoff',
      reason,
      retryAt: now() + cooldownMs,
      consecutiveFailures: state.consecutiveFailures + 1,
    })
  }

  const transitionToUnhealthy = (reason: string): void => {
    setState({
      sub: 'unhealthy',
      reason,
      retryAt: null,
      consecutiveFailures: state.consecutiveFailures + 1,
    })
  }

  const refreshStaticIfNeeded = (): boolean => {
    // If user toggles enabled/key, the static sub-state takes precedence
    // over backoff/unhealthy/ok (those don't apply when the provider is
    // structurally unavailable).
    const staticSub = deriveStaticSub(config.kind, config.hasKey(), config.isUserEnabled())
    if (staticSub !== 'ok') {
      if (state.sub !== staticSub) {
        unhealthyStep = 0
        setState({ sub: staticSub, reason: '', retryAt: null })
      }
      return true
    }
    // Was static, now active again — reset to ok pending first call/heartbeat.
    if (state.sub === 'no_key' || state.sub === 'disabled') {
      transitionToOk(state.modelCount)
    }
    return false
  }

  const mayCall = (): boolean => {
    refreshStaticIfNeeded()
    if (state.sub === 'no_key' || state.sub === 'disabled' || state.sub === 'down') return false
    if (state.sub === 'backoff') {
      if (state.retryAt !== null && now() >= state.retryAt) {
        // Window elapsed — let traffic try again. The next outcome will
        // either confirm recovery (→ ok) or push us back into backoff.
        transitionToOk(state.modelCount)
        scheduleNextHeartbeat()
        return true
      }
      return false
    }
    // 'ok' and 'unhealthy' both allow calls — unhealthy is a soft signal,
    // not a hard block. Letting traffic through is how we learn it's back.
    return true
  }

  const classify = (
    err: unknown,
  ): { kind: 'backoff'; cooldownMs: number; reason: string; code: string }
    | { kind: 'unhealthy'; reason: string; code: string }
    | { kind: 'permanent'; reason: string; code: string }
    | { kind: 'gateway'; reason: string; code: string } => {
    if (isCloudProviderError(err)) {
      if (!isFallbackable(err)) {
        // auth, bad_request — config problem, not a health problem.
        return { kind: 'permanent', reason: err.message, code: err.code }
      }
      if (err.code === 'rate_limit') {
        const ms = err.retryAfterMs ?? rateLimitMs
        return {
          kind: 'backoff', cooldownMs: ms, code: err.code,
          reason: `rate-limited${err.retryAfterMs ? ` (retry in ${Math.round(ms / 1000)}s)` : ''}`,
        }
      }
      if (err.code === 'quota') {
        return {
          kind: 'backoff', cooldownMs: err.retryAfterMs ?? quotaMs, code: err.code,
          reason: 'quota exceeded',
        }
      }
      // provider_down
      return {
        kind: 'backoff', cooldownMs: err.retryAfterMs ?? providerDownMs, code: err.code,
        reason: 'provider unavailable',
      }
    }
    if (isGatewayError(err)) {
      // queue_full / circuit_open / queue_timeout are *local* shedding —
      // not a sign the upstream is down. Don't tip the monitor into bad
      // states. Router treats them as fallthrough.
      return { kind: 'gateway', reason: err.code, code: err.code }
    }
    // Unknown / network — count toward unhealthy streak.
    const message = err instanceof Error ? err.message : String(err)
    return { kind: 'unhealthy', reason: message, code: 'network' }
  }

  const recordChatOutcome: ProviderMonitor['recordChatOutcome'] = (outcome) => {
    if (outcome.ok) {
      transitionToOk(state.modelCount)
      scheduleNextHeartbeat()
      return
    }
    const decision = classify(outcome.error)
    if (decision.kind === 'permanent' || decision.kind === 'gateway') {
      // Don't change health state. Permanent = config issue (auth);
      // gateway = local shedding. Both bypass health tracking.
      return
    }
    state = { ...state, lastError: { code: decision.code, message: decision.reason }, lastErrorAt: now() }
    if (outcome.model || outcome.agentId !== undefined) {
      pushFailure({
        model: outcome.model ?? null,
        agentId: outcome.agentId ?? null,
        code: decision.code,
        reason: decision.reason,
      })
    }
    if (decision.kind === 'backoff') {
      transitionToBackoff(decision.cooldownMs, decision.reason)
    } else {
      // 'unhealthy' kind: bump streak; flip sub-state once threshold reached.
      const newStreak = state.consecutiveFailures + 1
      if (state.sub !== 'unhealthy' && newStreak >= unhealthyThreshold) {
        transitionToUnhealthy(decision.reason)
      } else {
        setState({ consecutiveFailures: newStreak })
      }
    }
    scheduleNextHeartbeat()
  }

  const recordHeartbeat: ProviderMonitor['recordHeartbeat'] = (ok, modelCount, err) => {
    if (ok) {
      transitionToOk(modelCount ?? state.modelCount)
    } else {
      // Heartbeat failure — same classification path, but we should be
      // careful: cloud providers' /models endpoints can return 401 if the
      // key was just rotated; we don't want that to look like 'down'.
      const decision = err !== undefined ? classify(err) : { kind: 'unhealthy' as const, reason: 'heartbeat failed', code: 'heartbeat' }
      if (decision.kind === 'permanent' || decision.kind === 'gateway') return
      state = { ...state, lastError: { code: decision.code, message: decision.reason }, lastErrorAt: now() }
      if (decision.kind === 'backoff') {
        transitionToBackoff(decision.cooldownMs, decision.reason)
      } else {
        const newStreak = state.consecutiveFailures + 1
        if (state.sub !== 'unhealthy' && newStreak >= unhealthyThreshold) {
          transitionToUnhealthy(decision.reason)
        } else {
          setState({ consecutiveFailures: newStreak })
        }
      }
    }
    scheduleNextHeartbeat()
  }

  const setHasKey = (_: boolean): void => { refreshStaticIfNeeded() }
  const setUserEnabled = (_: boolean): void => { refreshStaticIfNeeded() }
  const setIsActive = (fn: () => boolean): void => { isActive = fn }

  const markUnhealthy = (reason: string, code: string = 'test_failed'): void => {
    state = { ...state, lastError: { code, message: reason }, lastErrorAt: now() }
    transitionToUnhealthy(reason)
    scheduleNextHeartbeat()
  }

  const recordFailure = (entry: Omit<FailureRecord, 'when' | 'provider'>): void => {
    pushFailure(entry)
  }

  const pushFailure = (entry: Omit<FailureRecord, 'when' | 'provider'>): void => {
    failures.push({ when: now(), provider: config.name, ...entry })
    while (failures.length > logSize) failures.shift()
  }

  const getRecentFailures = (): ReadonlyArray<FailureRecord> => [...failures].reverse()

  const onChange = (listener: MonitorListener): (() => void) => {
    listeners.push(listener)
    return () => {
      const idx = listeners.indexOf(listener)
      if (idx >= 0) listeners.splice(idx, 1)
    }
  }

  const computeNextDelay = (): number | null => {
    refreshStaticIfNeeded()
    switch (state.sub) {
      case 'no_key':
      case 'disabled':
      case 'down':
        return null
      case 'backoff': {
        if (state.retryAt === null) return healthyMs
        const remaining = state.retryAt - now()
        return remaining > 0 ? remaining + 100 : 100
      }
      case 'unhealthy': {
        const idx = Math.min(unhealthyStep, unhealthySeq.length - 1)
        const ms = unhealthySeq[idx] ?? healthyMs
        unhealthyStep = Math.min(unhealthyStep + 1, unhealthySeq.length - 1)
        return ms
      }
      case 'ok':
      default:
        return healthyMs
    }
  }

  const scheduleNextHeartbeat = (): void => {
    if (timer !== null) { clearT(timer); timer = null }
    if (!gateway) return
    const delay = computeNextDelay()
    if (delay === null) return
    timer = setT(() => { void runHeartbeat() }, delay)
  }

  const runHeartbeat = async (): Promise<void> => {
    timer = null
    if (!gateway) return
    if (!isActive()) {
      // Paused — re-check in one healthy interval. We deliberately do NOT
      // hit the network just to learn nobody's watching.
      timer = setT(() => { void runHeartbeat() }, healthyMs)
      return
    }
    if (refreshStaticIfNeeded()) {
      // Static states don't get heartbeat traffic; reschedule cheaply.
      timer = setT(() => { void runHeartbeat() }, healthyMs)
      return
    }
    if (state.sub === 'backoff' && state.retryAt !== null && now() < state.retryAt) {
      // Still inside provider-declared cooldown — wait it out, do not poll.
      timer = setT(() => { void runHeartbeat() }, state.retryAt - now() + 100)
      return
    }
    try {
      await gateway.refreshModels()
      const count = gateway.getHealth().availableModels.length
      recordHeartbeat(true, count)
    } catch (err) {
      recordHeartbeat(false, state.modelCount, err)
    }
  }

  const start = (gw: ProviderGateway): void => {
    gateway = gw
    // Seed modelCount from current gateway health (warm-up may have run).
    const currentCount = gw.getHealth().availableModels.length
    if (currentCount !== state.modelCount) setState({ modelCount: currentCount })
    // Subscribe so warm-up's later refreshModels() (which fires onHealthChange)
    // updates the monitor immediately rather than waiting for the next
    // heartbeat tick — otherwise the API reports modelCount=0 for the first
    // 90s after every server restart.
    gw.onHealthChange((h) => {
      if (h.availableModels.length !== state.modelCount) {
        setState({ modelCount: h.availableModels.length })
      }
    })
    scheduleNextHeartbeat()
  }

  const dispose = (): void => {
    if (timer !== null) { clearT(timer); timer = null }
    listeners.length = 0
    gateway = null
  }

  // Wrap getState so an external observer (admin endpoint) sees the live
  // result of hasKey()/isUserEnabled() even if the provider-keys callback
  // didn't notify us explicitly.
  const getStateLive = (): MonitorState => {
    refreshStaticIfNeeded()
    return state
  }

  return {
    name: config.name,
    mayCall,
    getState: getStateLive,
    recordChatOutcome,
    recordHeartbeat,
    markUnhealthy,
    setHasKey,
    setUserEnabled,
    setIsActive,
    recordFailure,
    getRecentFailures,
    onChange,
    start,
    dispose,
  }
}

const deriveStaticSub = (
  kind: 'cloud' | 'ollama',
  hasKey: boolean,
  userEnabled: boolean,
): MonitorSubState => {
  if (!userEnabled) return 'disabled'
  if (kind === 'cloud' && !hasKey) return 'no_key'
  return 'ok'
}
