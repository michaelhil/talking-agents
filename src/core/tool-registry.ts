// ============================================================================
// Tool Registry — Global registry of available tools.
//
// Simple Map-based store. Agents reference tools by name;
// the registry validates access at execution time.
// ============================================================================

import type { Tool, ToolRegistry } from './types.ts'

export const createToolRegistry = (): ToolRegistry => {
  const tools = new Map<string, Tool>()

  const register = (tool: Tool): void => {
    if (!tool.name || typeof tool.name !== 'string') {
      throw new Error('Tool must have a non-empty string name')
    }
    tools.set(tool.name, tool)
  }

  return {
    register,
    registerAll: (toolList: ReadonlyArray<Tool>): void => {
      for (const tool of toolList) register(tool)
    },
    get: (name: string): Tool | undefined => tools.get(name),
    has: (name: string): boolean => tools.has(name),
    list: (): ReadonlyArray<Tool> => [...tools.values()],
  }
}
