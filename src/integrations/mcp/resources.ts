import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { System } from '../../main.ts'

export const registerMCPResources = (mcpServer: McpServer, system: System): void => {
  mcpServer.resource(
    'rooms',
    'samsinn://rooms',
    { description: 'List of all rooms in the system', mimeType: 'application/json' },
    async () => ({
      contents: [{
        uri: 'samsinn://rooms',
        mimeType: 'application/json',
        text: JSON.stringify(system.house.listAllRooms(), null, 2),
      }],
    }),
  )

  mcpServer.resource(
    'agents',
    'samsinn://agents',
    { description: 'List of all agents in the system', mimeType: 'application/json' },
    async () => ({
      contents: [{
        uri: 'samsinn://agents',
        mimeType: 'application/json',
        text: JSON.stringify(
          system.team.listAgents().map(a => ({
            id: a.id, name: a.name, kind: a.kind, state: a.state.get(),
          })),
          null, 2,
        ),
      }],
    }),
  )

  mcpServer.resource(
    'room-messages',
    new ResourceTemplate('samsinn://rooms/{name}/messages', { list: undefined }),
    { description: 'Recent messages in a specific room', mimeType: 'application/json' },
    async (uri, { name }) => {
      const room = system.house.getRoom(name as string)
      if (!room) return { contents: [] }
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(room.getRecent(50), null, 2),
        }],
      }
    },
  )
}
