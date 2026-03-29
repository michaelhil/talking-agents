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
//   4. Apply mode filter (broadcast / flow)
//
// User muting and mode filtering are independent concerns applied in sequence.
// System code NEVER modifies the muted set — only explicit setMuted() calls do.
//
// [[AgentName]] addressing overrides any mode — delivers only to addressed agents.
// Pause flag stops all delivery (join/leave and addressing still work).
// ============================================================================

import type {
  DeliverFn, DeliveryMode, Flow, FlowDeliveryContext,
  Message, OnDeliveryModeChanged, OnFlowEvent, OnMessagePosted, OnTodoChanged,
  OnTurnChanged, PostParams, ResolveAgentName, Room, RoomProfile, RoomRestoreParams, RoomState,
} from './types.ts'
import { DEFAULTS, SYSTEM_SENDER_ID } from './types.ts'
import { parseAddressedAgents } from './addressing.ts'
import { advanceFlowStep, deliverBroadcast, deliverFlow } from './delivery-modes.ts'
import { createTodoStore } from './room-todos.ts'
import { createFlowStore } from './room-flows.ts'

export interface RoomCallbacks {
  readonly deliver?: DeliverFn
  readonly resolveAgentName?: ResolveAgentName
  readonly onMessagePosted?: OnMessagePosted
  readonly onTurnChanged?: OnTurnChanged
  readonly onDeliveryModeChanged?: OnDeliveryModeChanged
  readonly onFlowEvent?: OnFlowEvent
  readonly onTodoChanged?: OnTodoChanged
}

