// ============================================================================
// Room — Self-contained component: messages + members + delivery.
//
// post() appends the message, dispatches delivery based on the active mode,
// and returns the stamped message. Room stamps its own roomId on messages.
//
// Delivery modes (mutually exclusive):
//   broadcast  — deliver to all non-muted members (default)
//   targeted   — no auto-delivery, human triggers manually via deliverMessageTo()
//   staleness  — one-at-a-time delivery, stalest participating agent first
//   flow       — follow predefined agent sequence with optional step prompts
//
// [[AgentName]] addressing overrides any mode — delivers only to addressed agents.
// Muting is universal — muted agents are excluded from all delivery in all modes.
//
// Mute/unmute events create 'mute' messages in the array (visible in history)
// but do NOT trigger delivery (agents see them as context on next real delivery).
// ============================================================================

import type {
  DeliverFn, DeliveryMode, Flow, FlowExecution, Message,
  OnDeliveryModeChanged, OnFlowEvent, OnTurnChanged,
  PostParams, Room, RoomProfile, StalenessState,
} from './types.ts'
import { DEFAULTS, SYSTEM_SENDER_ID } from './types.ts'
import { parseAddressedAgents } from './addressing.ts'
import {
  deliverBroadcast, deliverFlow, deliverStaleness, deliverTargeted, deliverToAgent,
} from './delivery-modes.ts'

export interface RoomCallbacks {
  readonly deliver?: DeliverFn
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

  // --- Delivery mode state ---
  let mode: DeliveryMode = 'broadcast'

  // Staleness state
  let stalenessPaused = false
  const stalenessParticipating = new Set<string>()
  let stalenessCurrentTurn: string | undefined

  // Flow state
  const flows = new Map<string, Flow>()
  let flowExecution: FlowExecution | undefined

  // --- Name resolution from message history ---

