import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { System } from '../../../main.ts'
import type { AIAgent } from '../../../core/types.ts'
import { asAIAgent } from '../../../agents/shared.ts'
import { textResult, errorResult, resolveAgent } from './helpers.ts'

export const registerAgentTools = (mcpServer: McpServer, system: System): void => {
  mcpServer.tool(
    'create_agent',
    'Create a new AI agent (not added to any room by default)',
    {
      name: z.string().describe('Agent name'),
      model: z.string().describe('Ollama model name (e.g. llama3.2, qwen2.5:14b)'),
      systemPrompt: z.string().describe('System prompt defining the agent personality and behavior'),
      temperature: z.number().optional().describe('LLM temperature (0-1)'),
    },
    async ({ name, model, systemPrompt, temperature }) => {
      try {
        const agent = await system.spawnAIAgent({ name, model, systemPrompt, temperature })
        return textResult({ id: agent.id, name: agent.name })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to create agent')
      }
    },
  )

  mcpServer.tool(
    'list_agents',
    'List all agents in the system',
    {},
    async () => {
      const agents = system.team.listAgents().map(a => ({
        id: a.id, name: a.name, kind: a.kind, state: a.state.get(),
      }))
      return textResult(agents)
    },
  )

  mcpServer.tool(
    'get_agent',
    'Get detailed information about a specific agent',
    { name: z.string().describe('Agent name') },
    async ({ name }) => {
      try {
        const agent = resolveAgent(system, name)
        const detail: Record<string, unknown> = {
          id: agent.id, name: agent.name,
          kind: agent.kind, state: agent.state.get(),
          rooms: system.house.getRoomsForAgent(agent.id).map(r => r.profile.name),
        }
        const aiAgent = asAIAgent(agent)
        if (aiAgent) {
          detail.systemPrompt = aiAgent.getSystemPrompt()
          detail.model = aiAgent.getModel()
        }
        return textResult(detail)
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Agent not found')
      }
    },
  )

  mcpServer.tool(
    'remove_agent',
    'Remove an agent from the system',
    { name: z.string().describe('Agent name') },
    async ({ name }) => {
      try {
        const agent = resolveAgent(system, name)
        system.removeAgent(agent.id)
        return textResult({ removed: true })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to remove agent')
      }
    },
  )

  mcpServer.tool(
    'update_agent_prompt',
    'Update an AI agent system prompt',
    {
      name: z.string().describe('Agent name'),
      systemPrompt: z.string().describe('New system prompt'),
    },
    async ({ name, systemPrompt }) => {
      try {
        const agent = resolveAgent(system, name)
        if (agent.kind !== 'ai' || !('updateSystemPrompt' in agent)) {
          return errorResult('Only AI agents can be updated')
        }
        ;(agent as AIAgent).updateSystemPrompt(systemPrompt)
        return textResult({ updated: true, name: agent.name })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to update agent')
      }
    },
  )

  mcpServer.tool(
    'get_house_prompts',
    'Get the global house prompt and response format that guide all agents',
    {},
    async () => textResult({
      housePrompt: system.house.getHousePrompt(),
      responseFormat: system.house.getResponseFormat(),
    }),
  )

  mcpServer.tool(
    'set_house_prompts',
    'Update the global house prompt and/or response format',
    {
      housePrompt: z.string().optional().describe('Global behavioral guidance for all agents'),
      responseFormat: z.string().optional().describe('Response format instructions for agents'),
    },
    async ({ housePrompt, responseFormat }) => {
      if (housePrompt !== undefined) system.house.setHousePrompt(housePrompt)
      if (responseFormat !== undefined) system.house.setResponseFormat(responseFormat)
      return textResult({
        housePrompt: system.house.getHousePrompt(),
        responseFormat: system.house.getResponseFormat(),
      })
    },
  )
}