export const createRoom = (
  initialProfile: RoomProfile,
  callbacks?: RoomCallbacks,
  maxMessages?: number,
): Room => {
  let profile = initialProfile
  const messages: Message[] = []
  const compressedIds = new Set<string>()
  const members = new Set<string>()
  const muted = new Set<string>()
  const messageLimit = maxMessages ?? DEFAULTS.roomMessageLimit

  const deliver = callbacks?.deliver
  const resolveAgentName = callbacks?.resolveAgentName

  // --- State ---
  let mode: DeliveryMode = 'broadcast'
  let paused = false

  // Sub-systems
  const todoStore = createTodoStore(profile.id, callbacks?.onTodoChanged)
  const flowStore = createFlowStore(profile.id, callbacks?.onFlowEvent)

  // --- Eligible set: members minus user-muted ---

  const computeEligible = (): Set<string> =>
    new Set([...members].filter(id => !muted.has(id)))

  // --- Internal helpers ---

  const deliverToOne = (agentId: string, message: Message): void => {
    deliver?.(agentId, message)
  }

  const notifyModeChanged = (): void => {
    callbacks?.onDeliveryModeChanged?.(profile.id, mode)
  }

  const endFlow = (flowId: string, event: 'completed' | 'cancelled'): void => {
    flowStore.clearExecution()
    mode = 'broadcast'
    paused = true
    flowStore.notifyFlowEvent(event, { flowId })
    notifyModeChanged()
  }

  // --- Post helpers ---

  // Pure message construction from params + room context
  const createRoomMessage = (params: PostParams): Message => ({
    id: crypto.randomUUID(),
    roomId: profile.id,
    senderId: params.senderId,
    senderName: params.senderName,
    content: params.content,
    timestamp: Date.now(),
    type: params.type,
    correlationId: params.correlationId,
    inReplyTo: params.inReplyTo,
    generationMs: params.generationMs,
    metadata: params.metadata,
  })

  // Deliver message to addressed agents (override mode dispatch)
  const dispatchToAddressed = (message: Message, addressedNames: ReadonlyArray<string>): boolean => {
    if (!resolveAgentName) return false
    const addressedIds = addressedNames
      .map(resolveAgentName)
      .filter((id): id is string => id !== undefined && members.has(id) && !muted.has(id))
    if (addressedIds.length === 0) return false
    for (const id of addressedIds) deliverToOne(id, message)
    return true
  }

  // --- Post ---

  const post = (params: PostParams): Message => {
    if (!params.senderId || params.senderId.trim() === '') {
      throw new Error('post() requires a non-empty senderId')
    }

    const message = createRoomMessage(params)
    messages.push(message)

    callbacks?.onMessagePosted?.(profile.id, message)

    if (params.senderId !== SYSTEM_SENDER_ID && params.type !== 'join' && params.type !== 'leave') {
      members.add(params.senderId)
    }

    if (messages.length > messageLimit) {
      const pruned = messages.splice(0, messages.length - messageLimit)
      for (const msg of pruned) compressedIds.add(msg.id)
    }

    const nonDeliverable = message.type === 'system' || message.type === 'mute' || message.type === 'room_summary'
    if (nonDeliverable || !deliver) return message

    const eligible = computeEligible()

    if (message.type === 'join' || message.type === 'leave') {
      deliverBroadcast(message, eligible, deliver)
      return message
    }

    // [[AgentName]] addressing override — works in ALL modes, even when paused
    const addressedNames = parseAddressedAgents(message.content)
    if (addressedNames.length > 0 && dispatchToAddressed(message, addressedNames)) {
      return message
    }

    if (paused) return message

    switch (mode) {
      case 'broadcast':
        deliverBroadcast(message, eligible, deliver)
        break

      case 'flow': {
        const flowExecution = flowStore.getExecution()
        if (!flowExecution) break
        const result = deliverFlow(message, flowExecution, eligible, params.senderId, deliver)
        if (result.advanced) {
          if (result.completed) {
            endFlow(flowExecution.flow.id, 'completed')
          } else {
            flowStore.advanceStep(result.nextStepIndex)
            flowStore.notifyFlowEvent('step', {
              flowId: flowExecution.flow.id,
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
    const flowExecution = flowStore.getExecution()
    if (flowExecution) {
      const flowId = flowExecution.flow.id
      flowStore.clearExecution()
      flowStore.notifyFlowEvent('cancelled', { flowId })
    }
    mode = newMode
    paused = false
    notifyModeChanged()
  }

  // --- Muting ---

  // When the current flow step agent is muted, skip to the next eligible agent.
  const handleFlowOnMute = (agentId: string, lastChatMsg: Message | undefined): void => {
    const flowExecution = flowStore.getExecution()
    if (!flowExecution) return
    const currentStep = flowExecution.flow.steps[flowExecution.stepIndex]
    if (!currentStep || currentStep.agentId !== agentId) return

    const eligible = computeEligible()
    const result = advanceFlowStep(flowExecution, eligible)
    if (result.completed) {
      endFlow(flowExecution.flow.id, 'completed')
    } else if (result.nextAgentId && lastChatMsg) {
      flowStore.advanceStep(result.nextStepIndex)
      const nextStep = flowExecution.flow.steps[result.nextStepIndex]!
      const enriched = nextStep.stepPrompt
        ? { ...lastChatMsg, metadata: { ...lastChatMsg.metadata, stepPrompt: nextStep.stepPrompt } }
        : lastChatMsg
      deliverToOne(result.nextAgentId, enriched)
      flowStore.notifyFlowEvent('step', {
        flowId: flowExecution.flow.id,
        stepIndex: result.nextStepIndex,
        agentName: result.nextAgentName,
      })
    }
  }

  const setMuted = (agentId: string, isMuted: boolean): void => {
    const wasMuted = muted.has(agentId)
    if (isMuted === wasMuted) return

    if (isMuted) {
      muted.add(agentId)
    } else {
      muted.delete(agentId)
    }

    let agentName: string | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.senderId === agentId) {
        agentName = messages[i]!.senderName
        break
      }
    }
    const displayName = agentName ?? agentId

    // Capture last message BEFORE pushing the mute system message — the flow
    // advancement below needs to re-deliver the conversation message, not the mute notice.
    const lastChatMsg = messages[messages.length - 1]

    const muteMessage: Message = {
      id: crypto.randomUUID(),
      roomId: profile.id,
      senderId: SYSTEM_SENDER_ID,
      content: isMuted ? `${displayName} has been muted` : `${displayName} has been unmuted`,
      timestamp: Date.now(),
      type: 'mute',
    }
    messages.push(muteMessage)

    if (mode === 'flow' && isMuted) {
      handleFlowOnMute(agentId, lastChatMsg)
    }
  }

  // --- Flow management ---

  const cancelFlow = (): void => {
    const flowExecution = flowStore.getExecution()
    if (!flowExecution) return
    endFlow(flowExecution.flow.id, 'cancelled')
  }

  const startFlow = (flowId: string): void => {
    const flow = flowStore.getFlow(flowId)
    if (!flow || flow.steps.length === 0) return

    const flowExecution = flowStore.getExecution()
    if (flowExecution) {
      flowStore.notifyFlowEvent('cancelled', { flowId: flowExecution.flow.id })
    }

    paused = false
    const lastMsg = messages[messages.length - 1]
    if (!lastMsg || !deliver) return

    flowStore.setExecution({
      flow,
      triggerMessageId: lastMsg.id,
      stepIndex: 0,
    })
    mode = 'flow'
    notifyModeChanged()

    const eligible = computeEligible()

    // Find the first eligible step agent — the first step agent may already be muted/absent.
    // Create a synthetic execution at step -1 so advanceFlowStep searches from the beginning.
    const syntheticExec = { ...flowStore.getExecution()!, stepIndex: -1 }
    const firstResult = advanceFlowStep(syntheticExec, eligible)

    if (firstResult.completed) {
      // No eligible agents at all — cancel immediately
      endFlow(flow.id, 'completed')
      return
    }

    const startIndex = firstResult.nextStepIndex
    flowStore.advanceStep(startIndex)

    const startStep = flow.steps[startIndex]!
    const flowContext: FlowDeliveryContext = {
      flowName: flow.name,
      stepIndex: startIndex,
      totalSteps: flow.steps.length,
      loop: flow.loop,
      steps: flow.steps.map(s => ({ agentName: s.agentName })),
    }
    const enriched = {
      ...lastMsg,
      metadata: {
        ...lastMsg.metadata,
        ...(startStep.stepPrompt ? { stepPrompt: startStep.stepPrompt } : {}),
        flowContext,
      },
    }
    deliverToOne(startStep.agentId, enriched)
    flowStore.notifyFlowEvent('started', { flowId: flow.id, agentName: startStep.agentName })
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

    get deliveryMode() { return mode },
    setDeliveryMode,

    get paused() { return paused },
    setPaused: (p: boolean): void => { paused = p },

    getRoomState: (): RoomState => {
      const exec = flowStore.getExecution()
      return {
        mode,
        paused,
        muted: [...muted],
        members: [...members],
        ...(exec ? { flowExecution: { flowId: exec.flow.id, stepIndex: exec.stepIndex } } : {}),
      }
    },

    setMuted,
    isMuted: (agentId: string): boolean => muted.has(agentId),
    getMutedIds: (): ReadonlySet<string> => new Set(muted),

    addFlow: (config: Omit<Flow, 'id'>) => flowStore.addFlow(config),
    removeFlow: (flowId: string): boolean => flowStore.removeFlow(flowId, cancelFlow),
    getFlows: (): ReadonlyArray<Flow> => flowStore.getFlows(),
    startFlow,
    cancelFlow,
    get flowExecution() { return flowStore.getExecution() },

    addTodo: todoStore.addTodo,
    updateTodo: todoStore.updateTodo,
    removeTodo: todoStore.removeTodo,
    getTodos: todoStore.getTodos,

    injectMessages: (msgs: ReadonlyArray<Message>): void => {
      for (const msg of msgs) {
        messages.push(msg)
      }
    },

    getCompressedIds: (): ReadonlySet<string> => new Set(compressedIds),

    restoreState: (state: RoomRestoreParams): void => {
      members.clear()
      for (const id of state.members) members.add(id)
      muted.clear()
      for (const id of state.muted) muted.add(id)
      mode = state.mode
      paused = state.paused
      flowStore.restoreFlows(state.flows)
      todoStore.restoreTodos(state.todos)
      compressedIds.clear()
      if (state.compressedIds) {
        for (const id of state.compressedIds) compressedIds.add(id)
      }
    },
  }
}
