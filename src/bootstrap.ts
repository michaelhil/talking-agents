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
// ============================================================================

import { createSharedRuntime } from './core/shared-runtime.ts'
import { createLimitMetrics } from './core/limit-metrics.ts'
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
import { parseProviderConfig, summariseProviderConfig } from './llm/providers-config.ts'
import { buildProvidersFromConfig, warmProviderModels } from './llm/providers-setup.ts'
import { loadProviderStore, mergeWithEnv } from './llm/providers-store.ts'
import { parseLogConfigFromEnv } from './logging/config.ts'
import { sharedPaths } from './core/paths.ts'
import { createToolRegistry } from './core/tool-registry.ts'
import { generateInstanceId } from './api/instance-cookie.ts'
import { wireSystemEvents } from './api/wire-system-events.ts'
import { createWSManager } from './api/ws-handler.ts'
import { initSharedLimiter } from './api/routes/instances.ts'
// Process-wide tool factories. Anything that doesn't bind to a per-instance
// `house` registers into shared.sharedToolRegistry once at boot, not per
// instance — see registerSharedTools below.
import {
  createPassTool, createGetTimeTool, createTestToolTool, createListSkillsTool,
  createWebTools, createWriteSkillTool, createWriteToolTool, createPackTools,
} from './tools/built-in/index.ts'
import type { System } from './main.ts'

const DRAIN_TIMEOUT_MS = 5_000

