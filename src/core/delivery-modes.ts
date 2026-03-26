// ============================================================================
// Delivery Modes — Pure functions for each room delivery strategy.
//
// Each mode function receives an `eligible` set (members minus user-muted)
// and delivers accordingly. Room.post() computes eligible once and passes it
// to the active mode. Muting and mode filtering are independent concerns.
//
// Modes:
//   broadcast  — deliver to all eligible members
//   staleness  — deliver to stalest eligible participating agent
//   flow       — deliver to current step agent (if eligible)
// ============================================================================

import type { DeliverFn, FlowExecution, Message } from './types.ts'
import { findStalestAgent } from './staleness.ts'

// --- Shared delivery helper ---

export const deliverToAgent = (
  agentId: string,
  message: Message,
  allMessages: ReadonlyArray<Message>,
  deliver: DeliverFn,
): void => {
  // History = all messages before the current one
  const msgIndex = allMessages.indexOf(message)
  const history = msgIndex > 0 ? allMessages.slice(0, msgIndex) : allMessages.slice(0, -1)
  deliver(agentId, message, history)
}

// --- Broadcast mode ---

export const deliverBroadcast = (
  message: Message,
  eligible: ReadonlySet<string>,
  allMessages: ReadonlyArray<Message>,
  deliver: DeliverFn,
): void => {
  for (const id of eligible) {
    deliverToAgent(id, message, allMessages, deliver)
  }
}

// --- Staleness mode ---

export interface StalenessResult {
  readonly nextTurn: string | undefined
}

export const deliverStaleness = (
  message: Message,
  allMessages: ReadonlyArray<Message>,
  activeParticipants: ReadonlySet<string>,
  currentTurn: string | undefined,
  senderId: string,
  deliver: DeliverFn,
): StalenessResult => {
  if (senderId === currentTurn) {
    // Current turn holder responded — advance to next stalest
    const next = findStalestAgent(allMessages, activeParticipants, senderId)
    if (next) {
      deliverToAgent(next, message, allMessages, deliver)
    }
    return { nextTurn: next }
  }

  if (!currentTurn) {
    // Chain is idle — kickstart from stalest
    const next = findStalestAgent(allMessages, activeParticipants)
    if (next) {
      deliverToAgent(next, message, allMessages, deliver)
    }
    return { nextTurn: next }
  }

  // Someone posted while another agent has the floor.
  // Message is stored but not delivered — current turn holder
  // will see it in history when the chain reaches them.
  return { nextTurn: currentTurn }
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
  allMessages: ReadonlyArray<Message>,
  execution: FlowExecution,
  eligible: ReadonlySet<string>,
  senderId: string,
  resolveNameToId: (name: string) => string | undefined,
  deliver: DeliverFn,
): FlowResult => {
  const currentStep = execution.flow.steps[execution.stepIndex]
  if (!currentStep) {
    return { advanced: false, completed: true, looped: false, nextStepIndex: execution.stepIndex }
  }

  const currentAgentId = resolveNameToId(currentStep.agentName)

  // Only the expected step agent's response advances the flow
  if (senderId !== currentAgentId) {
    return { advanced: false, completed: false, looped: false, nextStepIndex: execution.stepIndex }
  }

  // Advance to next step — find next eligible agent
  const result = advanceFlowStep(execution, eligible, resolveNameToId)

  if (!result.completed && result.nextAgentName) {
    const nextAgentId = resolveNameToId(result.nextAgentName)
    if (nextAgentId) {
      const nextStep = execution.flow.steps[result.nextStepIndex]!
      const enriched = nextStep.stepPrompt
        ? { ...message, metadata: { ...message.metadata, stepPrompt: nextStep.stepPrompt } }
        : message
      deliverToAgent(nextAgentId, enriched, allMessages, deliver)
    }
  }

  return { advanced: true, ...result }
}

// --- Flow step advancement (pure, no delivery side effects) ---
// Used by deliverFlow for normal advancement, and by room.ts when
// muting the current step agent (skip without fake senderId).

export interface FlowAdvanceResult {
  readonly completed: boolean
  readonly looped: boolean
  readonly nextStepIndex: number
  readonly nextAgentName?: string
}

export const advanceFlowStep = (
  execution: FlowExecution,
  eligible: ReadonlySet<string>,
  resolveNameToId: (name: string) => string | undefined,
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
    const nextAgentId = resolveNameToId(nextStep.agentName)

    if (nextAgentId && eligible.has(nextAgentId)) {
      return { completed: false, looped, nextStepIndex: nextIndex, nextAgentName: nextStep.agentName }
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
