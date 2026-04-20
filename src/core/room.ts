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
//   4. If a macro is running, apply macro-step overlay
//   5. Otherwise apply mode filter (broadcast / manual)
//
// User muting and mode filtering are independent concerns applied in sequence.
// System code NEVER modifies the muted set — only explicit setMuted() calls do.
//
// [[AgentName]] addressing overrides in all modes (except manual for user messages,
// where AI peers wake only on explicit activation or macro step).
// Pause flag stops all delivery (join/leave and addressing still work).
//
// Macro blueprints are Artifacts (system-level). Room owns the in-flight run:
// callers resolve the artifact, construct a Macro object, and pass it to runMacro().
// A running macro does NOT change the room's delivery mode — it overlays step
// delivery on top of the current mode.
// ============================================================================

import type {
  DeliverFn, DeliveryMode, Message, PostParams,
  ResolveAgentName, ResolveTagFn, RoomProfile,
} from './types/messaging.ts'
import type { Macro } from './types/macro.ts'
import type {
  OnDeliveryModeChanged, OnMacroEvent, OnMessagePosted, OnSummaryConfigChanged,
  OnSummaryUpdated, OnTurnChanged, Room, RoomRestoreParams, RoomState,
} from './types/room.ts'
import type { SummaryConfig } from './types/summary.ts'
import { DEFAULT_SUMMARY_CONFIG } from './types/summary.ts'
import { SYSTEM_SENDER_ID } from './types/constants.ts'
import { parseAddressedAgents } from './addressing.ts'
import { advanceMacroStep, buildMacroStepContext, deliverBroadcast, deliverMacroStep } from './delivery-modes.ts'
import { createMacroRunState } from './macro-runs.ts'

export interface RoomCallbacks {
  readonly deliver?: DeliverFn
  readonly resolveAgentName?: ResolveAgentName
  readonly resolveTag?: ResolveTagFn
  readonly resolveKind?: (id: string) => 'ai' | 'human' | undefined
  readonly onMessagePosted?: OnMessagePosted
  readonly onTurnChanged?: OnTurnChanged
  readonly onDeliveryModeChanged?: OnDeliveryModeChanged
  readonly onMacroEvent?: OnMacroEvent
  readonly onManualModeEntered?: (roomId: string) => void
  readonly onModeAutoSwitched?: (roomId: string, toMode: DeliveryMode, reason: 'second-ai-joined') => void
  readonly onSummaryConfigChanged?: OnSummaryConfigChanged
  readonly onSummaryUpdated?: OnSummaryUpdated
}

