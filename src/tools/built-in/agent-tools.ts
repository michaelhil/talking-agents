import type { AgentProfile } from '../../core/types/messaging.ts'
import type { House } from '../../core/types/room.ts'
import type { Team } from '../../core/types/agent.ts'
import type { Tool, ToolContext } from '../../core/types/tool.ts'

export const createPassTool = (): Tool => ({
  name: 'pass',
  description: 'Decline to respond. Use when the message is not directed at you or has been answered.',
  parameters: {
    type: 'object',
    properties: { reason: { type: 'string', description: 'Brief reason for passing' } },
    required: ['reason'],
  },
  execute: async (params) => ({ success: true, result: params.reason as string }),
})

export const createListAgentsTool = (team: Team): Tool => ({
  name: 'list_agents',
  description: 'Lists all agents in the system with their name, kind (ai/human), and model.',
  usage: 'Discover available agents before add_to_room or [[AgentName]] addressing.',
  returns: 'Array of agent profiles: { name, kind, model? }.',
  parameters: {},
  execute: async () => ({
    success: true,
    data: team.listAgents().map((a): Pick<AgentProfile, 'name' | 'kind' | 'model'> => ({
      name: a.name,
      kind: a.kind,
      model: 'model' in a ? (a as AgentProfile).model : undefined,
    })),
  }),
})

export const createMuteAgentTool = (team: Team, house: House): Tool => ({
  name: 'mute_agent',
  description: 'Mutes or unmutes an agent in a room, preventing their responses from being delivered.',
  usage: 'Silence a misbehaving agent in one room without removing them. Use sparingly.',
  returns: '{ roomName, agentName, muted }.',
  parameters: {
    type: 'object',
    properties: {
      roomName: { type: 'string', description: 'Name of the room' },
      agentName: { type: 'string', description: 'Name of the agent to mute or unmute' },
      muted: { type: 'boolean', description: 'true to mute, false to unmute' },
    },
    required: ['roomName', 'agentName', 'muted'],
  },
  execute: async (params: Record<string, unknown>) => {
    const roomName = params.roomName as string | undefined
    const agentName = params.agentName as string | undefined
    if (!roomName || !agentName) return { success: false, error: 'roomName and agentName are required' }
    if (typeof params.muted !== 'boolean') return { success: false, error: 'muted must be a boolean' }
    const room = house.getRoom(roomName)
    if (!room) return { success: false, error: `Room "${roomName}" not found` }
    const agent = team.getAgent(agentName)
    if (!agent) return { success: false, error: `Agent "${agentName}" not found` }
    room.setMuted(agent.id, params.muted)
    return { success: true, data: { roomName: room.profile.name, agentName: agent.name, muted: params.muted } }
  },
})

export const createGetMyContextTool = (team: Team, house: House): Tool => ({
  name: 'get_my_context',
  description: 'Returns your own name, id, kind, and the rooms you are currently in.',
  usage: 'Use to identify yourself, confirm your current room membership, or orient before taking structural actions.',
  returns: '{ name, id, kind, rooms: string[] }.',
  parameters: {},
  execute: async (_params: Record<string, unknown>, context: ToolContext) => {
    const agent = team.getAgent(context.callerId)
    const rooms = house.getRoomsForAgent(context.callerId).map(r => r.profile.name)
    return {
      success: true,
      data: {
        name: context.callerName,
        id: context.callerId,
        kind: agent?.kind ?? 'ai',
        rooms,
      },
    }
  },
})
