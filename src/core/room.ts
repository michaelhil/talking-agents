// ============================================================================
// Room — Self-contained component: messages + members + delivery.
//
// post() appends the message, dispatches delivery based on the active mode,
// and returns the stamped message. Room stamps its own roomId on messages.
//
// Delivery pipeline:
//   1. Store message
//   2. Compute eligible = members - userMuted
//   3. Check paused flag (paused rooms store but don't deliver)
//   4. Apply mode filter (broadcast / staleness / flow)
//
// User muting and mode filtering are independent concerns applied in sequence.
// System code NEVER modifies the muted set — only explicit setMuted() calls do.
//
// [[AgentName]] addressing overrides any mode — delivers only to addressed agents.
// Pause flag stops all delivery (join/leave and addressing still work).
// ============================================================================

import type {
  DeliverFn, DeliveryMode, Flow, FlowExecution, Message,
  OnDeliveryModeChanged, OnFlowEvent, OnMessagePosted, OnTurnChanged,
  PostParams, ResolveAgentName, Room, RoomProfile, RoomState, StalenessState,
} from './types.ts'
import { DEFAULTS, SYSTEM_SENDER_ID } from './types.ts'
import { parseAddressedAgents } from './addressing.ts'
import {
  advanceFlowStep, deliverBroadcast, deliverFlow, deliverStaleness, deliverToAgent,
} from './delivery-modes.ts'

export interface RoomCallbacks {
  readonly deliver?: DeliverFn
  readonly resolveAgentName?: ResolveAgentName
  readonly onMessagePosted?: OnMessagePosted
  readonly onTurnChanged?: OnTurnChanged
  readonly onDeliveryModeChanged?: OnDeliveryModeChanged
  readonly onFlowEvent?: OnFlowEvent
}

