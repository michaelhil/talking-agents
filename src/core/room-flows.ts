// ============================================================================
// Flow Execution State — Manages in-flight flow execution for a Room.
//
// Flow blueprints are now Artifacts (system-level). This module only tracks
// the active execution: which flow is running, what step we're on, and
// notifies listeners of execution events (started/step/completed/cancelled).
// ============================================================================

import type { FlowExecution, FlowEventDetails, FlowEventName } from './types/flow.ts'
import type { OnFlowEvent } from './types/room.ts'

export interface FlowExecutionState {
  readonly getExecution: () => FlowExecution | undefined
  readonly setExecution: (exec: FlowExecution | undefined) => void
  readonly clearExecution: () => void
  readonly advanceStep: (nextStepIndex: number) => void
  readonly notifyFlowEvent: <E extends FlowEventName>(event: E, detail?: FlowEventDetails[E]) => void
}

export const createFlowExecutionState = (roomId: string, onFlowEvent?: OnFlowEvent): FlowExecutionState => {
  let flowExecution: FlowExecution | undefined

  const notifyFlowEvent = <E extends FlowEventName>(event: E, detail?: FlowEventDetails[E]): void => {
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
