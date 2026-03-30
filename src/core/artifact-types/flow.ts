// ============================================================================
// Flow Artifact Type
//
// A reusable flow blueprint (ordered agent step sequence).
// The blueprint is stored as an artifact; execution is managed by room.ts.
//
// When starting a flow, callers resolve this artifact to construct a Flow
// object: { id: artifact.id, name: artifact.title, ...artifact.body }
// and pass it to room.startFlow(flow).
//
// Factory function: takes Team so onCreate can resolve agent names → IDs
// in step definitions that omit agentId.
// ============================================================================

import type { Artifact, ArtifactTypeDefinition, FlowArtifactBody, FlowStep, Team } from '../types.ts'

export const createFlowArtifactType = (team: Team): ArtifactTypeDefinition => ({
  type: 'flow',
  description: 'A reusable agent sequence blueprint. Start execution via start_flow.',

  bodySchema: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        description: 'Ordered agent steps',
        items: {
          type: 'object',
          properties: {
            agentName: { type: 'string', description: 'Agent name (resolved to ID at creation)' },
            agentId: { type: 'string', description: 'Agent UUID (auto-resolved from agentName if omitted)' },
            stepPrompt: { type: 'string', description: 'Per-step instruction for this agent' },
          },
          required: ['agentName'],
        },
      },
      loop: { type: 'boolean', description: 'Whether the flow repeats after all steps complete' },
      description: { type: 'string', description: 'Optional description of the flow purpose' },
    },
    required: ['steps', 'loop'],
  },

  onCreate: (artifact: Artifact): void => {
    // Resolve agentName → agentId for any steps missing agentId.
    // Note: we can't mutate artifact here (already stored). The resolution is done
    // at add time by the artifact store calling our onUpdate with a synthetic update,
    // OR callers are expected to provide agentId. The add_artifact tool resolves names.
    // onCreate is a hook for side-effects (e.g. notifications) — not body mutation.
    void team  // team reference available for validation if needed
    void artifact
  },

  onUpdate: (artifact: Artifact, updates): import('../types.ts').ArtifactUpdateResult | void => {
    if (!updates.body?.steps) return  // no steps change — default merge
    const body = artifact.body as FlowArtifactBody
    // Resolve any steps missing agentId
    const rawSteps = updates.body.steps as Array<Partial<FlowStep>>
    const resolvedSteps: FlowStep[] = rawSteps.map(s => {
      const agentId = s.agentId ?? (s.agentName ? team.getAgent(s.agentName)?.id : undefined) ?? ''
      const agentName = s.agentName ?? ''
      return { agentId, agentName, ...(s.stepPrompt ? { stepPrompt: s.stepPrompt } : {}) }
    })
    return { newBody: { ...body, ...updates.body, steps: resolvedSteps } }
  },

  formatForContext: (artifact: Artifact): string => {
    const body = artifact.body as FlowArtifactBody
    const steps = body.steps ?? []
    const sequence = steps.map(s => s.agentName).join(' → ')
    const loopTag = body.loop ? ' [loops]' : ''
    const desc = artifact.description ?? body.description
    const lines = [
      `Flow: "${artifact.title}" [id: ${artifact.id}]${loopTag}`,
      ...(desc ? [`  Purpose: ${desc}`] : []),
      `  Sequence: ${sequence || '(no steps)'}`,
      `  Start with: start_flow { roomName: "<room>", flowArtifactId: "${artifact.id}", content: "<trigger>" }`,
    ]
    return lines.join('\n')
  },

  formatUpdateMessage: (artifact: Artifact): string =>
    `flow "${artifact.title}" was updated`,

  postSystemMessageOn: ['added', 'updated', 'removed'],
})
