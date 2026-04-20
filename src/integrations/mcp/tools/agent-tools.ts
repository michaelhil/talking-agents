import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { System } from '../../../main.ts'
import type { AIAgent } from '../../../core/types/agent.ts'
import type { ToolContext } from '../../../core/types/tool.ts'
import { asAIAgent } from '../../../agents/shared.ts'
import { createListAgentsTool, createMuteAgentTool } from '../../../tools/built-in/agent-tools.ts'
import { textResult, errorResult, resolveAgent } from './helpers.ts'

const dummyContext: ToolContext = {
  callerId: 'mcp-client',
  callerName: 'mcp-client',
}

export const registerAgentTools = (mcpServer: McpServer, system: System): void => {
  const listAgents = createListAgentsTool(system.team)
  mcpServer.tool(
    listAgents.name,
    listAgents.description,
    {},
    async () => {
      try {
        const result = await listAgents.execute({}, dummyContext)
        if (!result.success) return errorResult(result.error ?? 'Failed to list agents')
        return textResult(result.data)
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to list agents')
      }
    },
  )

  const muteAgent = createMuteAgentTool(system.team, system.house)
  mcpServer.tool(
    muteAgent.name,
    muteAgent.description,
    {
      roomName: z.string().describe('Name of the room'),
      agentName: z.string().describe('Name of the agent to mute or unmute'),
      muted: z.boolean().describe('true to mute, false to unmute'),
    },
    async ({ roomName, agentName, muted }) => {
      try {
        const result = await muteAgent.execute({ roomName, agentName, muted }, dummyContext)
        if (!result.success) return errorResult(result.error ?? 'Failed to set mute')
        return textResult(result.data)
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to set mute')
      }
    },
  )

  mcpServer.tool(
    'create_agent',
    'Create a new AI agent (not added to any room by default)',
    {
      name: z.string().describe('Agent name'),
      model: z.string().describe('Model ID. Cloud models are provider-prefixed: "anthropic:claude-haiku-4-5", "gemini:gemini-2.5-flash", "groq:llama-3.3-70b-versatile", etc. Ollama models are bare: "llama3.2" or "qwen2.5:14b". Call GET /api/models for the live list.'),
      persona: z.string().describe('Persona defining who the agent is and how it should behave'),
      temperature: z.number().optional().describe('LLM temperature (0-1)'),
    },
    async ({ name, model, persona, temperature }) => {
      try {
        const agent = await system.spawnAIAgent({ name, model, persona, temperature })
        return textResult({ id: agent.id, name: agent.name })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to create agent')
      }
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
          detail.persona = aiAgent.getPersona()
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
    'update_agent_persona',
    'Update an AI agent persona',
    {
      name: z.string().describe('Agent name'),
      persona: z.string().describe('New persona'),
    },
    async ({ name, persona }) => {
      try {
        const agent = resolveAgent(system, name)
        if (agent.kind !== 'ai' || !('updatePersona' in agent)) {
          return errorResult('Only AI agents can be updated')
        }
        ;(agent as AIAgent).updatePersona(persona)
        return textResult({ updated: true, name: agent.name })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to update agent')
      }
    },
  )

  mcpServer.tool(
    'update_agent_context',
    'Update per-agent Context panel toggles and limits (includePrompts, includeContext, includeFlowStepPrompt, includeTools, maxToolResultChars, maxToolIterations).',
    {
      name: z.string().describe('Agent name'),
      includePrompts: z.object({
        agent: z.boolean().optional(),
        room: z.boolean().optional(),
        house: z.boolean().optional(),
        responseFormat: z.boolean().optional(),
        skills: z.boolean().optional(),
      }).optional().describe('Prompt-section toggles. Partial — only provided keys change.'),
      includeContext: z.object({
        participants: z.boolean().optional(),
        flow: z.boolean().optional(),
        artifacts: z.boolean().optional(),
        activity: z.boolean().optional(),
        knownAgents: z.boolean().optional(),
      }).optional().describe('CONTEXT sub-section toggles. Partial.'),
      includeFlowStepPrompt: z.boolean().optional().describe('Include [Step instruction: ...] suffix on flow messages (default: true).'),
      includeTools: z.boolean().optional().describe('Master tools on/off (false = send zero tool definitions).'),
      maxToolResultChars: z.number().nullable().optional().describe('Cap on each tool-result payload injected back into the loop.'),
      maxToolIterations: z.number().optional().describe('Max tool-call rounds per turn.'),
    },
    async ({ name, includePrompts, includeContext, includeFlowStepPrompt, includeTools, maxToolResultChars, maxToolIterations }) => {
      try {
        const agent = resolveAgent(system, name)
        const ai = agent as AIAgent
        if (agent.kind !== 'ai' || !('updateIncludePrompts' in ai)) {
          return errorResult('Only AI agents can be updated')
        }
        if (includePrompts) ai.updateIncludePrompts(includePrompts)
        if (includeContext) ai.updateIncludeContext(includeContext)
        if (typeof includeFlowStepPrompt === 'boolean') ai.updateIncludeFlowStepPrompt(includeFlowStepPrompt)
        if (typeof includeTools === 'boolean') ai.updateIncludeTools(includeTools)
        if (maxToolResultChars === null) ai.updateMaxToolResultChars(undefined)
        else if (typeof maxToolResultChars === 'number') ai.updateMaxToolResultChars(maxToolResultChars)
        if (typeof maxToolIterations === 'number') ai.updateMaxToolIterations(maxToolIterations)
        return textResult({
          updated: true,
          name: agent.name,
          includePrompts: ai.getIncludePrompts(),
          includeContext: ai.getIncludeContext(),
          includeFlowStepPrompt: ai.getIncludeFlowStepPrompt(),
          includeTools: ai.getIncludeTools(),
          maxToolResultChars: ai.getMaxToolResultChars() ?? null,
          maxToolIterations: ai.getMaxToolIterations() ?? null,
        })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to update agent context')
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