export const bootstrap = async (): Promise<void> => {
  const headless = process.argv.includes('--headless')
  const ephemeral = process.env.SAMSINN_EPHEMERAL === '1'

  if (headless) {
    const stderrLog = (...args: unknown[]) => console.error(...args)
    console.log = stderrLog
    console.info = stderrLog
  }

  // === Provider config + shared runtime ===
  const providersStorePath = sharedPaths.providers()
  const { data: storeData, warnings: storeWarnings } = await loadProviderStore(providersStorePath)
  for (const w of storeWarnings) console.warn(`[providers.json] ${w}`)
  const fileStore = mergeWithEnv(storeData)

  const providerConfig = parseProviderConfig({ fileStore })
  // Build the metrics handle first so the same instance flows into both
  // the cloud-provider adapters (SSE-overflow tracking) and SharedRuntime.
  const limitMetrics = createLimitMetrics()
  const providerSetup = buildProvidersFromConfig(providerConfig, { limitMetrics })
  const shared = createSharedRuntime({ providerConfig, providerSetup, limitMetrics })
  // Wire the shared rate-limiter with the global metrics handle so LRU
  // evictions are counted. Idempotent — safe if called more than once.
  initSharedLimiter(shared.limitMetrics)

  const pkg = await Bun.file(`${import.meta.dir}/../package.json`).json() as { version: string }
  console.log(`Samsinn v${pkg.version}${headless ? ' (headless)' : ''}`)
  if (ephemeral) console.log('[bootstrap] ephemeral mode — snapshot disabled')
  console.log(summariseProviderConfig(providerConfig))

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

  // === Track new agents for the provider-event reverse index ===
  // Bun JS is single-threaded; mutating system function references via
  // Object.assign at construction time is safe before any agents spawn.
  const wireAgentTracking = (system: System, instanceId: string,
    attach: (agentId: string, instanceId: string) => void,
    detach: (agentId: string) => void): void => {
    const origSpawnAI = system.spawnAIAgent
    const origSpawnHuman = system.spawnHumanAgent
    const origRemove = system.removeAgent
    Object.assign(system, {
      spawnAIAgent: async (cfg: Parameters<typeof origSpawnAI>[0], opts?: Parameters<typeof origSpawnAI>[1]) => {
        const agent = await origSpawnAI(cfg, opts)
        attach(agent.id, instanceId)
        return agent
      },
      spawnHumanAgent: async (cfg: Parameters<typeof origSpawnHuman>[0], send: Parameters<typeof origSpawnHuman>[1]) => {
        const agent = await origSpawnHuman(cfg, send)
        attach(agent.id, instanceId)
        return agent
      },
      removeAgent: (id: string) => {
        const ok = origRemove(id)
        if (ok) detach(id)
        return ok
      },
    })
  }

  // === WS manager — lifecycle owned here ===
  // Built before the registry so onSystemCreated can call wireSystemEvents
  // The wsManager is registry-aware: buildSnapshot and subscribeAgentState
  // resolve the live System per instanceId rather than closing over a single
  // boot system. State subscriptions broadcast scoped to the originating
  // instance via broadcastToInstance.
  let wsManager: ReturnType<typeof createWSManager> | undefined

  // === SystemRegistry ===
  const registry = createSystemRegistry({
    shared,
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
      wireAgentTracking(system, id, registry.attachAgent, registry.detachAgent)
      // Default room if empty (first-time creation only).
      if (system.house.listAllRooms().length === 0) {
        system.house.createRoomSafe({ name: 'general', createdBy: 'system' })
      }
      // Wire WS broadcasts + autosave. autoSaver is passed in (registry
      // map entry isn't set until buildSystem returns). wsManager only
      // exists for the HTTP runtime — headless boots a system before
      // wsManager is built and runs without WS.
      if (wsManager) wireSystemEvents(system, wsManager, autoSaver, id)
    },
    onSystemEvicted: (system, id) => {
      // Close WS sessions for this instance — they hold dangling references.
      if (wsManager) {
        for (const [token, sess] of [...wsManager.sessions]) {
          if (sess.instanceId !== id) continue
          const ws = wsManager.wsConnections.get(token) as { close?: (code: number, reason?: string) => void } | undefined
          try { ws?.close?.(1001, 'instance evicted') } catch { /* ignore */ }
          wsManager.sessions.delete(token)
          wsManager.wsConnections.delete(token)
        }
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
  // Build the boot system (any cookie-less request lands here too via the
  // bootstrap registry path). Provider event dispatcher already routes by
  // agentId so this is just the seed instance.
  const bootInstanceId = generateInstanceId()
  const bootSystem = await registry.getOrLoad(bootInstanceId)
  // wsManager is registry-aware: snapshot building + state subscriptions
  // resolve the live System per instanceId. Ollama is shared across
  // instances (one gateway in SharedRuntime) — we read it from the boot
  // system, but any active system would yield the same gateway reference.
  wsManager = createWSManager({
    getSystem: (id) => registry.tryGetLive(id),
    limitMetrics: shared.limitMetrics,
  })

  // Now that wsManager exists, re-wire the boot system's events (the
  // first onSystemCreated ran with wsManager=undefined).
  {
    const autoSaver = registry.autoSaverFor(bootInstanceId)
    if (autoSaver) wireSystemEvents(bootSystem, wsManager, autoSaver, bootInstanceId)
  }

  // Warm provider model caches (best-effort, after first instance exists
  // so the router has someone to log against).
  const warmResults = await warmProviderModels(providerSetup.gateways)
  for (const [name, result] of Object.entries(warmResults)) {
    if (result.status === 'ok') console.log(`  ${name}: ${result.count} models available`)
    else console.warn(`  ${name}: warm-up failed — ${result.message}`)
  }

  console.log(`Tools: ${bootSystem.toolRegistry.list().map(t => t.name).join(', ')}`)

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
      // Materialize so the directory exists on disk before the next listOnDisk.
      await registry.getOrLoad(newId)
      return { id: newId }
    },
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

  // === HTTP + WS server ===
  const { createServer } = await import('./api/server.ts')
  createServer({
    registry,
    wsManager,
    port: parseInt(process.env.PORT ?? String(DEFAULTS.port), 10),
    resetInstance,
    instances: instancesAdmin,
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
    try { await bootSystem.logging.configure({ enabled: false }) } catch { /* noop */ }
    await mcpDisconnect()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
