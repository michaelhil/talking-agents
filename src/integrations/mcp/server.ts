// ============================================================================
// MCP Server — Exposes the Samsinn System as MCP tools and resources.
//
// Symmetric with client.ts: the client consumes external MCP tools, the server
// exposes Samsinn as MCP tools for external LLMs/agents to orchestrate.
//
// Tool modules live in tools/: room, agent, todo, message.
// Resources live in resources.ts.
// Event notifications via logging messages for real-time updates.
//
// Usage:
//   const mcpServer = createMCPServer(system, version)
//   await startMCPServerStdio(mcpServer)
// ============================================================================

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { System } from '../../main.ts'
import type { OnDeliveryModeChanged, OnFlowEvent, OnTodoChanged, OnTurnChanged } from '../../core/types.ts'
import { registerAllMCPTools } from './tools/index.ts'
import { registerMCPResources } from './resources.ts'

// === Factory ===

export const createMCPServer = (system: System, version = '0.0.0'): McpServer => {
  const mcpServer = new McpServer(
    { name: 'samsinn', version },
    { capabilities: { resources: {}, tools: {}, logging: {} } },
  )

  registerAllMCPTools(mcpServer, system)
  registerMCPResources(mcpServer, system)

  return mcpServer
}

// === Wire system event callbacks to MCP logging notifications ===

export const wireEventNotifications = (system: System, mcpServer: McpServer): void => {
  const sendNotification = (data: Record<string, unknown>): void => {
    try {
      mcpServer.server.sendLoggingMessage({ level: 'info', data: JSON.stringify(data) })
    } catch { /* client may not support logging */ }
  }

  const onTurnChanged: OnTurnChanged = (roomId, agentId, waitingForHuman) => {
    const room = system.house.getRoom(roomId)
    const agent = agentId ? system.team.getAgent(agentId) : undefined
    sendNotification({ type: 'turn_changed', roomName: room?.profile.name, agentName: agent?.name, waitingForHuman })
  }

  const onDeliveryModeChanged: OnDeliveryModeChanged = (roomId, mode) => {
    const room = system.house.getRoom(roomId)
    sendNotification({ type: 'delivery_mode_changed', roomName: room?.profile.name, mode })
  }

  const onFlowEvent: OnFlowEvent = (roomId, event, detail) => {
    const room = system.house.getRoom(roomId)
    sendNotification({ type: 'flow_event', roomName: room?.profile.name, event, detail })
  }

  const onTodoChanged: OnTodoChanged = (roomId, action, todo) => {
    const room = system.house.getRoom(roomId)
    sendNotification({ type: 'todo_changed', roomName: room?.profile.name, action, todo })
  }

  system.setOnTurnChanged(onTurnChanged)
  system.setOnDeliveryModeChanged(onDeliveryModeChanged)
  system.setOnFlowEvent(onFlowEvent)
  system.setOnTodoChanged(onTodoChanged)
}

// === Start MCP server on stdio ===

export const startMCPServerStdio = async (mcpServer: McpServer): Promise<void> => {
  const transport = new StdioServerTransport()
  await mcpServer.connect(transport)
}
