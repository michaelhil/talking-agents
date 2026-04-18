// Flow types — ordered agent sequences triggered by a single message.
// Leaf module.

export interface FlowStep {
  readonly agentId: string         // agent UUID (resolved once at flow creation)
  readonly agentName: string       // human-readable name (for display and LLM context)
  readonly stepPrompt?: string     // per-step instruction for this agent
}

export interface Flow {
  readonly id: string              // crypto.randomUUID() — or artifact ID when sourced from an artifact
  readonly name: string
  readonly steps: ReadonlyArray<FlowStep>
  readonly loop: boolean           // repeat or stop after one pass
  // Goal ancestry — set when flow is sourced from an artifact
  readonly artifactDescription?: string
  readonly goalChain?: ReadonlyArray<string>
}

export interface FlowExecution {
  readonly flow: Flow
  readonly triggerMessageId: string
  stepIndex: number
}

// Wire-level flow-event detail, indexed by event name. Emitted by room → UI.
export interface FlowEventDetails {
  readonly started: { readonly flowId: string; readonly agentName: string }
  readonly step: { readonly flowId: string; readonly stepIndex: number; readonly agentName: string }
  readonly completed: { readonly flowId: string }
  readonly cancelled: { readonly flowId: string }
}

export type FlowEventName = keyof FlowEventDetails
export type FlowEventDetail<E extends FlowEventName = FlowEventName> = FlowEventDetails[E]

// Carried in message.metadata when delivering in flow mode.
// Gives the receiving agent structural awareness of the flow.
export interface FlowDeliveryContext {
  readonly flowName: string
  readonly stepIndex: number                                    // 0-based index of this step
  readonly totalSteps: number
  readonly loop: boolean
  readonly steps: ReadonlyArray<{ readonly agentName: string }>
  // Goal ancestry — present when flow was sourced from an artifact
  readonly artifactDescription?: string
  readonly goalChain?: ReadonlyArray<string>
}
