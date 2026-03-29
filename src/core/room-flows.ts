// ============================================================================
// Room Flows — Creates and manages the flows Map for a Room.
// ============================================================================

import type { Flow, FlowExecution, OnFlowEvent } from './types.ts'

export interface FlowStore {
  readonly addFlow: (config: Omit<Flow, 'id'>) => Flow
  readonly removeFlow: (flowId: string, cancelFn: () => void) => boolean
  readonly getFlow: (flowId: string) => Flow | undefined
  readonly getFlows: () => ReadonlyArray<Flow>
  readonly getExecution: () => FlowExecution | undefined
  readonly setExecution: (exec: FlowExecution | undefined) => void
  readonly clearExecution: () => void
  readonly notifyFlowEvent: (event: 'started' | 'step' | 'completed' | 'cancelled', detail?: Record<string, unknown>) => void
  readonly restoreFlows: (flowList: ReadonlyArray<Flow>) => void
}

export const createFlowStore = (roomId: string, onFlowEvent?: OnFlowEvent): FlowStore => {
  const flows = new Map<string, Flow>()
  let flowExecution: FlowExecution | undefined

  const notifyFlowEvent = (event: 'started' | 'step' | 'completed' | 'cancelled', detail?: Record<string, unknown>): void => {
    onFlowEvent?.(roomId, event, detail)
  }

  const addFlow = (config: Omit<Flow, 'id'>): Flow => {
    const flow: Flow = { ...config, id: crypto.randomUUID() }
    flows.set(flow.id, flow)
    return flow
  }

  const removeFlow = (flowId: string, cancelFn: () => void): boolean => {
    if (flowExecution?.flow.id === flowId) {
      cancelFn()
    }
    return flows.delete(flowId)
  }

  const getFlow = (flowId: string): Flow | undefined => flows.get(flowId)

  const getFlows = (): ReadonlyArray<Flow> => [...flows.values()]

  const getExecution = (): FlowExecution | undefined => flowExecution

  const setExecution = (exec: FlowExecution | undefined): void => {
    flowExecution = exec
  }

  const clearExecution = (): void => {
    flowExecution = undefined
  }

  const restoreFlows = (flowList: ReadonlyArray<Flow>): void => {
    flows.clear()
    for (const flow of flowList) flows.set(flow.id, flow)
  }

  return { addFlow, removeFlow, getFlow, getFlows, getExecution, setExecution, clearExecution, notifyFlowEvent, restoreFlows }
}
