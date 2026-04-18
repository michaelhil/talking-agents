// ============================================================================
// Bootstrap — Startup logic for direct execution.
//
// Performs all initialization: env config, snapshot restore, tool loading,
// MCP client registration, signal handlers, then starts server or MCP stdio.
//
// Imported and called only when main.ts is run directly.
// ============================================================================

import { createSystem } from './main.ts'
import { DEFAULTS } from './core/types/constants.ts'
import { registerAllMCPServers } from './integrations/mcp/client.ts'
import { existsSync } from 'node:fs'
import { loadSnapshot, restoreFromSnapshot, createAutoSaver } from './core/snapshot.ts'
import { resolve } from 'node:path'
import { loadExternalTools } from './tools/loader.ts'
import { loadSkills } from './skills/loader.ts'
import { asAIAgent } from './agents/shared.ts'
import { parseProviderConfig, summariseProviderConfig } from './llm/providers-config.ts'
import { buildProvidersFromConfig, warmProviderModels } from './llm/providers-setup.ts'
import { loadProviderStore, mergeWithEnv } from './llm/providers-store.ts'
import { homedir } from 'node:os'
import { join as joinPath } from 'node:path'

const DRAIN_TIMEOUT_MS = 5_000

export const bootstrap = async (): Promise<void> => {
  const headless = process.argv.includes('--headless')

  // In headless mode, redirect console.log to stderr (stdout is reserved for MCP protocol)
  if (headless) {
    const stderrLog = (...args: unknown[]) => console.error(...args)
    console.log = stderrLog
    console.info = stderrLog
  }

  // Load stored provider config (file-backed, user-editable via UI).
  const providersStorePath = joinPath(homedir(), '.samsinn', 'providers.json')
  const { data: storeData, warnings: storeWarnings } = await loadProviderStore(providersStorePath)
  for (const w of storeWarnings) console.warn(`[providers.json] ${w}`)
  const fileStore = mergeWithEnv(storeData)

  const providerConfig = parseProviderConfig({ fileStore })
  const providerSetup = buildProvidersFromConfig(providerConfig)
  const system = createSystem({ providerConfig, providerSetup })

  const pkg = await Bun.file(`${import.meta.dir}/../package.json`).json() as { version: string }
  console.log(`Samsinn v${pkg.version}${headless ? ' (headless)' : ''}`)
  console.log(summariseProviderConfig(providerConfig))

  // Load filesystem tools and skills before snapshot restore so restored agents get them
  await loadExternalTools(system.toolRegistry)
  await loadSkills(resolve(process.cwd(), 'skills'), system.skillStore, system.toolRegistry)
  await loadSkills(system.skillsDir, system.skillStore, system.toolRegistry)

  // Restore from snapshot if available
  const snapshotPath = resolve(import.meta.dir, '../data/snapshot.json')
  const snapshot = await loadSnapshot(snapshotPath)
  if (snapshot) {
    await restoreFromSnapshot(system, snapshot)
    console.log(`Restored from snapshot: ${snapshot.rooms.length} rooms, ${snapshot.agents.length} agents`)
  } else {
    console.log('Fresh start — no snapshot found.')
  }

  // Ensure at least one room always exists
  if (system.house.listAllRooms().length === 0) {
    system.house.createRoomSafe({ name: 'general', createdBy: 'system' })
    console.log('Created default room: general')
  }

  // Register MCP client tools from config (external tool servers)
  const mcpConfigPath = `${import.meta.dir}/../mcp-servers.json`
  const mcpResult = existsSync(mcpConfigPath)
    ? await registerAllMCPServers(system.toolRegistry, await Bun.file(mcpConfigPath).json())
    : { totalTools: 0, disconnect: async (): Promise<void> => {} }

  console.log(`Tools: ${system.toolRegistry.list().map(t => t.name).join(', ')}`)

  // Warm availableModels cache across all providers before the first chat
  // call, so the router's model-filter logic doesn't optimistically hit
  // providers that don't serve the requested model.
  const warmResults = await warmProviderModels(providerSetup.gateways)
  for (const [name, result] of Object.entries(warmResults)) {
    if (result.status === 'ok') {
      console.log(`  ${name}: ${result.count} models available`)
    } else {
      console.warn(`  ${name}: warm-up failed — ${result.message}`)
    }
  }

  // Auto-save: debounced save on state changes
  const autoSaver = createAutoSaver(system, snapshotPath)

  // Graceful shutdown: drain in-flight evaluations in parallel, then flush snapshot, then disconnect MCP
  const shutdown = async () => {
    console.log('Shutting down, saving snapshot...')
    const timeout = new Promise<void>(res => setTimeout(res, DRAIN_TIMEOUT_MS))
    const aiAgents = system.team.listAgents().flatMap(a => { const ai = asAIAgent(a); return ai ? [ai] : [] })
    await Promise.all(aiAgents.map(a => Promise.race([a.whenIdle(), timeout])))
    try {
      await autoSaver.flush()
      console.log('Snapshot saved.')
    } catch (err) {
      console.error('Failed to save snapshot on shutdown:', err)
    }
    await mcpResult.disconnect()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  if (headless) {
    // Headless mode: MCP server on stdio, no HTTP server
    const { createMCPServer, wireEventNotifications, startMCPServerStdio } = await import('./integrations/mcp/server.ts')
    const mcpServer = createMCPServer(system, pkg.version)
    wireEventNotifications(system, mcpServer)
    await startMCPServerStdio(mcpServer)
    console.log('MCP server running on stdio')
  } else {
    // Full mode: HTTP + WebSocket server with browser UI
    const { createServer } = await import('./api/server.ts')
    createServer(system, {
      port: parseInt(process.env.PORT ?? String(DEFAULTS.port), 10),
      onAutoSave: autoSaver.scheduleSave,
    })
  }
}
