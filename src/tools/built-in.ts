// ============================================================================
// Built-in Tools — shipped with the system for validation and basic utility.
// ============================================================================

import type { AIAgent, House, Team, Tool, ToolContext } from '../core/types.ts'

export const createListRoomsTool = (house: House): Tool => ({
  name: 'list_rooms',
  description: 'Lists all available rooms with their names and descriptions.',
  parameters: {},
  execute: async () => ({
    success: true,
    data: house.listAllRooms().map(r => ({ name: r.name, description: r.description, visibility: r.visibility })),
  }),
})

export const createGetTimeTool = (): Tool => ({
  name: 'get_time',
  description: 'Returns the current date and time in ISO format.',
  parameters: {},
  execute: async () => ({
    success: true,
    data: { time: new Date().toISOString() },
  }),
})

export const createQueryAgentTool = (team: Team): Tool => ({
  name: 'query_agent',
  description: 'Ask another AI agent a question and get their response. Use this to consult with specialists.',
  parameters: {
    agent: 'string — name of the agent to query',
    question: 'string — the question to ask',
  },
  execute: async (params: Record<string, unknown>, context: ToolContext) => {
    const agentName = params.agent as string | undefined
    const question = params.question as string | undefined

    if (!agentName || !question) {
      return { success: false, error: 'Both "agent" and "question" are required' }
    }

    const target = team.findByName(agentName)
    if (!target) return { success: false, error: `Agent "${agentName}" not found` }
    if (target.kind !== 'ai') return { success: false, error: `Agent "${agentName}" is not an AI agent` }
    if (target.id === context.callerId) return { success: false, error: 'Cannot query yourself' }

    try {
      const response = await (target as AIAgent).query(question, context.callerId, context.callerName)
      return { success: true, data: { agent: agentName, response } }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Query failed' }
    }
  },
})