export const createRoom = (
  initialProfile: RoomProfile,
  callbacks?: RoomCallbacks,
): Room => {
  let profile = initialProfile
  const messages: Message[] = []
  const compressedIds = new Set<string>()
  const members = new Set<string>()
  const muted = new Set<string>()

  const deliver = callbacks?.deliver
  const resolveAgentName = callbacks?.resolveAgentName
  const resolveTag = callbacks?.resolveTag
  const resolveKind = callbacks?.resolveKind

  // --- State ---
  let mode: DeliveryMode = 'broadcast'
  let paused = false
  let selectedMacroId: string | undefined
  let summaryConfig: SummaryConfig = DEFAULT_SUMMARY_CONFIG
  let latestSummary: string | undefined

  const macroRunState = createMacroRunState(profile.id, callbacks?.onMacroEvent)

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

  const endMacro = (macroId: string, event: 'completed' | 'cancelled'): void => {
    macroRunState.clearRun()
    macroRunState.notifyMacroEvent(event, { macroId })
  }

  // --- Post helpers ---

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

  const dispatchToAddressed = (message: Message, targets: ReturnType<typeof parseAddressedAgents>): boolean => {
    const ids = new Set<string>()
    for (const target of targets) {
      if (target.kind === 'name' && resolveAgentName) {
        const id = resolveAgentName(target.value)
        if (id && members.has(id) && !muted.has(id)) ids.add(id)
      } else if (target.kind === 'tag' && resolveTag) {
        for (const id of resolveTag(target.value)) {
          if (members.has(id) && !muted.has(id)) ids.add(id)
        }
      }
    }
    if (ids.size === 0) return false
    for (const id of ids) deliverToOne(id, message)
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

    const nonDeliverable = message.type === 'system' || message.type === 'mute' || message.type === 'room_summary'
    if (nonDeliverable || !deliver) return message

    const eligible = computeEligible()

    if (message.type === 'join' || message.type === 'leave') {
      deliverBroadcast(message, eligible, deliver)
      return message
    }

    // In manual mode, [[AgentName]] addressing is inert — only explicit
    // activation via system.activateAgentInRoom delivers to AI peers.
    if (mode !== 'manual') {
      const addressedNames = parseAddressedAgents(message.content)
      if (addressedNames.length > 0 && dispatchToAddressed(message, addressedNames)) {
        return message
      }
    }

    if (paused) return message

    // Macro overlay: when a run is active, step-agent responses advance the macro.
    // Non-step-agent messages still fall through to the room's base mode so humans
    // and sender continue to see their own traffic.
    const macroRun = macroRunState.getRun()
    if (macroRun) {
      const currentStep = macroRun.macro.steps[macroRun.stepIndex]
      const isStepAgentResponse = currentStep && params.senderId === currentStep.agentId
      if (isStepAgentResponse) {
        // In Broadcast, auto-advance on valid step-agent response.
        // In Manual, the step agent's response lands (delivered below as a normal
        // manual-mode message), but we do NOT advance — the user clicks Next.
        if (mode === 'broadcast') {
          const result = deliverMacroStep(message, macroRun, eligible, params.senderId, deliver)
          if (result.advanced) {
            if (result.completed) {
              endMacro(macroRun.macro.id, 'completed')
            } else {
              macroRunState.advanceStep(result.nextStepIndex)
              macroRunState.notifyMacroEvent('step', {
                macroId: macroRun.macro.id,
                stepIndex: result.nextStepIndex,
                agentName: result.nextAgentName ?? '',
              })
            }
          }
          return message
        }
        // Manual + macro: fall through to manual-mode delivery (humans + sender).
        // The next step waits for user-triggered advanceMacroStep().
      }
    }

    switch (mode) {
      case 'broadcast':
        deliverBroadcast(message, eligible, deliver)
        break

      case 'manual': {
        // Deliver only to humans and to the sender (if AI) so senders still
        // track their own reply in history. AI peers are skipped entirely —
        // they catch up at explicit activation time (or on a macro step).
        for (const id of eligible) {
          const kind = resolveKind?.(id)
          if (kind === 'human' || id === params.senderId) {
            deliverToOne(id, message)
          }
        }
        break
      }
    }

    return message
  }

  // --- Delivery mode controls ---

  const setDeliveryMode = (newMode: DeliveryMode): void => {
    const prevMode = mode
    mode = newMode
    notifyModeChanged()
    if (newMode === 'manual' && prevMode !== 'manual') {
      callbacks?.onManualModeEntered?.(profile.id)
    }
  }

  const autoSwitchToManual = (reason: 'second-ai-joined'): void => {
    if (mode === 'manual') return
    setDeliveryMode('manual')
    callbacks?.onModeAutoSwitched?.(profile.id, 'manual', reason)
  }

  // --- Muting ---

  const handleMacroOnMute = (agentId: string, lastChatMsg: Message | undefined): void => {
    const macroRun = macroRunState.getRun()
    if (!macroRun) return
    const currentStep = macroRun.macro.steps[macroRun.stepIndex]
    if (!currentStep || currentStep.agentId !== agentId) return

    const eligible = computeEligible()
    const result = advanceMacroStep(macroRun, eligible)
    if (result.completed) {
      endMacro(macroRun.macro.id, 'completed')
    } else if (result.nextAgentId && lastChatMsg) {
      macroRunState.advanceStep(result.nextStepIndex)
      const nextStep = macroRun.macro.steps[result.nextStepIndex]!
      const enriched = nextStep.stepPrompt
        ? { ...lastChatMsg, metadata: { ...lastChatMsg.metadata, stepPrompt: nextStep.stepPrompt } }
        : lastChatMsg
      deliverToOne(result.nextAgentId, enriched)
      macroRunState.notifyMacroEvent('step', {
        macroId: macroRun.macro.id,
        stepIndex: result.nextStepIndex,
        agentName: result.nextAgentName ?? '',
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

    if (isMuted) handleMacroOnMute(agentId, lastChatMsg)
  }

  // --- Macro lifecycle ---
  // Blueprint is an Artifact. Caller resolves artifact → constructs Macro → passes here.

  const stopMacro = (): void => {
    const macroRun = macroRunState.getRun()
    if (!macroRun) return
    endMacro(macroRun.macro.id, 'cancelled')
  }

  const runMacro = (macro: Macro): void => {
    if (!macro || macro.steps.length === 0) return

    const existingRun = macroRunState.getRun()
    if (existingRun) {
      macroRunState.notifyMacroEvent('cancelled', { macroId: existingRun.macro.id })
    }

    const lastMsg = messages[messages.length - 1]
    if (!lastMsg || !deliver) return

    macroRunState.setRun({
      macro,
      triggerMessageId: lastMsg.id,
      stepIndex: 0,
    })

    const eligible = computeEligible()

    const syntheticRun = { ...macroRunState.getRun()!, stepIndex: -1 }
    const firstResult = advanceMacroStep(syntheticRun, eligible)

    if (firstResult.completed) {
      endMacro(macro.id, 'completed')
      return
    }

    const startIndex = firstResult.nextStepIndex
    macroRunState.advanceStep(startIndex)

    const startStep = macro.steps[startIndex]!
    const macroContext = buildMacroStepContext(macro, startIndex)
    const enriched = {
      ...lastMsg,
      metadata: {
        ...lastMsg.metadata,
        ...(startStep.stepPrompt ? { stepPrompt: startStep.stepPrompt } : {}),
        macroContext,
      },
    }
    deliverToOne(startStep.agentId, enriched)
    macroRunState.notifyMacroEvent('started', { macroId: macro.id, agentName: startStep.agentName })
  }

  // User-triggered step advance (Manual mode or explicit UI request).
  // Delivers the most recent chat message to the next step agent.
  const stepMacroForward = (): boolean => {
    const macroRun = macroRunState.getRun()
    if (!macroRun || !deliver) return false

    const eligible = computeEligible()
    const result = advanceMacroStep(macroRun, eligible)

    if (result.completed) {
      endMacro(macroRun.macro.id, 'completed')
      return true
    }

    if (!result.nextAgentId) return false

    const lastChatMsg = [...messages].reverse().find(m => m.type === 'chat' || m.type === 'pass') ?? messages[messages.length - 1]
    if (!lastChatMsg) return false

    macroRunState.advanceStep(result.nextStepIndex)
    const nextStep = macroRun.macro.steps[result.nextStepIndex]!
    const macroContext = buildMacroStepContext(macroRun.macro, result.nextStepIndex)
    const enriched = {
      ...lastChatMsg,
      metadata: {
        ...lastChatMsg.metadata,
        ...(nextStep.stepPrompt ? { stepPrompt: nextStep.stepPrompt } : {}),
        macroContext,
      },
    }
    deliverToOne(result.nextAgentId, enriched)
    macroRunState.notifyMacroEvent('step', {
      macroId: macroRun.macro.id,
      stepIndex: result.nextStepIndex,
      agentName: result.nextAgentName ?? '',
    })
    return true
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
    deleteMessage: (messageId: string): boolean => {
      const idx = messages.findIndex(m => m.id === messageId)
      if (idx === -1) return false
      messages.splice(idx, 1)
      return true
    },
    clearMessages: (): void => {
      messages.length = 0
    },

    get deliveryMode() { return mode },
    setDeliveryMode,
    autoSwitchToManual,

    get paused() { return paused },
    setPaused: (p: boolean): void => { paused = p },

    getRoomState: (): RoomState => {
      const run = macroRunState.getRun()
      return {
        mode,
        paused,
        muted: [...muted],
        members: [...members],
        ...(run ? { activeMacroRun: { macroId: run.macro.id, stepIndex: run.stepIndex } } : {}),
        ...(selectedMacroId ? { selectedMacroId } : {}),
        summaryConfig,
        ...(latestSummary ? { latestSummary } : {}),
      }
    },

    setMuted,
    isMuted: (agentId: string): boolean => muted.has(agentId),
    getMutedIds: (): ReadonlySet<string> => new Set(muted),

    runMacro,
    stopMacro,
    get activeMacroRun() { return macroRunState.getRun() },
    advanceMacroStep: stepMacroForward,
    get selectedMacroId() { return selectedMacroId },
    setSelectedMacroId: (id: string | undefined): void => { selectedMacroId = id },

    injectMessages: (msgs: ReadonlyArray<Message>): void => {
      for (const msg of msgs) messages.push(msg)
    },

    getCompressedIds: (): ReadonlySet<string> => new Set(compressedIds),

    get summaryConfig() { return summaryConfig },
    setSummaryConfig: (cfg: SummaryConfig): void => {
      summaryConfig = cfg
      callbacks?.onSummaryConfigChanged?.(profile.id, cfg)
    },
    getLatestSummary: (): string | undefined => latestSummary,
    setLatestSummary: (text: string): void => {
      latestSummary = text
      callbacks?.onSummaryUpdated?.(profile.id, 'summary')
    },
    replaceCompression: (oldestIds: ReadonlyArray<string>, newText: string): Message => {
      // Remove previous room_summary (if present anywhere in the stream).
      const prevIdx = messages.findIndex(m => m.type === 'room_summary')
      if (prevIdx !== -1) messages.splice(prevIdx, 1)
      // Drop the compressed messages from the delivery stream; flag tombstones.
      const idSet = new Set(oldestIds)
      for (let i = messages.length - 1; i >= 0; i--) {
        if (idSet.has(messages[i]!.id)) messages.splice(i, 1)
      }
      for (const id of oldestIds) compressedIds.add(id)
      const summaryMessage: Message = {
        id: crypto.randomUUID(),
        roomId: profile.id,
        senderId: SYSTEM_SENDER_ID,
        senderName: 'System',
        content: newText,
        timestamp: Date.now(),
        type: 'room_summary',
      }
      messages.unshift(summaryMessage)
      callbacks?.onSummaryUpdated?.(profile.id, 'compression')
      return summaryMessage
    },
    getCurrentCompressionMessage: (): Message | undefined =>
      messages.find(m => m.type === 'room_summary'),

    restoreState: (state: RoomRestoreParams): void => {
      members.clear()
      for (const id of state.members) members.add(id)
      muted.clear()
      for (const id of state.muted) muted.add(id)
      mode = state.mode
      paused = state.paused
      compressedIds.clear()
      if (state.compressedIds) {
        for (const id of state.compressedIds) compressedIds.add(id)
      }
      selectedMacroId = state.selectedMacroId
      if (state.summaryConfig) summaryConfig = state.summaryConfig
      if (state.latestSummary !== undefined) latestSummary = state.latestSummary
    },
  }
}
