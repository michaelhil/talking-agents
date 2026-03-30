// ============================================================================
// Flow Artifact — Shared helper for resolving a flow artifact into a Flow object.
//
// Used by both the WS command handler (artifact-commands.ts) and the MCP tool
// (message-tools.ts). Lives in src/core/ so both layers can import it without
// cross-layer dependencies.
//
// Builds goal ancestry from the artifact's description and the room's roomPrompt,
// giving each flow step's receiving agent context for *why* the flow was started.
// ============================================================================

import type { Artifact, Flow, FlowArtifactBody, FlowStep, Team } from './types.ts'

export interface ResolveFlowArtifactError {
  readonly error: string
}

export const resolveFlowArtifact = (
  artifact: Artifact,
  team: Team,
  roomPrompt?: string,
): Flow | ResolveFlowArtifactError => {
  if (artifact.type !== 'flow') {
    return { error: `Artifact "${artifact.id}" is not a flow (type: ${artifact.type})` }
  }

  const flowBody = artifact.body as FlowArtifactBody
  const steps: FlowStep[] = (flowBody.steps ?? []).map(s => ({
    agentId: s.agentId || (team.getAgent(s.agentName)?.id ?? ''),
    agentName: s.agentName,
    ...(s.stepPrompt ? { stepPrompt: s.stepPrompt } : {}),
  }))

  if (steps.length === 0) return { error: 'Flow has no steps' }

  const unresolvedStep = steps.find(s => !s.agentId)
  if (unresolvedStep) {
    return { error: `Flow step agent "${unresolvedStep.agentName}" not found` }
  }

  // Build goal ancestry: artifact title + optional room context
  // Gives each step agent "why" context alongside the "what"
  const goalChain: string[] = [artifact.title]
  if (roomPrompt) goalChain.push(roomPrompt)

  // Use description from top-level artifact field or fall back to body.description
  const artifactDescription =
    artifact.description ??
    (typeof flowBody.description === 'string' ? flowBody.description : undefined)

  return {
    id: artifact.id,
    name: artifact.title,
    steps,
    loop: flowBody.loop ?? false,
    ...(artifactDescription !== undefined ? { artifactDescription } : {}),
    goalChain,
  }
}

export const isFlowError = (result: Flow | ResolveFlowArtifactError): result is ResolveFlowArtifactError =>
  'error' in result