  const resolveNameToId = (name: string): string | undefined => {
    const lower = name.toLowerCase()
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.senderName?.toLowerCase() === lower) return messages[i]!.senderId
    }
    return undefined
  }

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

  // Kick off staleness chain from the stalest agent
  const kickstartStaleness = (message: Message): void => {
    if (!deliver || stalenessPaused) return
    const activeParticipants = new Set(
      [...stalenessParticipating].filter(id => !muted.has(id)),
    )
    const { nextTurn } = deliverStaleness(
      message, messages, activeParticipants, muted,
      undefined, '', deliver,
    )
    stalenessCurrentTurn = nextTurn
    notifyTurnChanged(nextTurn)
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

    // Join/leave messages are always broadcast regardless of mode
    // (agents need to know about membership changes, but these don't affect turns)
    if (message.type === 'join' || message.type === 'leave') {
      deliverBroadcast(message, members, muted, messages, deliver)
      return message
    }

    // 1. [[AgentName]] addressing override — works in ALL modes
    const addressedNames = parseAddressedAgents(message.content)
    if (addressedNames.length > 0) {
      const addressedIds = addressedNames
        .map(resolveNameToId)
        .filter((id): id is string => id !== undefined && members.has(id) && !muted.has(id))

      if (addressedIds.length > 0) {
        for (const id of addressedIds) {
          deliverToOne(id, message)
        }
        // In staleness mode, set the first addressed agent as currentTurn
        if (mode === 'staleness' && !stalenessPaused) {
          stalenessCurrentTurn = addressedIds[0]
          notifyTurnChanged(stalenessCurrentTurn)
        }
        // In flow mode, don't disrupt flow — addressed delivery is a one-off
        return message
      }
      // If no addressed agents resolved, fall through to mode dispatch
    }

    // 2. Mode dispatch
    switch (mode) {
      case 'broadcast':
        deliverBroadcast(message, members, muted, messages, deliver)
        break

      case 'targeted':
        deliverTargeted()
        break

      case 'staleness': {
        if (stalenessPaused) break
        const activeParticipants = new Set(
          [...stalenessParticipating].filter(id => !muted.has(id)),
        )
        const result = deliverStaleness(
          message, messages, activeParticipants, muted,
          stalenessCurrentTurn, params.senderId, deliver,
        )
        stalenessCurrentTurn = result.nextTurn
        notifyTurnChanged(result.nextTurn)
        break
      }

      case 'flow': {
        if (!flowExecution?.active) break
        const result = deliverFlow(
          message, messages, flowExecution, muted,
          params.senderId, resolveNameToId, deliver,
        )
        if (result.advanced) {
          if (result.completed) {
            const completedFlowId = flowExecution!.flow.id
            clearFlowExecution()
            mode = 'targeted'
            notifyFlowEvent('completed', { flowId: completedFlowId })
            notifyModeChanged()
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

    if (newMode !== 'staleness') {
      clearStalenessState()
    }

    if (prevMode !== newMode) {
      notifyModeChanged()
    }

    // If switching to staleness, kickstart from stalest
    if (newMode === 'staleness' && messages.length > 0) {
      const lastMsg = messages[messages.length - 1]!
      kickstartStaleness(lastMsg)
    }
  }

  // --- Muting ---

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

    // If muted agent is the current flow step, skip
    if (mode === 'flow' && flowExecution?.active && isMuted) {
      const currentStep = flowExecution.flow.steps[flowExecution.stepIndex]
      if (currentStep && resolveNameToId(currentStep.agentName) === agentId) {
        // Post a synthetic advance — trigger flow skip
        // The simplest approach: just advance the stepIndex and deliver to next
        const lastMsg = messages[messages.length - 1]!
        const result = deliverFlow(
          lastMsg, messages, flowExecution, muted,
          agentId, resolveNameToId, deliver!,
        )
        if (result.completed) {
          clearFlowExecution()
          mode = 'targeted'
          notifyFlowEvent('completed', { flowId: flowExecution!.flow.id })
          notifyModeChanged()
        } else if (result.advanced) {
          flowExecution!.stepIndex = result.nextStepIndex
          notifyFlowEvent('step', {
            flowId: flowExecution!.flow.id,
            stepIndex: result.nextStepIndex,
            agentName: result.nextAgentName,
          })
        }
      }
    }
  }

  // --- Targeted delivery ---

  const deliverMessageTo = (messageId: string, agentIds: ReadonlyArray<string>): void => {
    if (!deliver) return
    const msgIndex = messages.findIndex(m => m.id === messageId)
    if (msgIndex === -1) return
    const message = messages[msgIndex]!
    const history = messages.slice(0, msgIndex)
    for (const agentId of agentIds) {
      if (members.has(agentId) && !muted.has(agentId)) {
        deliver(agentId, message, history)
      }
    }
  }

  // --- Staleness controls ---

  const setStalenessPaused = (paused: boolean): void => {
    stalenessPaused = paused
    if (!paused && mode === 'staleness' && messages.length > 0) {
      const lastMsg = messages[messages.length - 1]!
      kickstartStaleness(lastMsg)
    } else if (paused) {
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

    // Deliver trigger message to first step agent
    const firstStep = flow.steps[0]!
    const agentId = resolveNameToId(firstStep.agentName)
    if (agentId && !muted.has(agentId)) {
      const enriched = firstStep.stepPrompt
        ? { ...lastMsg, metadata: { ...lastMsg.metadata, stepPrompt: firstStep.stepPrompt } }
        : lastMsg
      deliverToOne(agentId, enriched)
      notifyFlowEvent('started', { flowId: flow.id, agentName: firstStep.agentName })
    }
  }

  const cancelFlow = (): void => {
    if (!flowExecution?.active) return
    const flowId = flowExecution.flow.id
    clearFlowExecution()
    mode = 'targeted'
    notifyFlowEvent('cancelled', { flowId })
    notifyModeChanged()
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
    addMember: (id: string): void => { members.add(id) },
    removeMember: (id: string): void => { members.delete(id) },
    hasMember: (id: string): boolean => members.has(id),
    getMessageCount: (): number => messages.length,
    setRoomPrompt: (prompt: string) => {
      profile = { ...profile, roomPrompt: prompt }
    },

    // Delivery mode
    get deliveryMode() { return mode },
    setDeliveryMode,

    // Muting
    setMuted,
    isMuted: (agentId: string): boolean => muted.has(agentId),
    getMutedIds: (): ReadonlySet<string> => new Set(muted),

    // Targeted delivery
    deliverMessageTo,

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
