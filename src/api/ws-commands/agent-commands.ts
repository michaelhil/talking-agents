import type { WSInbound } from '../../core/types/ws-protocol.ts'
import { asAIAgent } from '../../agents/shared.ts'
import { buildToolSupport } from '../../agents/spawn.ts'
import { requireAgent, sendError, type CommandContext } from './types.ts'

export const handleAgentCommand = async (msg: WSInbound, ctx: CommandContext): Promise<boolean> => {
  const { ws, system, wsManager } = ctx

  switch (msg.type) {
    case 'create_agent': {
      const agent = await system.spawnAIAgent(msg.config)
      ctx.wsManager.subscribeAgentState(agent, ctx.session.instanceId)
      const ai = asAIAgent(agent)
      ctx.wsManager.broadcastToInstance(ctx.session.instanceId, { type: 'agent_joined', agent: { id: agent.id, name: agent.name, kind: agent.kind, ...(ai ? { model: ai.getModel() } : {}) } })
      return true
    }
    case 'remove_agent': {
      const agent = system.team.getAgent(msg.name)
      if (agent) {
        ctx.wsManager.unsubscribeAgentState(agent.id)
        system.removeAgent(agent.id)
        ctx.wsManager.broadcastToInstance(ctx.session.instanceId, { type: 'agent_removed', agentName: msg.name })
      }
      return true
    }
    case 'update_agent': {
      const agent = system.team.getAgent(msg.name)
      const aiAgent = agent ? asAIAgent(agent) : undefined
      if (aiAgent) {
        if (msg.persona) aiAgent.updatePersona(msg.persona)
        if (msg.model) aiAgent.updateModel(msg.model)
        if (msg.includePrompts) aiAgent.updateIncludePrompts(msg.includePrompts)
        if (msg.includeContext) aiAgent.updateIncludeContext(msg.includeContext)
        if (typeof msg.includeTools === 'boolean') aiAgent.updateIncludeTools(msg.includeTools)
        if (msg.maxToolResultChars === null) aiAgent.updateMaxToolResultChars(undefined)
        else if (typeof msg.maxToolResultChars === 'number') aiAgent.updateMaxToolResultChars(msg.maxToolResultChars)
        if (typeof msg.maxToolIterations === 'number') aiAgent.updateMaxToolIterations(msg.maxToolIterations)
        if (Array.isArray(msg.tools)) {
          const known = new Set(system.toolRegistry.list().map(t => t.name))
          const resolved = msg.tools.filter(n => known.has(n))
          aiAgent.updateTools?.(resolved)
          const support = await buildToolSupport(
            resolved, system.toolRegistry,
            { id: aiAgent.id, name: aiAgent.name, currentModel: () => aiAgent.getModel() },
            system.llm,
          )
          aiAgent.refreshTools?.(support)
        }
      }
      return true
    }
    case 'cancel_generation': {
      const agent = requireAgent(wsManager, ws, system, msg.name)
      if (!agent) return true
      const aiAgent = asAIAgent(agent)
      if (!aiAgent) { sendError(wsManager, ws, `"${msg.name}" is not an AI agent`); return true }
      aiAgent.cancelGeneration()
      return true
    }
    default:
      return false
  }
}
