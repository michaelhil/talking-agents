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
//   4. Apply mode filter (broadcast / manual)
//
// User muting and mode filtering are independent concerns applied in sequence.
// System code NEVER modifies the muted set — only explicit setMuted() calls do.
//
// [[AgentName]] addressing overrides in all modes (except manual for user messages,
// where AI peers wake only on explicit activation).
// Pause flag stops all delivery (join/leave and addressing still work).
//
// Scripts (see core/script-engine.ts) drive their own turn loop and post via
// room.post() like any other sender; they don't extend this module.
// ============================================================================

import type {
  DeliverFn, DeliveryMode, Message, PostParams,
  ResolveAgentName, ResolveTagFn, RoomProfile,
} from '../types/messaging.ts'
import type {
  OnDeliveryModeChanged, OnMessagePosted, OnSummaryConfigChanged,
  OnSummaryUpdated, OnTurnChanged, Room, RoomRestoreParams, RoomState,
} from '../types/room.ts'
import type { SummaryConfig } from '../types/summary.ts'
import { DEFAULT_SUMMARY_CONFIG } from '../types/summary.ts'
import { SYSTEM_SENDER_ID } from '../types/constants.ts'
import { parseAddressedAgents } from './addressing.ts'
import { deliverBroadcast } from './delivery-modes.ts'

export interface RoomCallbacks {
  readonly deliver?: DeliverFn
  readonly resolveAgentName?: ResolveAgentName
  readonly resolveTag?: ResolveTagFn
  readonly resolveKind?: (id: string) => 'ai' | 'human' | undefined
  readonly onMessagePosted?: OnMessagePosted
  readonly onTurnChanged?: OnTurnChanged
  readonly onDeliveryModeChanged?: OnDeliveryModeChanged
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
  let summaryConfig: SummaryConfig = DEFAULT_SUMMARY_CONFIG
  let latestSummary: string | undefined
  let wikiBindings: ReadonlyArray<string> = []

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

  // --- Post helpers ---

  const createRoomMessage = (params: PostParams): Message => ({
    // Caller-supplied fields flow through untouched — every optional field
    // on Message (tokens, provider, stepPrompt, etc.) is preserved without
    // enumeration here.
    ...params,
    // Server-stamped fields override.
    id: crypto.randomUUID(),
    roomId: profile.id,
    timestamp: Date.now(),
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

    switch (mode) {
      case 'broadcast':
        deliverBroadcast(message, eligible, deliver)
        break

      case 'manual': {
        // Deliver only to humans and to the sender (if AI) so senders still
        // track their own reply in history. AI peers are skipped entirely —
        // they catch up at explicit activation time.
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

    const muteMessage: Message = {
      id: crypto.randomUUID(),
      roomId: profile.id,
      senderId: SYSTEM_SENDER_ID,
      content: isMuted ? `${displayName} has been muted` : `${displayName} has been unmuted`,
      timestamp: Date.now(),
      type: 'mute',
    }
    messages.push(muteMessage)
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
      // Wipe everything that's a function of message history. Without this,
      // a "clear" leaves stale tombstones + summary that misrepresent an
      // empty room.
      messages.length = 0
      compressedIds.clear()
      latestSummary = undefined
    },

    get deliveryMode() { return mode },
    setDeliveryMode,
    autoSwitchToManual,

    get paused() { return paused },
    setPaused: (p: boolean): void => { paused = p },

    getRoomState: (): RoomState => ({
      mode,
      paused,
      muted: [...muted],
      members: [...members],
      summaryConfig,
      ...(latestSummary ? { latestSummary } : {}),
      ...(wikiBindings.length > 0 ? { wikiBindings: [...wikiBindings] } : {}),
    }),

    getWikiBindings: (): ReadonlyArray<string> => wikiBindings,
    setWikiBindings: (ids: ReadonlyArray<string>): void => {
      // Dedup + preserve order.
      const seen = new Set<string>()
      const out: string[] = []
      for (const id of ids) { if (!seen.has(id)) { seen.add(id); out.push(id) } }
      wikiBindings = out
    },

    setMuted,
    isMuted: (agentId: string): boolean => muted.has(agentId),
    getMutedIds: (): ReadonlySet<string> => new Set(muted),

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
      if (state.summaryConfig) summaryConfig = state.summaryConfig
      if (state.latestSummary !== undefined) latestSummary = state.latestSummary
      if (state.wikiBindings) wikiBindings = [...state.wikiBindings]
    },
  }
}
