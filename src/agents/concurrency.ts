// ============================================================================
// ConcurrencyManager — Per-agent concurrency and state tracking.
//
// Owns: generatingContexts, pendingContexts, idleResolvers, stateSubscribers,
// and generationEpoch. Extracted from ai-agent.ts to keep that file focused
// on context building and evaluation.
//
// whenIdle() waits for both the generation loop and pending queue to drain.
// cancelAll() clears generation state — the generationEpoch guard ensures
// in-flight results from cancelled generations are silently discarded.
// ============================================================================

import type { AgentState, StateSubscriber, StateValue } from '../core/types.ts'

const AGENT_TIMEOUT_MS = 30_000

export interface ConcurrencyManager {
  readonly state: AgentState
  readonly isGenerating: (key: string) => boolean
  readonly startGeneration: (key: string) => void
  readonly endGeneration: (key: string) => void
  readonly addPending: (key: string) => void
  readonly consumePending: (key: string) => boolean
  readonly epochAtStart: () => number
  readonly isEpochCurrent: (epoch: number) => boolean
  readonly whenIdle: (timeoutMs?: number) => Promise<void>
  readonly cancelAll: () => void
  readonly notifyState: (value: StateValue, context?: string) => void
}

export const createConcurrencyManager = (agentId: string): ConcurrencyManager => {
  const generatingContexts = new Set<string>()
  const pendingContexts = new Set<string>()
  let idleResolvers: Array<() => void> = []
  const stateSubscribers = new Set<StateSubscriber>()
  let generationEpoch = 0

  const notifyState = (value: StateValue, context?: string): void => {
    for (const fn of stateSubscribers) fn(value, agentId, context)
  }

  const checkIdle = (): void => {
    if (generatingContexts.size === 0 && pendingContexts.size === 0) {
      const resolvers = idleResolvers
      idleResolvers = []
      for (const resolve of resolvers) resolve()
    }
  }

  const state: AgentState = {
    get: () => generatingContexts.size > 0 ? 'generating' : 'idle',
    subscribe: (fn: StateSubscriber) => {
      stateSubscribers.add(fn)
      return () => { stateSubscribers.delete(fn) }
    },
  }

  const whenIdle = (timeoutMs = AGENT_TIMEOUT_MS): Promise<void> => {
    if (generatingContexts.size === 0 && pendingContexts.size === 0) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`whenIdle timed out after ${timeoutMs}ms`)),
        timeoutMs,
      )
      idleResolvers.push(() => { clearTimeout(timer); resolve() })
    })
  }

  return {
    state,
    isGenerating: (key: string) => generatingContexts.has(key),
    startGeneration: (key: string) => { generatingContexts.add(key) },
    endGeneration: (key: string) => {
      generatingContexts.delete(key)
      notifyState('idle', key)
      checkIdle()
    },
    addPending: (key: string) => { pendingContexts.add(key) },
    consumePending: (key: string) => {
      if (!pendingContexts.has(key)) return false
      pendingContexts.delete(key)
      return true
    },
    epochAtStart: () => generationEpoch,
    isEpochCurrent: (epoch: number) => generationEpoch === epoch,
    whenIdle,
    cancelAll: () => {
      generationEpoch++
      generatingContexts.clear()
      pendingContexts.clear()
      const resolvers = idleResolvers
      idleResolvers = []
      for (const resolve of resolvers) resolve()
      notifyState('idle')
    },
    notifyState,
  }
}
