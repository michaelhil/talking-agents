import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { System } from '../../../main.ts'
import { registerRoomTools } from './room-tools.ts'
import { registerAgentTools } from './agent-tools.ts'
import { registerMessageTools } from './message-tools.ts'

export const registerAllMCPTools = (mcpServer: McpServer, system: System): void => {
  registerRoomTools(mcpServer, system)
  registerAgentTools(mcpServer, system)
  registerMessageTools(mcpServer, system)
}
