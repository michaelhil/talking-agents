// ============================================================================
// Bootstrap — Startup logic for direct execution.
//
// Builds the shared runtime, the SystemRegistry, the WS manager, the
// janitor, and either the HTTP+WS server or the headless MCP stdio server.
//
// Multi-tenant: SystemRegistry holds N per-cookie systems. Each one is
// lazy-loaded on first request, evicted after SAMSINN_IDLE_MS (default
// 30 min), and persisted at $SAMSINN_HOME/instances/<id>/snapshot.json.
// Shared runtime: provider router, gateways, ProviderKeys, MCP tools.
//
// === Construction order (matters; do not reshuffle without thinking) ===
//
//   1. SharedRuntime  — provider router, gateways, shared registry/store.
//   2. MCP tools      — register into shared.sharedToolRegistry once.
//   3. Process tools  — pure / network / codegen tools registered once
//                       into shared (gated by SAMSINN_ENABLE_*).
//   4. SystemRegistry — onSystemCreated hook closes over wsManager (set in 5).
//   5. wsManager      — assigned BEFORE any registry.getOrLoad runs, so
//                       the hook always sees a defined value. Failure to
//                       respect this is how 5d73a8e happened: any cookie-
//                       bound instance whose onSystemCreated fired with
//                       wsManager undefined silently skipped wireSystemEvents.
//   6. Pack admin     — install/update/uninstall_pack registered last
//                       because they need the cross-instance refresh
//                       callback that walks `registry.list()`.
//   7. Boot system    — getOrLoad seeds the first cookieless visitor.
//                       wsManager already exists; onSystemCreated wires it.
//   8. Janitor + timers + HTTP server.
//
// Single wiring path: every instance (boot AND cookie-bound) gets its
// broadcasts wired by the same onSystemCreated hook. There is NO rescue
// branch elsewhere in this file. If you find yourself reaching for one,
// the lifecycle invariant above is broken — fix it there.
// ============================================================================

import { createSystemRegistry } from './core/system-registry.ts'
import { startJanitor } from './core/instance-cleanup.ts'
import { DEFAULTS } from './core/types/constants.ts'
import { registerAllMCPServers } from './integrations/mcp/client.ts'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadExternalTools } from './tools/loader.ts'
import { loadSkills } from './skills/loader.ts'
import { loadAllPacks } from './packs/loader.ts'
import { asAIAgent } from './agents/shared.ts'
import { warmProviderModels } from './llm/providers-setup.ts'
import { loadWikiStore } from './wiki/store.ts'
import { resolveActiveWikis } from './wiki/resolve-active.ts'
import { createWikiTools } from './tools/built-in/wiki-tools.ts'
import { parseLogConfigFromEnv } from './logging/config.ts'
import { sharedPaths } from './core/paths.ts'
import { createToolRegistry } from './core/tool-registry.ts'
import { generateInstanceId } from './api/instance-cookie.ts'
import { wireSystemEvents } from './api/wire-system-events.ts'
import { wireAgentTracking } from './api/agent-tracking.ts'
import { validateBootstrap } from './boot/validate.ts'
import { buildProviderStack, summariseProviders } from './boot/provider-stack.ts'
import { createWSManager } from './api/ws-handler.ts'
// Process-wide tool factories. Anything that doesn't bind to a per-instance
// `house` registers into shared.sharedToolRegistry once at boot, not per
// instance — see registerSharedTools below.
import {
  createPassTool, createGetTimeTool, createTestToolTool, createListSkillsTool,
  createWebTools, createWriteSkillTool, createWriteToolTool, createPackTools,
  createGeoLookupTool, createGeoAddTool, createGeoRemoveTool,
} from './tools/built-in/index.ts'

const DRAIN_TIMEOUT_MS = 5_000

