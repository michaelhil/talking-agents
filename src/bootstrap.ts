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
import type { System } from './main.ts'
import type { Tool } from './core/types/tool.ts'

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
  const providerSetup = buildProvidersFromConfig(providerConfig)
  const shared = createSharedRuntime({ providerConfig, providerSetup })

  const pkg = await Bun.file(`${import.meta.dir}/../package.json`).json() as { version: string }
  console.log(`Samsinn v${pkg.version}${headless ? ' (headless)' : ''}`)
  if (ephemeral) console.log('[bootstrap] ephemeral mode — snapshot disabled')
  console.log(summariseProviderConfig(providerConfig))

  // === Boot logging template ===
  // Each per-instance system applies this in its onSystemCreated hook.
  const bootLogConfig = parseLogConfigFromEnv()

  // === MCP tools — load once at boot, replicate per instance ===
  // Each MCP server is a stdio child process. We use a temp tool registry
  // to capture the Tool[] definitions, then inject them into each
  // per-instance registry. The underlying connections are shared.
  const mcpConfigPath = `${import.meta.dir}/../mcp-servers.json`
  let mcpDisconnect = async (): Promise<void> => {}
  if (existsSync(mcpConfigPath)) {
    const tempRegistry = createToolRegistry()
    const result = await registerAllMCPServers(tempRegistry, await Bun.file(mcpConfigPath).json())
    shared.mcpTools.push(...tempRegistry.list())
    mcpDisconnect = result.disconnect
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
    onSystemCreated: async (system, id) => {
      // Per-instance loaders.
      await loadExternalTools(system.toolRegistry)
      await loadSkills(resolve(process.cwd(), 'skills'), system.skillStore, system.toolRegistry)
      await loadSkills(system.skillsDir, system.skillStore, system.toolRegistry)
      await loadAllPacks(system.packsDir, system.toolRegistry, system.skillStore)
      // Inject MCP tools (loaded once at boot, registered into each instance).
      for (const tool of shared.mcpTools as Tool[]) {
        try { system.toolRegistry.register(tool) } catch { /* duplicate ignored */ }
      }
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
      // Wire WS broadcasts + autosave. wsManager must exist by now.
      if (wsManager) {
        const autoSaver = registry.autoSaverFor(id)
        if (autoSaver) wireSystemEvents(system, wsManager, autoSaver, id)
      }
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
    getOllama: () => bootSystem.ollama,
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
