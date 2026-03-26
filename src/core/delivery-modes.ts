// ============================================================================
// Delivery Modes — Pure functions for each room delivery strategy.
//
// Each mode function receives room state and returns void (delivers directly).
// Room.post() dispatches to the active mode after handling message storage
// and [[AgentName]] addressing override.
//
// Modes:
//   broadcast  — deliver to all non-muted members
//   targeted   — no auto-delivery (human triggers manually)
//   staleness  — deliver to stalest non-muted participating agent
//   flow       — deliver to current step agent in predefined sequence
// ============================================================================

import type { DeliverFn, FlowExecution, FlowStep, Message } from './types.ts'
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
  members: ReadonlySet<string>,
  muted: ReadonlySet<string>,
  allMessages: ReadonlyArray<Message>,
  deliver: DeliverFn,
): void => {
  for (const id of members) {
    if (!muted.has(id)) {
      deliverToAgent(id, message, allMessages, deliver)
    }
  }
}

// --- Targeted mode ---
// No-op: messages are stored but not auto-delivered.

export const deliverTargeted = (): void => {
  // Intentionally empty — delivery is manual in targeted mode
}

// --- Staleness mode ---

export interface StalenessResult {
  readonly nextTurn: string | undefined
}

export const deliverStaleness = (
  message: Message,
  allMessages: ReadonlyArray<Message>,
  participating: ReadonlySet<string>,
  muted: ReadonlySet<string>,
  currentTurn: string | undefined,
  senderId: string,
  deliver: DeliverFn,
): StalenessResult => {
  // Filter out muted agents from participating set
  const activeParticipants = new Set(
    [...participating].filter(id => !muted.has(id)),
  )

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
  muted: ReadonlySet<string>,
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

  // Advance to next step
  let nextIndex = execution.stepIndex + 1
  let looped = false

  if (nextIndex >= execution.flow.steps.length) {
    if (execution.flow.loop) {
      nextIndex = 0
      looped = true
    } else {
      return { advanced: true, completed: true, looped: false, nextStepIndex: nextIndex }
    }
  }

  // Find next non-muted step (skip muted agents)
  const stepsLength = execution.flow.steps.length
  let attempts = 0
  while (attempts < stepsLength) {
    const nextStep = execution.flow.steps[nextIndex]!
    const nextAgentId = resolveNameToId(nextStep.agentName)

    if (nextAgentId && !muted.has(nextAgentId)) {
      // Deliver with step prompt in metadata if present
      const enriched = nextStep.stepPrompt
        ? { ...message, metadata: { ...message.metadata, stepPrompt: nextStep.stepPrompt } }
        : message
      deliverToAgent(nextAgentId, enriched, allMessages, deliver)
      return { advanced: true, completed: false, looped, nextStepIndex: nextIndex, nextAgentName: nextStep.agentName }
    }

    // Skip muted agent
    nextIndex = (nextIndex + 1) % stepsLength
    if (nextIndex === 0 && !execution.flow.loop) {
      return { advanced: true, completed: true, looped: false, nextStepIndex: nextIndex }
    }
    attempts++
  }

  // All agents in flow are muted — flow is effectively complete
  return { advanced: true, completed: true, looped: false, nextStepIndex: nextIndex }
}
