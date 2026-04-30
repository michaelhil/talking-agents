// ============================================================================
// Mermaid Artifact Type — Persistent, updateable mermaid diagrams.
//
// Agents create via add_artifact { type: "mermaid", body: { source: "..." } }.
// Updates via update_artifact re-render in real-time in the workspace pane.
// ============================================================================

import type { Artifact, ArtifactTypeDefinition, ArtifactUpdateConfig, ArtifactUpdateResult } from '../types/artifact.ts'

export const mermaidArtifactType: ArtifactTypeDefinition = {
  type: 'mermaid',
  description: 'A persistent mermaid diagram. Create for diagrams that should update over time.',

  bodySchema: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'Mermaid diagram source code (graph, sequence, state, etc.)' },
    },
    required: ['source'],
  },

  validateBody: (body: unknown): boolean =>
    !!body && typeof body === 'object' && typeof (body as { source?: unknown }).source === 'string',

  onUpdate: (artifact: Artifact, updates: ArtifactUpdateConfig): ArtifactUpdateResult | void => {
    if (!updates.body) return
    if (typeof updates.body.source === 'string') {
      return { newBody: { ...artifact.body, source: updates.body.source } }
    }
  },

  formatForContext: (artifact: Artifact): string => {
    const source = (artifact.body as { source: string }).source
    return `Mermaid diagram: ${artifact.title} [id: ${artifact.id}]\n\`\`\`mermaid\n${source}\n\`\`\``
  },

  postSystemMessageOn: ['added', 'removed'],
}
