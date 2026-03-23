// ============================================================================
// Tool Registry — Global registry of available tools.
//
// Simple Map-based store. Agents reference tools by name;
// the registry validates access at execution time.
// ============================================================================

import type { Tool, ToolRegistry } from './types.ts'

export const createToolRegistry = (): ToolRegistry => {
  const tools = new Map<string, Tool>()

  return {
    register: (tool: Tool): void => {
      tools.set(tool.name, tool)
    },
    get: (name: string): Tool | undefined => tools.get(name),
    list: (): ReadonlyArray<Tool> => [...tools.values()],
  }
}
