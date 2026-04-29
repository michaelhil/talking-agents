// ============================================================================
// validateBootstrap — single runtime contract check for the wired System.
//
// Called once per System construction (post bootstrap, pre-serve). Throws
// loudly with a message that names the bug class each contract guards.
//
// Why one function, not scattered asserts: every check lives in one file
// you can grep + extend. When a new wiring contract surfaces (because a
// new bug found a new gap), you add ONE line here and the boot fails fast
// at the next deploy if the wiring slips.
//
// Ordering matters: the contracts here represent layered invariants. If
// the lowest-level contract (e.g. providerKeys exists) is violated, the
// higher-level checks (gateways have valid config) are meaningless and
// will produce confusing follow-on errors. Keep checks in dependency order.
// ============================================================================

import type { System } from '../main.ts'

class BootstrapContractError extends Error {
  constructor(message: string, public readonly bugRef: string) {
    super(message)
    this.name = 'BootstrapContractError'
  }
}

const fail = (message: string, bugRef: string): never => {
  // bugRef is a commit SHA or doc anchor that explains why this contract
  // exists. When a future engineer hits this in CI, the message tells them
  // both what's missing AND how to look up why.
  throw new BootstrapContractError(`${message} [see ${bugRef}]`, bugRef)
}

export const validateBootstrap = (system: System): void => {
  // === Provider stack contracts ===

  // Contract 1: providerKeys must be wired into the System.
  // Without this, the router has no isProviderEnabled filter and walks
  // every provider in the order — including keyless ones (anthropic) —
  // producing 401 auth errors on every chat call.
  if (!system.providerKeys) {
    fail('providerKeys is missing on System', 'commit d0c1f73')
  }

  // Contract 2: every gateway in the configured order must have a positive
  // numeric maxConcurrent.
  // Without this, the gateway's semaphore is created with max=undefined,
  // every request queues forever and times out after 30s with
  // "LLM gateway queue timeout".
  for (const name of system.providerConfig.order) {
    const gw = system.gateways[name]
    if (!gw) continue                   // not constructed for this build (e.g. pinned single-Ollama)
    const cfg = gw.getConfig()
    if (typeof cfg.maxConcurrent !== 'number' || cfg.maxConcurrent <= 0) {
      fail(
        `gateway[${name}].maxConcurrent must be a positive number; got ${String(cfg.maxConcurrent)}`,
        'commit f04e61e',
      )
    }
  }

  // Contract 3: the router must be present.
  // Trivially true on every code path today, but pinned because every other
  // contract assumes the router exists.
  if (!system.llm) {
    fail('System.llm (ProviderRouter) is missing', 'arch invariant')
  }
}
