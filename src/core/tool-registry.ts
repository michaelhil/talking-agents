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

// Overlay registry — used by per-instance Systems to register house-bound
// built-ins (createListRoomsTool(house), etc.) on top of the process-shared
// registry that holds external tools, skills, packs, and MCP tools.
//
// Lookup falls through: own map → parent. Mutations stay in the overlay
// (writes to parent are intentional admin paths via shared registration in
// bootstrap, not via per-instance code). list() / listEntries() merge.
//
// `unregisterByPack` and `unregister` only touch the overlay; pack tools
// live in the shared parent and the install/uninstall flow mutates parent
// directly via its own reference.
export const createOverlayToolRegistry = (parent: ToolRegistry): ToolRegistry => {
  const own = createToolRegistry()

  return {
    register: own.register,
    registerAll: own.registerAll,
    registerWithSource: own.registerWithSource,
    unregister: own.unregister,
    unregisterByPack: own.unregisterByPack,
    get: (name) => own.get(name) ?? parent.get(name),
    getEntry: (name) => own.getEntry(name) ?? parent.getEntry(name),
    has: (name) => own.has(name) || parent.has(name),
    // Merge: overlay first (so an overlay override wins on duplicate names),
    // then parent entries that aren't shadowed.
    list: () => {
      const ownTools = own.list()
      const ownNames = new Set(ownTools.map(t => t.name))
      const fromParent = parent.list().filter(t => !ownNames.has(t.name))
      return [...ownTools, ...fromParent]
    },
    listEntries: () => {
      const ownEntries = own.listEntries()
      const ownNames = new Set(ownEntries.map(e => e.tool.name))
      const fromParent = parent.listEntries().filter(e => !ownNames.has(e.tool.name))
      return [...ownEntries, ...fromParent]
    },
  }
}
