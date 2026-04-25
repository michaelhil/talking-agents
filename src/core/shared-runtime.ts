// ============================================================================
// SharedRuntime — the slice of System that's safe to share across multiple
// instances. Built once at boot; reused by every createSystem call to avoid
// duplicating provider gateways, API-quota state, and the LLM router.
//
// What's shared:
//   - ProviderRouter (llm) — failover logic + per-provider cooldown map.
//     Shared on purpose: API-quota cost is per host, not per instance.
//   - Ollama gateway + raw + ollamaUrls — single ps poll, single keep-alive
//     state, single URL list editable from any instance's UI.
//   - ProviderKeys + gateways — runtime key edits visible everywhere.
//   - ProviderConfig — boot-time decision (order, single-Ollama mode, …).
//
// What stays per-instance (built fresh by createSystem):
//   - House (rooms, agents, artifacts, messages, members, mute/pause)
//   - Team
//   - Tool registry (house-bound built-ins must rebuild)
//   - Skill store
//   - Logging sink
//   - Summary scheduler
//   - All event-callback late-binding slots
// ============================================================================

import type { ProviderConfig } from '../llm/providers-config.ts'
import type { ProviderSetupResult } from '../llm/providers-setup.ts'
import type { ProviderKeys } from '../llm/provider-keys.ts'
import type { Tool } from '../core/types/tool.ts'
import type { ProviderRoutingEvent } from '../llm/router.ts'
import { parseProviderConfig } from '../llm/providers-config.ts'
import { buildProvidersFromConfig } from '../llm/providers-setup.ts'
import { createProviderKeys } from '../llm/provider-keys.ts'
import { mergeWithEnv } from '../llm/providers-store.ts'

export interface SharedRuntime {
  readonly providerConfig: ProviderConfig
  readonly providerKeys: ProviderKeys
  readonly providerSetup: ProviderSetupResult
  // MCP-backed tools loaded ONCE per process at boot (each MCP server is
  // a stdio child process; we don't want N children for N instances).
  // Each instance's createSystem registers these definitions into its
  // own ToolRegistry — the underlying connection is shared.
  // Mutable list so bootstrap can populate after construction.
  mcpTools: Tool[]
  // Provider routing events fan out via a single listener on the shared
  // router. The dispatcher is set once by the SystemRegistry, which has
  // the agentId → instanceId reverse index. Default: noop.
  setProviderEventDispatcher: (fn: (event: ProviderRoutingEvent) => void) => void
}

export interface CreateSharedRuntimeOptions {
  readonly providerConfig?: ProviderConfig
  // For tests that want to inject a pre-built setup (matches the
  // previous CreateSystemOptions.providerSetup escape hatch).
  readonly providerSetup?: ProviderSetupResult
}

export const createSharedRuntime = (
  opts: CreateSharedRuntimeOptions = {},
): SharedRuntime => {
  const providerConfig = opts.providerConfig ?? parseProviderConfig()

  // Mutable runtime registry of API keys. Boot-time keys (env or stored)
  // are seeded from providerConfig.cloud; later UI edits flow through here
  // without restart.
  const providerKeys = createProviderKeys(
    mergeWithEnv({ version: 1, providers: {} }, { env: {} as Record<string, string | undefined> }),
  )
  for (const [name, cc] of Object.entries(providerConfig.cloud)) {
    if (cc?.apiKey) providerKeys.set(name, cc.apiKey)
  }

  const providerSetup =
    opts.providerSetup ?? buildProvidersFromConfig(providerConfig, { providerKeys })

  // Single listener on the shared router. The registered dispatcher
  // (set by SystemRegistry) routes events to the correct per-instance
  // subscriber via the agentId reverse index.
  let dispatcher: (event: ProviderRoutingEvent) => void = () => { /* noop */ }
  providerSetup.router.onRoutingEvent((event) => {
    try { dispatcher(event) } catch (err) {
      console.error(`[provider-event] dispatch threw: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  const mcpTools: Tool[] = []
  return {
    providerConfig,
    providerKeys,
    providerSetup,
    mcpTools,
    setProviderEventDispatcher: (fn) => { dispatcher = fn },
  }
}
