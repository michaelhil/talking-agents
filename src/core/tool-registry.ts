// ============================================================================
// Tool Registry — Global registry of available tools.
//
// Simple Map-based store. Agents reference tools by name;
// the registry validates access at execution time.
//
// Each entry carries source metadata (built-in / external / skill-bundled +
// filesystem path when applicable) so the detail endpoint can serve code
// and the hot-reload path can identify which tools live on disk.
// ============================================================================

import type { Tool, ToolRegistry, ToolRegistryEntry, ToolSourceMeta } from './types/tool.ts'

export const createToolRegistry = (): ToolRegistry => {
  const entries = new Map<string, ToolRegistryEntry>()

  const registerWithSource = (tool: Tool, source: ToolSourceMeta): void => {
    if (!tool.name || typeof tool.name !== 'string') {
      throw new Error('Tool must have a non-empty string name')
    }
    if (entries.has(tool.name)) {
      console.warn(`[ToolRegistry] Tool "${tool.name}" already registered — overwriting`)
    }
    entries.set(tool.name, { tool, source })
  }

  const register = (tool: Tool): void => {
    registerWithSource(tool, { kind: 'built-in' })
  }

  return {
    register,
    registerAll: (toolList: ReadonlyArray<Tool>): void => {
      for (const tool of toolList) register(tool)
    },
    registerWithSource,
    unregister: (name: string): boolean => entries.delete(name),
    unregisterByPack: (pack: string): ReadonlyArray<string> => {
      const removed: string[] = []
      for (const [key, entry] of entries) {
        if (entry.source.kind === 'pack-bundled' && entry.source.pack === pack) {
          entries.delete(key)
          removed.push(key)
        }
      }
      return removed
    },
    get: (name: string): Tool | undefined => entries.get(name)?.tool,
    getEntry: (name: string): ToolRegistryEntry | undefined => entries.get(name),
    has: (name: string): boolean => entries.has(name),
    list: (): ReadonlyArray<Tool> => [...entries.values()].map(e => e.tool),
    listEntries: (): ReadonlyArray<ToolRegistryEntry> => [...entries.values()],
  }
}
