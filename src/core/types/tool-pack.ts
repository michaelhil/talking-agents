// Pure mapping from a ToolRegistryEntry to its owning pack name. Three
// callers (tool-surface/index.ts, diagnostics/surface-introspect.ts,
// agents/spawn.ts) previously each carried their own copy of this switch;
// drift between them was a latent risk. One source of truth here.
//
// Mapping:
//   built-in     → 'core'
//   external     → 'local'
//   pack-bundled → entry.source.pack ?? 'local'
//   skill-bundled→ entry.source.pack ?? 'local'

import type { ToolRegistryEntry } from './tool.ts'

export const packNameFor = (entry: ToolRegistryEntry): string => {
  switch (entry.source.kind) {
    case 'built-in': return 'core'
    case 'external': return 'local'
    case 'pack-bundled': return entry.source.pack ?? 'local'
    case 'skill-bundled': return entry.source.pack ?? 'local'
  }
}