export const bootstrap = async (): Promise<void> => {
  const headless = process.argv.includes('--headless')
  const ephemeral = process.env.SAMSINN_EPHEMERAL === '1'

  if (headless) {
    const stderrLog = (...args: unknown[]) => console.error(...args)
    console.log = stderrLog
    console.info = stderrLog
  }

  // === Provider stack ===
  // All the wiring (config → keys → setup → SharedRuntime) lives in one
  // place: src/boot/provider-stack.ts. That's where the bug class fixed
  // in commits f04e61e / d0c1f73 / 3729e50 surfaced; isolating the order
  // keeps the contract obvious.
  const { providerConfig, shared } = await buildProviderStack()
  const providerSetup = shared.providerSetup

  const pkg = await Bun.file(`${import.meta.dir}/../package.json`).json() as { version: string }
  console.log(`Samsinn v${pkg.version}${headless ? ' (headless)' : ''}`)
  if (ephemeral) console.log('[bootstrap] ephemeral mode — snapshot disabled')
  console.log(summariseProviders(providerConfig))

  // === Boot logging template ===
  // Each per-instance system applies this in its onSystemCreated hook.
  const bootLogConfig = parseLogConfigFromEnv()

  // === MCP tools — load once at boot ===
  // Each MCP server is a stdio child process. We register the Tool[]
  // definitions directly into shared.sharedToolRegistry so every per-instance
  // overlay can resolve them; the underlying connection is shared. Also kept
  // on shared.mcpTools as a list for any consumer that needs the raw set.
  const mcpConfigPath = `${import.meta.dir}/../mcp-servers.json`
  let mcpDisconnect = async (): Promise<void> => {}
  if (existsSync(mcpConfigPath)) {
    const tempRegistry = createToolRegistry()
    const result = await registerAllMCPServers(tempRegistry, await Bun.file(mcpConfigPath).json())
    shared.mcpTools.push(...tempRegistry.list())
    for (const tool of tempRegistry.list()) {
      try { shared.sharedToolRegistry.register(tool) } catch { /* duplicate ignored */ }
    }
    mcpDisconnect = result.disconnect
  }

  // === Process-wide tool/skill/pack scan — once, into shared ===
  // Single FS scan: external tools, free-standing skills (cwd + samsinn-home),
  // and packs all register into the SHARED registry/store. Per-instance
  // Systems wrap this in an overlay (see createSystem in main.ts).
  // Replaces the old per-instance loaders that ran inside onSystemCreated
  // and re-scanned everything for every cookie that hit the server.
  await loadExternalTools(shared.sharedToolRegistry)
  await loadSkills(resolve(process.cwd(), 'skills'), shared.sharedSkillStore, shared.sharedToolRegistry)
  await loadSkills(sharedPaths.skills(), shared.sharedSkillStore, shared.sharedToolRegistry)
  await loadAllPacks(sharedPaths.packs(), shared.sharedToolRegistry, shared.sharedSkillStore)

  // === Process-wide built-in tools (no per-instance state) ===
  // Anything that doesn't bind to a per-instance House registers ONCE here.
  // House-bound tools (room ops, artifacts, post_to_room, …) stay in
  // createSystem and live in the per-instance overlay.
  const isDeployMode = !!(process.env.SAMSINN_TOKEN && process.env.SAMSINN_TOKEN.length > 0)
  const flag = (name: string, defaultOn: boolean): boolean => {
    const v = process.env[name]
    if (v === '1') return true
    if (v === '0') return false
    return defaultOn
  }
  const networkToolsEnabled = flag('SAMSINN_ENABLE_NETWORK_TOOLS', !isDeployMode)
  // codegenEnabled gates write_skill + write_tool only — agents writing
  // arbitrary TypeScript into ~/.samsinn/. Default-off in deploy mode is
  // the right call there.
  const codegenEnabled = flag('SAMSINN_ENABLE_CODEGEN', !isDeployMode)
  // packsEnabled gates install/update/uninstall/list_packs and
  // list_available_packs — installing a vetted GitHub pack is a different
  // threat profile (you trust the pack's source) than an agent producing
  // arbitrary TS. Default-on everywhere; operator can flip to 0 to lock
  // the runtime to whatever is on disk at boot.
  const packsEnabled = flag('SAMSINN_ENABLE_PACKS', true)

  shared.sharedToolRegistry.register(createPassTool())
  shared.sharedToolRegistry.register(createGetTimeTool())
  shared.sharedToolRegistry.register(createTestToolTool(shared.sharedToolRegistry))
  shared.sharedToolRegistry.register(createListSkillsTool(shared.sharedSkillStore))
  // Geo tools — process-wide; they operate on the shared geodata store at
  // ~/.samsinn/geodata/ and a process-pinned bundled snapshot.
  shared.sharedToolRegistry.register(createGeoLookupTool())
  shared.sharedToolRegistry.register(createGeoAddTool())
  shared.sharedToolRegistry.register(createGeoRemoveTool())
  for (const tool of createWikiTools(shared.wikiRegistry)) {
    shared.sharedToolRegistry.register(tool)
  }

  // Wikis: install the auto-warm hook on the registry so any newly-seen
  // id (from initial reconcile here, or a later resolveActiveWikis call
  // triggered by a route handler when discovery picks up new wikis) gets
  // warmed in the background. One source of truth for "wiki appeared →
  // warm it" — no duplicate logic in route handlers.
  shared.wikiRegistry.setOnNewWiki((wikiId) => {
    shared.wikiRegistry.warm(wikiId)
      .then(({ pageCount, warnings }) => {
        console.log(`[wiki:${wikiId}] warmed ${pageCount} pages${warnings.length ? ` (${warnings.length} warnings)` : ''}`)
        for (const ww of warnings) console.warn(`[wiki:${wikiId}] ${ww}`)
      })
      .catch((err) => console.error(`[wiki:${wikiId}] warm failed: ${(err as Error).message}`))
  })
  // Initial reconcile + warm. Best-effort: discovery might be down at boot;
  // the next resolveActiveWikis call (from any GET /api/wikis) will retry.
  // Per-wiki warm fires from the onNewWiki hook above.
  const { warnings: wikiWarnings } = await loadWikiStore(sharedPaths.wikis())
  for (const w of wikiWarnings) console.warn(`[wikis.json] ${w}`)
  try {
    const merged = await resolveActiveWikis(sharedPaths.wikis(), shared.wikiRegistry)
    console.log(`[wiki] reconciled — ${merged.filter((w) => w.enabled).length} active`)
  } catch (err) {
    console.warn(`[wiki] initial reconcile failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (networkToolsEnabled) {
    shared.sharedToolRegistry.registerAll(createWebTools({
      tavilyApiKey: process.env.TAVILY_API_KEY,
      braveApiKey: process.env.BRAVE_API_KEY,
      googleApiKey: process.env.GOOGLE_CSE_API_KEY,
      googleCseId: process.env.GOOGLE_CSE_ID,
    }))
  }
  if (codegenEnabled) {
    // write_skill writes a SKILL.md file and registers into the shared store —
    // visible across instances immediately. write_tool / pack admin land
    // below, after `registry` exists (they need cross-instance refresh).
    shared.sharedToolRegistry.register(createWriteSkillTool(shared.sharedSkillStore, sharedPaths.skills()))
  }

  // === Per-agent wiring on spawn/remove ===
  // Implementation lives in src/api/agent-tracking.ts so the regression test
  // (src/api/agent-state-wiring.test.ts) exercises the SAME code that runs
  // in production. Do not duplicate the wrapper logic here.

  // === SystemRegistry ===
  // The onSystemCreated hook closes over `wsManager` (assigned right after
  // createSystemRegistry returns, before any `registry.getOrLoad()` call).
  // The hook always sees a defined value. In headless mode the wsManager is
  // constructed but never accepts upgrades — no WS clients connect.
  // Definite-assignment assertion (`!`) is fine: the assignment site below
  // runs synchronously before any registry consumer code.
  let wsManager!: ReturnType<typeof createWSManager>

  // === SystemRegistry ===
  const registry = createSystemRegistry({
    shared,
    // Lazy validateBootstrap: fires once on the first successful getOrLoad.
    // Replaces the boot-time call against a throwaway boot system. Contract
    // still runs before any traffic actually reaches a System; we just
    // don't materialize an empty instance dir for the privilege.
    onFirstLoad: (system) => validateBootstrap(system),
    onSystemCreated: async (system, id, autoSaver) => {
      // No per-instance FS scans: external tools, skills, packs and MCP
      // tools all live in shared.sharedToolRegistry (populated above before
      // the registry was built). Per-instance toolRegistry is a thin overlay
      // that adds house-bound built-ins on top. See main.ts createSystem.
      // Configure logging from env template.
      try {
        await system.logging.configure(bootLogConfig)
      } catch (err) {
        console.error(`[logging] failed to apply boot config: ${err instanceof Error ? err.message : String(err)}`)
      }
      // Track agents for provider-event routing. Walk existing agents from
      // any snapshot restore; wrap spawn/remove for new ones.
      for (const agent of system.team.listAgents()) {
        registry.attachAgent(agent.id, id)
      }
      wireAgentTracking(system, id, {
        attach: registry.attachAgent,
        detach: registry.detachAgent,
        subscribeAgentState: wsManager.subscribeAgentState,
        unsubscribeAgentState: wsManager.unsubscribeAgentState,
      })
      // (Default-room fallback removed — seedFreshInstance below handles
      // the empty-instance case with a properly-themed 'demo' room and a
      // Helper agent. The old `general` fallback always created a room
      // BEFORE seed ran, so seed's `if rooms.length > 0 return` check
      // would short-circuit and Helper never spawned.)
      // Wire WS broadcasts + autosave. wsManager is guaranteed assigned
      // by the time any getOrLoad runs (see the `let wsManager!:` block
      // above). autoSaver is passed in directly because the registry map
      // entry isn't set until buildSystem returns.
      wireSystemEvents(system, wsManager, autoSaver, id)
    },
    onSystemEvicted: (system, id) => {
      // Close WS sessions for this instance — they hold dangling references.
      for (const [token, sess] of [...wsManager.sessions]) {
        if (sess.instanceId !== id) continue
        const ws = wsManager.wsConnections.get(token) as { close?: (code: number, reason?: string) => void } | undefined
        try { ws?.close?.(1001, 'instance evicted') } catch { /* ignore */ }
        wsManager.sessions.delete(token)
        wsManager.wsConnections.delete(token)
      }
      // Detach all agents from the reverse index — late provider events
      // for evicted agents drop silently. (per-agent detach also fires on
      // removeAgent; this catches the bulk evict path where individual
      // removes don't run.)
      for (const a of system.team.listAgents()) {
        registry.detachAgent(a.id)
      }
    },
  })

  // === Cross-instance refresh + pack-change notification ===
  // Tool changes (install_pack, write_tool) need to propagate to every live
  // instance, not just the one whose agent triggered the change. The shared
  // toolRegistry is already updated; what we still need is to rebuild each
  // agent's frozen tool-executor and tool-definitions snapshot.
  const crossInstanceRefreshAllAgentTools = async (): Promise<void> => {
    for (const meta of registry.list()) {
      const sys = registry.tryGetLive(meta.id)
      if (!sys) continue
      try { await sys.refreshAllAgentTools() } catch (err) {
        console.error(`[refresh] instance ${meta.id}:`, err instanceof Error ? err.message : String(err))
      }
    }
  }

  // Drop a [admin] system note into every room with at least one AI agent
  // across every active instance. Without this an agent's chat history
  // keeps "tool unavailable" replies from before the install — Gemini and
  // others pattern-match against past output and keep claiming the tool
  // doesn't exist even with the right toolDefinitions in the request.
  const crossInstanceNotifyPacksChanged = (info: {
    readonly action: 'installed' | 'updated' | 'uninstalled'
    readonly namespace: string
    readonly tools: ReadonlyArray<string>
    readonly skills: ReadonlyArray<string>
  }): void => {
    const note = info.action === 'uninstalled'
      ? `[admin] Pack "${info.namespace}" was uninstalled. ${info.tools.length} tools and ${info.skills.length} skills are no longer available.`
      : `[admin] Pack "${info.namespace}" was ${info.action}. Tools available now: ${info.tools.join(', ') || '(none)'}. Skills: ${info.skills.join(', ') || '(none)'}. Disregard any earlier message claiming these were unavailable.`
    for (const meta of registry.list()) {
      const sys = registry.tryGetLive(meta.id)
      if (!sys) continue
      for (const room of sys.house.listAllRooms()) {
        const hasAi = sys.team.listByKind('ai').some(a =>
          sys.house.getRoomsForAgent(a.id).some(r => r.profile.id === room.id),
        )
        if (!hasAi) continue
        try {
          sys.routeMessage({ rooms: [room.id] }, {
            senderId: 'system', senderName: 'system',
            content: note, type: 'system',
          })
        } catch { /* ignore — best-effort */ }
      }
    }
  }

  // Now that registry exists, finish wiring shared tools that needed it.
  // Two independent gates: codegenEnabled covers write_tool (arbitrary TS
  // on disk); packsEnabled covers vetted GitHub pack management.
  if (codegenEnabled) {
    shared.sharedToolRegistry.register(createWriteToolTool(
      shared.sharedToolRegistry, shared.sharedSkillStore, crossInstanceRefreshAllAgentTools,
    ))
  }
  if (packsEnabled) {
    shared.sharedToolRegistry.registerAll(createPackTools({
      packsDir: sharedPaths.packs(),
      toolRegistry: shared.sharedToolRegistry,
      skillStore: shared.sharedSkillStore,
      refreshAllAgentTools: crossInstanceRefreshAllAgentTools,
      notifyPacksChanged: crossInstanceNotifyPacksChanged,
    }))
  }

  // === wsManager — assigned NOW (before any registry.getOrLoad runs) ===
  // wsManager is registry-aware: buildSnapshot and subscribeAgentState
  // resolve the live System per instanceId rather than closing over a
  // single boot system. State subscriptions broadcast scoped to the
  // originating instance via broadcastToInstance.
  // Order matters: this assignment MUST happen before the first getOrLoad,
  // otherwise the onSystemCreated hook would observe `wsManager` undefined
  // and silently skip wireSystemEvents — that was the source of a long
  // latent bug fixed in commit 5d73a8e. Pre-assigning wsManager keeps the
  // hook's wiring path single, with no rescue branch elsewhere.
  wsManager = createWSManager({
    getSystem: (id) => registry.tryGetLive(id),
    limitMetrics: shared.limitMetrics,
  })

  // Wire the per-provider monitor heartbeat to the live WS-client count.
  // While at least one client is connected the heartbeats run on their
  // adaptive cadence; with zero clients the heartbeats become no-ops and
  // an idle Samsinn (no open tab) consumes zero requests. Providers were
  // built before WSManager existed, so this is a post-construction wire-up.
  for (const monitor of Object.values(providerSetup.monitors)) {
    monitor.setIsActive(() => wsManager.sessionCount() > 0)
  }

  // === Provider routing event dispatcher (registry-aware) ===
  shared.setProviderEventDispatcher((event) => {
    if (!event.agentId) return   // events without an agentId can't be routed
    const instanceId = registry.instanceForAgent(event.agentId)
    if (!instanceId) return      // late event for evicted/removed agent
    // tryGetLive returns the in-memory system if it's currently active;
    // does NOT trigger a lazy-load (we don't want a late provider event
    // to resurrect an evicted instance just to dispatch one event).
    const sys = registry.tryGetLive(instanceId)
    if (!sys) return
    try { sys.dispatchProviderEvent(event) } catch { /* drop */ }
  })

  // === Boot the appropriate runtime ===
  if (headless) {
    // Headless: fresh instance per process boot. No janitor or eviction.
    const headlessId = generateInstanceId()
    const system = await registry.getOrLoad(headlessId)

    // wsManager not used in headless mode; create a stub so wireSystemEvents
    // (called inside onSystemCreated) ran with `wsManager === undefined`
    // and skipped wiring. That's intentional — there are no WS clients in
    // headless. Provider events dispatch through the shared listener
    // anyway; agent.dispatchProviderEvent still proxies to MCP if configured.

    // Warm provider model caches (best-effort).
    const warmResults = await warmProviderModels(providerSetup.gateways)
    for (const [name, result] of Object.entries(warmResults)) {
      if (result.status === 'ok') console.log(`  ${name}: ${result.count} models available`)
      else console.warn(`  ${name}: warm-up failed — ${result.message}`)
    }

    // Single contract check — every wiring invariant a bug has uncovered
    // gets a line in src/boot/validate.ts. Throwing here fails the boot
    // loud and clear instead of running with broken wiring.
    validateBootstrap(system)

    const { createMCPServer, wireEventNotifications, startMCPServerStdio } = await import('./integrations/mcp/server.ts')
    const mcpServer = createMCPServer(system, pkg.version)
    wireEventNotifications(system, mcpServer)
    await startMCPServerStdio(mcpServer)
    console.log('MCP server running on stdio')

    // Headless graceful shutdown.
    const shutdown = async (): Promise<void> => {
      const timeout = new Promise<void>(res => setTimeout(res, DRAIN_TIMEOUT_MS))
      const aiAgents = system.team.listAgents().flatMap(a => { const ai = asAIAgent(a); return ai ? [ai] : [] })
      await Promise.all(aiAgents.map(a => Promise.race([a.whenIdle(), timeout])))
      if (!ephemeral) {
        try { await registry.shutdown() } catch (err) { console.error('shutdown flush:', err) }
      }
      try { await system.logging.configure({ enabled: false }) } catch { /* noop */ }
      await mcpDisconnect()
      process.exit(0)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
    return
  }

  // === HTTP mode ===
  // No boot system. The first cookieless visitor (or a cookie-bound one)
  // creates their instance lazily via the HTTP path. validateBootstrap
  // runs on that first getOrLoad via onFirstLoad above. This eliminates
  // the boot-orphan instance dir that watch-mode reloads used to mint on
  // every restart — see commit log for the empty-instance-accumulation fix.

  // Warm provider model caches. Awaited synchronously: B3 of the audit
  // requires that warm complete BEFORE we accept traffic, so the router's
  // catalog filter has real data to work with (no optimistic-include).
  const warmResults = await warmProviderModels(providerSetup.gateways)
  for (const [name, result] of Object.entries(warmResults)) {
    if (result.status === 'ok') console.log(`  ${name}: ${result.count} models available`)
    else console.warn(`  ${name}: warm-up failed — ${result.message}`)
  }

  // Tool surface log — sourced from the shared registry (process-wide).
  // Per-instance overlays (house-bound built-ins) aren't included; those
  // are uniform across instances anyway.
  console.log(`Tools: ${shared.sharedToolRegistry.list().map(t => t.name).join(', ')}`)

  // === Janitor + idle-eviction timer ===
  const janitor = startJanitor({
    isActive: id => registry.list().some(m => m.id === id),
  })
  const evictTimer = setInterval(() => {
    void registry.evictIdle().catch(err =>
      console.error(`[registry] evictIdle: ${err instanceof Error ? err.message : String(err)}`),
    )
  }, 60_000)

  // Stale-session sweep — every hour, drop sessions whose WS has been
  // closed for >7d and remove the inactive human agent from its team.
  // Without this, every disconnected user accumulates forever until the
  // instance is evicted.
  const sessionSweepTimer = setInterval(() => {
    try { wsManager?.sweepStaleSessions() } catch (err) {
      console.error(`[ws] sweepStaleSessions: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, 60 * 60 * 1000)

  // === Per-instance reset ===
  // Trashes the cookie's instance dir; the same id persists. Browser
  // reconnects → registry creates fresh empty House under the same id.
  const resetInstance = async (req: Request) => {
    const { getInstanceId } = await import('./api/instance-cookie.ts')
    const id = getInstanceId(req)
    if (!id) return { ok: false as const, reason: 'no instance cookie' }
    try {
      await registry.resetInstance(id)
      return { ok: true as const, instanceId: id }
    } catch (err) {
      return { ok: false as const, reason: err instanceof Error ? err.message : String(err) }
    }
  }

  // === Instances admin ===
  // Capability bundle for the Instances modal under Settings. Delete reuses
  // registry.resetInstance (trashes the dir, drops in-memory state). The id
  // remains valid in principle, but listOnDisk no longer reports it.
  const { buildInstanceCookie } = await import('./api/instance-cookie.ts')
  const instancesAdmin = {
    listOnDisk: () => registry.listOnDisk(),
    liveIds: () => new Set(registry.list().map(m => m.id)),
    createNew: async () => {
      const newId = generateInstanceId()
      // Materialize in-memory so the live list reports it. We deliberately
      // do NOT touch disk here — empty instances no longer leave a dir
      // (see snapshot.ts:isEmptySnapshot + autosaver skip). The UI lists
      // the new instance by merging listOnDisk with liveIds().
      await registry.getOrLoad(newId)
      return { id: newId }
    },
    purgeTrash: () => registry.purgeTrash(),
    delete: async (id: string) => {
      try {
        await registry.resetInstance(id)
        return { ok: true as const }
      } catch (err) {
        return { ok: false as const, reason: err instanceof Error ? err.message : String(err) }
      }
    },
    buildSwitchCookie: (id: string, req: Request) => buildInstanceCookie(id, req),
  }

  // === Diagnostics capability ===
  // Read-only health snapshot. Walks the registry + wsManager state to
  // expose per-instance broadcast wiring + last-broadcast timestamps. The
  // signal that catches the silent-skip class of bug we just fixed: an
  // active instance with zero broadcasts under live traffic is wrong.
  const diagnostics = {
    snapshot: () => ({
      instances: registry.list().map(meta => {
        const sys = registry.tryGetLive(meta.id)
        return {
          id: meta.id,
          wired: wsManager.isWired(meta.id),
          agentCount: sys ? sys.team.listByKind('ai').length : 0,
          lastBroadcastAt: wsManager.lastBroadcastAt(meta.id),
        }
      }),
      wsSessions: wsManager.sessionCount(),
    }),
  }

  // === HTTP + WS server ===
  const { createServer } = await import('./api/server.ts')
  createServer({
    registry,
    wsManager,
    port: parseInt(process.env.PORT ?? String(DEFAULTS.port), 10),
    resetInstance,
    instances: instancesAdmin,
    diagnostics,
  })

  // === Graceful shutdown ===
  const shutdown = async (): Promise<void> => {
    console.log('Shutting down, saving snapshots...')
    janitor.stop()
    clearInterval(evictTimer)
    clearInterval(sessionSweepTimer)
    if (!ephemeral) {
      try { await registry.shutdown() } catch (err) { console.error('Failed to flush snapshots:', err) }
    }
    // Disable logging on every still-live instance. Process exit would close
    // the JSONL sinks anyway, but explicit configure({enabled:false}) lets
    // each instance flush a clean shutdown line first.
    for (const meta of registry.list()) {
      const sys = registry.tryGetLive(meta.id)
      if (sys) try { await sys.logging.configure({ enabled: false }) } catch { /* noop */ }
    }
    await mcpDisconnect()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
