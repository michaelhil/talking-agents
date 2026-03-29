import type { WSInbound } from '../../core/types.ts'
import { asAIAgent } from '../../agents/shared.ts'
import { requireAgent, sendError, type CommandContext } from './types.ts'

export const handleAgentCommand = async (msg: WSInbound, ctx: CommandContext): Promise<boolean> => {
  const { ws, system } = ctx

  switch (msg.type) {
    case 'create_agent': {
      const agent = await system.spawnAIAgent(msg.config)
      ctx.wsManager.subscribeAgentState(agent.id, agent.name)
      const ai = asAIAgent(agent)
      ctx.wsManager.broadcast({ type: 'agent_joined', agent: { id: agent.id, name: agent.name, kind: agent.kind, ...(ai ? { model: ai.getModel() } : {}) } })
      return true
    }
    case 'remove_agent': {
      const agent = system.team.getAgent(msg.name)
      if (agent) {
        ctx.wsManager.unsubscribeAgentState(agent.id)
        system.removeAgent(agent.id)
        ctx.wsManager.broadcast({ type: 'agent_removed', agentName: msg.name })
      }
      return true
    }
    case 'update_agent': {
      const agent = system.team.getAgent(msg.name)
      const aiAgent = agent ? asAIAgent(agent) : undefined
      if (aiAgent) {
        if (msg.systemPrompt) aiAgent.updateSystemPrompt(msg.systemPrompt)
        if (msg.model) aiAgent.updateModel(msg.model)
      }
      return true
    }
    case 'cancel_generation': {
      const agent = requireAgent(ws, system, msg.name)
      if (!agent) return true
      const aiAgent = asAIAgent(agent)
      if (!aiAgent) { sendError(ws, `"${msg.name}" is not an AI agent`); return true }
      aiAgent.cancelGeneration()
      return true
    }
    default:
      return false
  }
}
