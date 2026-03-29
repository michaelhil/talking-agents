import type { AIAgent, AgentProfile, House, Team, Tool, ToolContext, TodoItem } from '../../core/types.ts'

export const createListAgentsTool = (team: Team): Tool => ({
  name: 'list_agents',
  description: 'Lists all agents in the system with their name, kind (ai/human), and model.',
  usage: 'Use to discover who is available before querying, assigning todos, or adding to rooms. Check here before using query_agent or add_to_room.',
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

export const createQueryAgentTool = (team: Team): Tool => ({
  name: 'query_agent',
  description: 'Ask another AI agent a direct question and receive their response.',
  usage: 'Use to consult specialists, delegate sub-questions, or get a second opinion. Do not use to query yourself. Prefer this over posting to a room when you need a focused, synchronous answer.',
  returns: 'Object with "agent" (name) and "response" (the agent\'s answer string).',
  parameters: {
    type: 'object',
    properties: {
      agent: { type: 'string', description: 'Name of the agent to query' },
      question: { type: 'string', description: 'The question to ask' },
    },
    required: ['agent', 'question'],
  },
  execute: async (params: Record<string, unknown>, context: ToolContext) => {
    const agentName = params.agent as string | undefined
    const question = params.question as string | undefined

    if (!agentName || !question) {
      return { success: false, error: 'Both "agent" and "question" are required' }
    }

    const target = team.getAgent(agentName)
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

export const createMuteAgentTool = (team: Team, house: House): Tool => ({
  name: 'mute_agent',
  description: 'Mutes or unmutes an agent in a room, preventing their responses from being delivered.',
  usage: 'Use to silence an agent that is responding inappropriately or too verbosely in a specific room, without removing them. Use sparingly.',
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

export const createDelegateTool = (team: Team, house: House): Tool => ({
  name: 'delegate',
  description: 'Assign a task to another AI agent, optionally tracking it as a todo. Waits for the result.',
  usage: 'Use when you need another agent to perform a specific task and you need their result. Creates a visible todo if called from a room context. Prefer this over query_agent for named task assignments — it ties the work to the todo list.',
  returns: '{ agentName, result, todoId? } — todoId is present when a room context was available.',
  parameters: {
    type: 'object',
    properties: {
      agentName: { type: 'string', description: 'Name of the AI agent to assign the task to' },
      task: { type: 'string', description: 'The task description to send to the agent' },
    },
    required: ['agentName', 'task'],
  },
  execute: async (params: Record<string, unknown>, context: ToolContext) => {
    const agentName = params.agentName as string | undefined
    const task = params.task as string | undefined
    if (!agentName || !task) return { success: false, error: 'agentName and task are required' }

    const target = team.getAgent(agentName)
    if (!target) return { success: false, error: `Agent "${agentName}" not found` }
    if (target.kind !== 'ai') return { success: false, error: `Agent "${agentName}" is not an AI agent` }
    if (target.id === context.callerId) return { success: false, error: 'Cannot delegate to yourself' }

    // Create a tracking todo if we have a room context
    let todo: TodoItem | undefined
    if (context.roomId) {
      const room = house.getRoom(context.roomId)
      if (room) {
        todo = room.addTodo({
          content: task,
          assignee: agentName,
          assigneeId: target.id,
          createdBy: context.callerName,
        })
        room.updateTodo(todo.id, { status: 'in_progress' })
      }
    }

    try {
      const result = await (target as AIAgent).query(task, context.callerId, context.callerName)

      // Mark todo complete with the result
      if (todo && context.roomId) {
        const room = house.getRoom(context.roomId)
        room?.updateTodo(todo.id, { status: 'completed', result })
      }

      return {
        success: true,
        data: {
          agentName,
          result,
          ...(todo ? { todoId: todo.id } : {}),
        },
      }
    } catch (err) {
      // Mark todo blocked on failure
      if (todo && context.roomId) {
        const room = house.getRoom(context.roomId)
        room?.updateTodo(todo.id, { status: 'blocked' })
      }
      return { success: false, error: err instanceof Error ? err.message : 'Delegation failed' }
    }
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
