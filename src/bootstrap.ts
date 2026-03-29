// ============================================================================
// Bootstrap — Startup logic for direct execution.
//
// Performs all initialization: env config, snapshot restore, tool loading,
// MCP client registration, signal handlers, then starts server or MCP stdio.
//
// Imported and called only when main.ts is run directly.
// ============================================================================

import { createSystem } from './main.ts'
import { DEFAULTS } from './core/types.ts'
import { registerAllMCPServers } from './integrations/mcp/client.ts'
import { existsSync } from 'node:fs'
import { loadSnapshot, restoreFromSnapshot, createAutoSaver } from './core/snapshot.ts'
import { resolve } from 'node:path'
import { loadExternalTools } from './tools/loader.ts'
import { asAIAgent } from './agents/shared.ts'

const DRAIN_TIMEOUT_MS = 5_000

export const bootstrap = async (): Promise<void> => {
  const headless = process.argv.includes('--headless')

  // In headless mode, redirect console.log to stderr (stdout is reserved for MCP protocol)
  if (headless) {
    const stderrLog = (...args: unknown[]) => console.error(...args)
    console.log = stderrLog
    console.info = stderrLog
  }

  const ollamaUrl = process.env.OLLAMA_URL ?? DEFAULTS.ollamaBaseUrl
  const system = createSystem(ollamaUrl)

  const pkg = await Bun.file(`${import.meta.dir}/../package.json`).json() as { version: string }
  console.log(`Samsinn v${pkg.version}${headless ? ' (headless)' : ''}`)
  console.log(`Ollama: ${ollamaUrl}`)

  // Load filesystem tools before snapshot restore so restored agents get them
  await loadExternalTools(system.toolRegistry)

  // Restore from snapshot if available
  const snapshotPath = resolve(import.meta.dir, '../data/snapshot.json')
  const snapshot = await loadSnapshot(snapshotPath)
  if (snapshot) {
    await restoreFromSnapshot(system, snapshot)
    console.log(`Restored from snapshot: ${snapshot.rooms.length} rooms, ${snapshot.agents.length} agents`)
  } else {
    console.log('Fresh start — no snapshot found. Create rooms and agents from the UI.')
  }

  // Register MCP client tools from config (external tool servers)
  const mcpConfigPath = `${import.meta.dir}/../mcp-servers.json`
  const mcpResult = existsSync(mcpConfigPath)
    ? await registerAllMCPServers(system.toolRegistry, await Bun.file(mcpConfigPath).json())
    : { totalTools: 0, disconnect: async (): Promise<void> => {} }

  console.log(`Tools: ${system.toolRegistry.list().map(t => t.name).join(', ')}`)

  try {
    const models = await system.ollama.models()
    console.log(`Models available: ${models.join(', ')}`)
  } catch {
    console.warn('Warning: Could not connect to Ollama. AI agents will not function.')
  }

  // Auto-save: debounced save on state changes
  const autoSaver = createAutoSaver(system, snapshotPath)

  // Graceful shutdown: drain in-flight evaluations, then flush snapshot
  const shutdown = async () => {
    console.log('Shutting down, saving snapshot...')
    for (const agent of system.team.listAgents()) {
      const aiAgent = asAIAgent(agent)
      if (aiAgent) {
        await Promise.race([
          aiAgent.whenIdle(),
          new Promise<void>(res => setTimeout(res, DRAIN_TIMEOUT_MS)),
        ])
      }
    }
    await mcpResult.disconnect()
    try {
      await autoSaver.flush()
      console.log('Snapshot saved.')
    } catch (err) {
      console.error('Failed to save snapshot on shutdown:', err)
    }
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
