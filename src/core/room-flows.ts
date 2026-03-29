// ============================================================================
// Flow Execution State — Manages in-flight flow execution for a Room.
//
// Flow blueprints are now Artifacts (system-level). This module only tracks
// the active execution: which flow is running, what step we're on, and
// notifies listeners of execution events (started/step/completed/cancelled).
// ============================================================================

import type { FlowExecution, OnFlowEvent } from './types.ts'

export interface FlowExecutionState {
  readonly getExecution: () => FlowExecution | undefined
  readonly setExecution: (exec: FlowExecution | undefined) => void
  readonly clearExecution: () => void
  readonly advanceStep: (nextStepIndex: number) => void
  readonly notifyFlowEvent: (event: 'started' | 'step' | 'completed' | 'cancelled', detail?: Record<string, unknown>) => void
}

export const createFlowExecutionState = (roomId: string, onFlowEvent?: OnFlowEvent): FlowExecutionState => {
  let flowExecution: FlowExecution | undefined

  const notifyFlowEvent = (event: 'started' | 'step' | 'completed' | 'cancelled', detail?: Record<string, unknown>): void => {
    onFlowEvent?.(roomId, event, detail)
  }

  return {
    getExecution: (): FlowExecution | undefined => flowExecution,
    setExecution: (exec: FlowExecution | undefined): void => { flowExecution = exec },
    clearExecution: (): void => { flowExecution = undefined },
    advanceStep: (nextStepIndex: number): void => {
      if (flowExecution) flowExecution.stepIndex = nextStepIndex
    },
    notifyFlowEvent,
  }
}
