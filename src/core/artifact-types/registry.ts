// ============================================================================
// Artifact Type Registry — Global registry of artifact type definitions.
//
// Mirrors ToolRegistry. Simple Map-based store keyed by type name.
// Types are registered at system init; looked up by ArtifactStore during CRUD.
// ============================================================================

import type { ArtifactTypeDefinition, ArtifactTypeRegistry } from '../types/artifact.ts'

export const createArtifactTypeRegistry = (): ArtifactTypeRegistry => {
  const defs = new Map<string, ArtifactTypeDefinition>()

  const register = (def: ArtifactTypeDefinition): void => {
    if (!def.type || typeof def.type !== 'string') {
      throw new Error('ArtifactTypeDefinition must have a non-empty string type')
    }
    defs.set(def.type, def)
  }

  return {
    register,
    get: (type: string): ArtifactTypeDefinition | undefined => defs.get(type),
    list: (): ReadonlyArray<ArtifactTypeDefinition> => [...defs.values()],
  }
}
