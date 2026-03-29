// ============================================================================
// Delivery Modes — Pure functions for each room delivery strategy.
//
// Each mode function receives an `eligible` set (members minus user-muted)
// and delivers accordingly. Room.post() computes eligible once and passes it
// to the active mode. Muting and mode filtering are independent concerns.
//
// Modes:
//   broadcast  — deliver to all eligible members
//   flow       — deliver to current step agent (if eligible)
// ============================================================================

import type { DeliverFn, FlowDeliveryContext, FlowExecution, Message } from './types.ts'

// --- Shared delivery helper ---

export const deliverToAgent = (
  agentId: string,
  message: Message,
  deliver: DeliverFn,
): void => {
  deliver(agentId, message)
}

// --- Broadcast mode ---

export const deliverBroadcast = (
  message: Message,
  eligible: ReadonlySet<string>,
  deliver: DeliverFn,
): void => {
  for (const id of eligible) {
    deliverToAgent(id, message, deliver)
  }
}

// --- Flow mode ---

export interface FlowResult {
  readonly advanced: boolean
  readonly completed: boolean
  readonly looped: boolean
  readonly nextStepIndex: number
  readonly nextAgentName?: string
}

export const deliverFlow = (
  message: Message,
  execution: FlowExecution,
  eligible: ReadonlySet<string>,
  senderId: string,
  deliver: DeliverFn,
): FlowResult => {
  const currentStep = execution.flow.steps[execution.stepIndex]
  if (!currentStep) {
    return { advanced: false, completed: true, looped: false, nextStepIndex: execution.stepIndex }
  }

  // Only the expected step agent's chat response advances the flow.
  // Pass messages do not advance — the step stays open waiting for a real response.
  if (senderId !== currentStep.agentId || message.type === 'pass') {
    return { advanced: false, completed: false, looped: false, nextStepIndex: execution.stepIndex }
  }

  // Advance to next step — find next eligible agent
  const result = advanceFlowStep(execution, eligible)

  if (!result.completed && result.nextAgentId) {
    const nextStep = execution.flow.steps[result.nextStepIndex]!
    const flowContext: FlowDeliveryContext = {
      flowName: execution.flow.name,
      stepIndex: result.nextStepIndex,
      totalSteps: execution.flow.steps.length,
      loop: execution.flow.loop,
      steps: execution.flow.steps.map(s => ({ agentName: s.agentName })),
    }
    const enriched = {
      ...message,
      metadata: {
        ...message.metadata,
        ...(nextStep.stepPrompt ? { stepPrompt: nextStep.stepPrompt } : {}),
        flowContext,
      },
    }
    deliverToAgent(result.nextAgentId, enriched, deliver)
  }

  return { advanced: true, ...result }
}

// --- Flow step advancement (pure, no delivery side effects) ---
// Uses agentId directly from FlowStep — no name resolution needed.

export interface FlowAdvanceResult {
  readonly completed: boolean
  readonly looped: boolean
  readonly nextStepIndex: number
  readonly nextAgentId?: string
  readonly nextAgentName?: string
}

export const advanceFlowStep = (
  execution: FlowExecution,
  eligible: ReadonlySet<string>,
): FlowAdvanceResult => {
  let nextIndex = execution.stepIndex + 1
  let looped = false

  if (nextIndex >= execution.flow.steps.length) {
    if (execution.flow.loop) {
      nextIndex = 0
      looped = true
    } else {
      return { completed: true, looped: false, nextStepIndex: nextIndex }
    }
  }

  // Find next eligible step agent (skip ineligible)
  const stepsLength = execution.flow.steps.length
  let attempts = 0
  while (attempts < stepsLength) {
    const nextStep = execution.flow.steps[nextIndex]!

    if (eligible.has(nextStep.agentId)) {
      return { completed: false, looped, nextStepIndex: nextIndex, nextAgentId: nextStep.agentId, nextAgentName: nextStep.agentName }
    }

    // Skip ineligible agent
    nextIndex = (nextIndex + 1) % stepsLength
    if (nextIndex === 0 && !execution.flow.loop) {
      return { completed: true, looped: false, nextStepIndex: nextIndex }
    }
    attempts++
  }

  // All agents ineligible — flow is effectively complete
  return { completed: true, looped: false, nextStepIndex: nextIndex }
}
