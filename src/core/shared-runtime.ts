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
//   - sharedToolRegistry — external tools, skill-bundled tools, pack-bundled
//     tools, MCP tools, write_skill / write_tool / install_pack et al.
//     Single FS scan at boot, no per-instance reload thrash. Pack installed
//     in instance A is immediately visible to instance B.
//   - sharedSkillStore — every loaded skill (pack and free-standing). Each
//     instance reads from the same store; install/uninstall mutate one place.
//
// What stays per-instance (built fresh by createSystem):
//   - House (rooms, agents, artifacts, messages, members, mute/pause)
//   - Team
//   - Tool-registry OVERLAY — house-bound built-ins (createListRoomsTool,
//     createAddArtifactTool, etc.) layered above sharedToolRegistry.
//   - Logging sink
//   - Summary scheduler
//   - Script store (still per-instance — file-backed; future Phase B'
//     candidate, parallel to skillStore here)
//   - All event-callback late-binding slots
// ============================================================================

import type { ProviderConfig } from '../llm/providers-config.ts'
import type { ProviderSetupResult } from '../llm/providers-setup.ts'
import type { ProviderKeys } from '../llm/provider-keys.ts'
import type { Tool, ToolRegistry } from '../core/types/tool.ts'
import type { ProviderRoutingEvent } from '../llm/router.ts'
import type { SkillStore } from '../skills/loader.ts'
import { parseProviderConfig } from '../llm/providers-config.ts'
import { buildProvidersFromConfig } from '../llm/providers-setup.ts'
import { createProviderKeys } from '../llm/provider-keys.ts'
import { mergeWithEnv } from '../llm/providers-store.ts'
import { createToolRegistry } from './tool-registry.ts'
import { createSkillStore } from '../skills/loader.ts'
import { createLimitMetrics, type LimitMetrics } from './limit-metrics.ts'
import { createWikiRegistry, type WikiRegistry } from '../wiki/registry.ts'

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
  // Process-global counters for cap/limit hits. Read-only API; the only
  // mutator is the inc() method on the metrics object itself.
  readonly limitMetrics: LimitMetrics
  // Shared tool registry — populated at boot by bootstrap.ts (external tools,
  // skill-bundled tools, pack-bundled tools, MCP tools) and subsequently
  // mutated only by install/uninstall_pack and write_skill/write_tool. Per-
  // instance Systems wrap this in an overlay (createOverlayToolRegistry).
  readonly sharedToolRegistry: ToolRegistry
  // Shared skill store — populated alongside sharedToolRegistry. Each
  // instance reads from the same store, so installing a pack in instance A
  // makes its skills visible in instance B without an instance reload.
  readonly sharedSkillStore: SkillStore
  // Shared wiki registry — owns all configured wikis, in-memory cache, and
  // catalog generation. Single source so two instances bound to the same
  // wiki share one warmed cache.
  readonly wikiRegistry: WikiRegistry
}

export interface CreateSharedRuntimeOptions {
  readonly providerConfig?: ProviderConfig
  // TEST-ONLY: inject a pre-built setup (matches the previous
  // CreateSystemOptions.providerSetup escape hatch). Production code
  // does NOT pass this — bootstrap.ts goes through src/boot/provider-stack.ts
  // which constructs the setup once and passes it here together with
  // matching providerKeys. If you find yourself adding `providerSetup`
  // outside a test, you're recreating the dual-path bug d0c1f73 fixed.
  // The wiring contract is enforced by:
  //   - src/boot/validate.ts (checks providerKeys is on the System)
  //   - src/boot/bootstrap-e2e.test.ts (end-to-end boot path)
  readonly providerSetup?: ProviderSetupResult
  // Optional pre-built metrics handle. Bootstrap supplies one so the same
  // instance can be passed to buildProvidersFromConfig before SharedRuntime
  // exists. Tests/headless paths omit and we lazy-create.
  readonly limitMetrics?: LimitMetrics
  // Optional pre-built provider keys store. Bootstrap supplies this so the
  // SAME ProviderKeys instance flows into both `buildProvidersFromConfig`
  // (used by bootstrap to wire limitMetrics into adapters) AND SharedRuntime.
  // Without this, bootstrap built providerSetup with NO providerKeys → router
  // had `isProviderEnabled = undefined` → every provider (including keyless
  // anthropic) was tried on every request → Helper got `[pass] LLM error:
  // anthropic auth error 401` on samsinn.app.
  readonly providerKeys?: ProviderKeys
}

export const createSharedRuntime = (
  opts: CreateSharedRuntimeOptions = {},
): SharedRuntime => {
  const providerConfig = opts.providerConfig ?? parseProviderConfig()

  // Mutable runtime registry of API keys. Boot-time keys (env or stored)
  // are seeded from providerConfig.cloud; later UI edits flow through here
  // without restart.
  const providerKeys = opts.providerKeys ?? createProviderKeys(
    mergeWithEnv({ version: 1, providers: {} }, { env: {} as Record<string, string | undefined> }),
  )
  // Only seed from cloud config when we constructed the keys here. If the
  // caller supplied them, they've already been populated.
  if (!opts.providerKeys) {
    for (const [name, cc] of Object.entries(providerConfig.cloud)) {
      if (cc?.apiKey) providerKeys.set(name, cc.apiKey)
    }
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
  const limitMetrics = opts.limitMetrics ?? createLimitMetrics()
  // Empty at construction — bootstrap.ts populates with external tools,
  // skills (which register their bundled tools), packs, MCP tools, and the
  // codegen/pack admin tools. createSystem then wraps this in an overlay.
  const sharedToolRegistry = createToolRegistry()
  const sharedSkillStore = createSkillStore()
  // Empty wiki list at construction — bootstrap.ts loads from wikis.json and
  // calls setWikis + warm asynchronously.
  const wikiRegistry = createWikiRegistry({ wikis: [] })
  return {
    providerConfig,
    providerKeys,
    providerSetup,
    mcpTools,
    setProviderEventDispatcher: (fn) => { dispatcher = fn },
    limitMetrics,
    sharedToolRegistry,
    sharedSkillStore,
    wikiRegistry,
  }
}