export const createRoom = (
  initialProfile: RoomProfile,
  callbacks?: RoomCallbacks,
  maxMessages?: number,
): Room => {
  let profile = initialProfile
  const messages: Message[] = []
  const members = new Set<string>()
  const muted = new Set<string>()
  const messageLimit = maxMessages ?? DEFAULTS.roomMessageLimit

  const deliver = callbacks?.deliver

  // --- State ---
  let mode: DeliveryMode = 'broadcast'
  let paused = false

  // Staleness state
  let stalenessPaused = false
  const stalenessParticipating = new Set<string>()
  let stalenessCurrentTurn: string | undefined

  // Flow state
  const flows = new Map<string, Flow>()
  let flowExecution: FlowExecution | undefined

  // Agent name → ID resolution (injected from Team via callbacks)
  const resolveAgentName = callbacks?.resolveAgentName

  // --- Eligible set: members minus user-muted ---

  const computeEligible = (): Set<string> =>
    new Set([...members].filter(id => !muted.has(id)))

  // --- Internal helpers ---

  const deliverToOne = (agentId: string, message: Message): void => {
    if (!deliver) return
    deliverToAgent(agentId, message, messages, deliver)
  }

  const notifyTurnChanged = (agentId?: string, waitingForHuman?: boolean): void => {
    callbacks?.onTurnChanged?.(profile.id, agentId, waitingForHuman)
  }

  const notifyModeChanged = (): void => {
    callbacks?.onDeliveryModeChanged?.(profile.id, mode)
  }

  const notifyFlowEvent = (event: 'started' | 'step' | 'completed' | 'cancelled', detail?: Record<string, unknown>): void => {
    callbacks?.onFlowEvent?.(profile.id, event, detail)
  }

  const clearStalenessState = (): void => {
    stalenessCurrentTurn = undefined
    stalenessPaused = false
  }

  const clearFlowExecution = (): void => {
    flowExecution = undefined
  }

  const kickstartStaleness = (message: Message): void => {
    if (!deliver || stalenessPaused) return
    const eligible = computeEligible()
    const activeParticipants = new Set(
      [...stalenessParticipating].filter(id => eligible.has(id)),
    )
    const { nextTurn } = deliverStaleness(
      message, messages, activeParticipants,
      undefined, '', deliver,
    )
    stalenessCurrentTurn = nextTurn
    notifyTurnChanged(nextTurn)
  }

  // Handle flow completion or cancellation: switch to broadcast + pause
  const endFlow = (flowId: string, event: 'completed' | 'cancelled'): void => {
    clearFlowExecution()
    mode = 'broadcast'
    paused = true
    notifyFlowEvent(event, { flowId })
    notifyModeChanged()
  }

  // --- Post ---

  const post = (params: PostParams): Message => {
    if (!params.senderId || params.senderId.trim() === '') {
      throw new Error('post() requires a non-empty senderId')
    }

    const message: Message = {
      id: crypto.randomUUID(),
      roomId: profile.id,
      senderId: params.senderId,
      senderName: params.senderName,
      content: params.content,
      timestamp: Date.now(),
      type: params.type,
      correlationId: params.correlationId,
      generationMs: params.generationMs,
      metadata: params.metadata,
    }
    messages.push(message)

    // Notify observers (e.g. WS broadcast to UI) — always, regardless of delivery mode
    callbacks?.onMessagePosted?.(profile.id, message)

    // Sender becomes a member implicitly
    if (params.senderId !== SYSTEM_SENDER_ID) {
      members.add(params.senderId)
    }

    // Evict oldest messages if over limit
    if (messages.length > messageLimit) {
      messages.splice(0, messages.length - messageLimit)
    }

    // --- Delivery dispatch ---
    // Do NOT deliver: system, mute, room_summary (stored in history, seen as context)
    const nonDeliverable = message.type === 'system' || message.type === 'mute' || message.type === 'room_summary'
    if (nonDeliverable || !deliver) return message

    // Compute eligible once: members minus user-muted
    const eligible = computeEligible()

    // Join/leave messages are always broadcast regardless of mode and pause
    if (message.type === 'join' || message.type === 'leave') {
      deliverBroadcast(message, eligible, messages, deliver)
      return message
    }

    // [[AgentName]] addressing override — works in ALL modes, even when paused
    const addressedNames = parseAddressedAgents(message.content)
    if (addressedNames.length > 0 && resolveAgentName) {
      const addressedIds = addressedNames
        .map(resolveAgentName)
        .filter((id): id is string => id !== undefined && members.has(id) && !muted.has(id))

      if (addressedIds.length > 0) {
        for (const id of addressedIds) {
          deliverToOne(id, message)
        }
        // Addressing is a one-off override — does NOT change staleness turn or flow state
        return message
      }
      // If no addressed agents resolved, fall through to mode dispatch
    }

    // Paused: store but don't deliver
    if (paused) return message

    // Mode dispatch
    switch (mode) {
      case 'broadcast':
        deliverBroadcast(message, eligible, messages, deliver)
        break

      case 'staleness': {
        if (stalenessPaused) break
        const activeParticipants = new Set(
          [...stalenessParticipating].filter(id => eligible.has(id)),
        )
        const result = deliverStaleness(
          message, messages, activeParticipants,
          stalenessCurrentTurn, params.senderId, deliver,
        )
        stalenessCurrentTurn = result.nextTurn
        notifyTurnChanged(result.nextTurn)
        break
      }

      case 'flow': {
        if (!flowExecution?.active) break
        const result = deliverFlow(
          message, messages, flowExecution, eligible,
          params.senderId, deliver,
        )
        if (result.advanced) {
          if (result.completed) {
            endFlow(flowExecution!.flow.id, 'completed')
          } else {
            flowExecution!.stepIndex = result.nextStepIndex
            notifyFlowEvent('step', {
              flowId: flowExecution!.flow.id,
              stepIndex: result.nextStepIndex,
              agentName: result.nextAgentName,
            })
          }
        }
        break
      }
    }

    return message
  }

  // --- Delivery mode controls ---

  const setDeliveryMode = (newMode: Exclude<DeliveryMode, 'flow'>): void => {
    // Cancel flow if active
    if (flowExecution?.active) {
      const flowId = flowExecution.flow.id
      clearFlowExecution()
      notifyFlowEvent('cancelled', { flowId })
    }

    const prevMode = mode
    mode = newMode
    paused = false  // switching mode clears pause

    if (newMode !== 'staleness') {
      clearStalenessState()
    }

    // Notify even if mode unchanged — pause state may have changed
    notifyModeChanged()

    // If switching to staleness, auto-populate participating with all eligible members
    if (newMode === 'staleness') {
      if (stalenessParticipating.size === 0) {
        const eligible = computeEligible()
        for (const id of eligible) {
          stalenessParticipating.add(id)
        }
      }
      if (messages.length > 0) {
        const lastMsg = messages[messages.length - 1]!
        kickstartStaleness(lastMsg)
      }
    }
  }

  // --- Muting (user-controlled, never modified by system/mode logic) ---

  const setMuted = (agentId: string, isMuted: boolean): void => {
    const wasMuted = muted.has(agentId)
    if (isMuted === wasMuted) return

    if (isMuted) {
      muted.add(agentId)
    } else {
      muted.delete(agentId)
    }

    // Resolve agent name for the system message
    let agentName: string | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.senderId === agentId) {
        agentName = messages[i]!.senderName
        break
      }
    }
    const displayName = agentName ?? agentId

    // Post mute/unmute system message (stored in history, NOT delivered)
    const muteMessage: Message = {
      id: crypto.randomUUID(),
      roomId: profile.id,
      senderId: SYSTEM_SENDER_ID,
      content: isMuted ? `${displayName} has been muted` : `${displayName} has been unmuted`,
      timestamp: Date.now(),
      type: 'mute',
    }
    messages.push(muteMessage)

    // If muted agent had the staleness turn, advance
    if (mode === 'staleness' && stalenessCurrentTurn === agentId && isMuted) {
      const lastMsg = messages[messages.length - 1]!
      kickstartStaleness(lastMsg)
    }

    // If muted agent is the current flow step, skip via advanceFlowStep
    if (mode === 'flow' && flowExecution?.active && isMuted) {
      const currentStep = flowExecution.flow.steps[flowExecution.stepIndex]
      if (currentStep && currentStep.agentId === agentId) {
        const eligible = computeEligible()
        const result = advanceFlowStep(flowExecution, eligible)
        if (result.completed) {
          endFlow(flowExecution.flow.id, 'completed')
        } else if (result.nextAgentId) {
          flowExecution.stepIndex = result.nextStepIndex
          if (deliver) {
            const nextAgentId = result.nextAgentId
            const lastMsg = messages[messages.length - 1]!
            const nextStep = flowExecution.flow.steps[result.nextStepIndex]!
            const enriched = nextStep.stepPrompt
              ? { ...lastMsg, metadata: { ...lastMsg.metadata, stepPrompt: nextStep.stepPrompt } }
              : lastMsg
            deliverToOne(nextAgentId, enriched)
          }
          notifyFlowEvent('step', {
            flowId: flowExecution.flow.id,
            stepIndex: result.nextStepIndex,
            agentName: result.nextAgentName,
          })
        }
      }
    }
  }

  // --- Staleness controls ---

  const setStalenessPaused = (p: boolean): void => {
    stalenessPaused = p
    if (!p && mode === 'staleness' && messages.length > 0) {
      const lastMsg = messages[messages.length - 1]!
      kickstartStaleness(lastMsg)
    } else if (p) {
      stalenessCurrentTurn = undefined
      notifyTurnChanged(undefined)
    }
  }

  const setParticipating = (agentId: string, participating: boolean): void => {
    if (participating) {
      stalenessParticipating.add(agentId)
    } else {
      stalenessParticipating.delete(agentId)
      if (stalenessCurrentTurn === agentId) {
        stalenessCurrentTurn = undefined
        if (mode === 'staleness' && !stalenessPaused && messages.length > 0) {
          const lastMsg = messages[messages.length - 1]!
          kickstartStaleness(lastMsg)
        }
      }
    }
  }

  // --- Flow management ---

  const addFlow = (config: Omit<Flow, 'id'>): Flow => {
    const flow: Flow = { ...config, id: crypto.randomUUID() }
    flows.set(flow.id, flow)
    return flow
  }

  const removeFlow = (flowId: string): boolean => {
    if (flowExecution?.flow.id === flowId) {
      cancelFlow()
    }
    return flows.delete(flowId)
  }

  const startFlow = (flowId: string): void => {
    const flow = flows.get(flowId)
    if (!flow || flow.steps.length === 0) return

    // Cancel existing flow if any
    if (flowExecution?.active) {
      notifyFlowEvent('cancelled', { flowId: flowExecution.flow.id })
    }

    clearStalenessState()
    paused = false
    const lastMsg = messages[messages.length - 1]
    if (!lastMsg || !deliver) return

    flowExecution = {
      flow,
      triggerMessageId: lastMsg.id,
      stepIndex: 0,
      active: true,
    }
    mode = 'flow'
    notifyModeChanged()

    // Deliver trigger message to first eligible step agent
    const eligible = computeEligible()
    const firstStep = flow.steps[0]!
    if (eligible.has(firstStep.agentId)) {
      const agentId = firstStep.agentId
      const enriched = firstStep.stepPrompt
        ? { ...lastMsg, metadata: { ...lastMsg.metadata, stepPrompt: firstStep.stepPrompt } }
        : lastMsg
      deliverToOne(agentId, enriched)
      notifyFlowEvent('started', { flowId: flow.id, agentName: firstStep.agentName })
    }
  }

  const cancelFlow = (): void => {
    if (!flowExecution?.active) return
    endFlow(flowExecution.flow.id, 'cancelled')
  }

  // --- Room interface ---

  return {
    get profile() { return profile },
    post,
    getRecent: (n: number): ReadonlyArray<Message> => {
      if (n <= 0) return []
      if (messages.length <= n) return [...messages]
      return messages.slice(-n)
    },
    getParticipantIds: (): ReadonlyArray<string> => [...members],
    addMember: (id: string): void => {
      members.add(id)
      // Auto-add to staleness participation when mode is active
      if (mode === 'staleness') {
        stalenessParticipating.add(id)
      }
    },
    removeMember: (id: string): void => { members.delete(id) },
    hasMember: (id: string): boolean => members.has(id),
    getMessageCount: (): number => messages.length,
    setRoomPrompt: (prompt: string) => {
      profile = { ...profile, roomPrompt: prompt }
    },

    // Delivery mode
    get deliveryMode() { return mode },
    setDeliveryMode,

    // Pause
    get paused() { return paused },
    setPaused: (p: boolean): void => { paused = p },

    // Room state snapshot
    getRoomState: (): RoomState => ({
      mode,
      paused,
      muted: [...muted],
      staleness: {
        paused: stalenessPaused,
        participating: new Set(stalenessParticipating),
        currentTurn: stalenessCurrentTurn,
      },
      ...(flowExecution ? {
        flowExecution: {
          flowId: flowExecution.flow.id,
          stepIndex: flowExecution.stepIndex,
          active: flowExecution.active,
        },
      } : {}),
    }),

    // Muting
    setMuted,
    isMuted: (agentId: string): boolean => muted.has(agentId),
    getMutedIds: (): ReadonlySet<string> => new Set(muted),

    // Staleness
    get staleness(): StalenessState {
      return {
        paused: stalenessPaused,
        participating: new Set(stalenessParticipating),
        currentTurn: stalenessCurrentTurn,
      }
    },
    setStalenessPaused,
    setParticipating,

    // Flow management
    addFlow,
    removeFlow: (flowId: string): boolean => removeFlow(flowId),
    getFlows: (): ReadonlyArray<Flow> => [...flows.values()],
    startFlow,
    cancelFlow,
    get flowExecution() { return flowExecution },
  }
}
