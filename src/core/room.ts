// ============================================================================
// Room — Self-contained component: messages + members + delivery.
// post() appends the message, delivers to members, and returns it.
// Room stamps its own roomId on messages — caller never passes roomId.
// Delivery includes message history (all messages before the new one) so
// recipients can distinguish old context from fresh arrivals.
//
// Members are tracked via addMember/removeMember/hasMember for access control.
// post() implicitly adds the sender as a member.
// Messages are capped at maxMessages to prevent unbounded growth.
//
// Turn-taking (TT) mode: when enabled, the room delivers messages to one agent
// at a time based on staleness — who hasn't spoken the longest. The TT chain
// is self-perpetuating: each agent's response triggers delivery to the next.
//
// Directed addressing: [[AgentName]] in message content overrides normal
// delivery (both broadcast and TT). Only addressed agents receive delivery.
// Works in both TT and non-TT mode.
// ============================================================================

import type { DeliverFn, Message, OnTurnChanged, PostParams, Room, RoomProfile, TurnTakingState } from './types.ts'
import { DEFAULTS, SYSTEM_SENDER_ID } from './types.ts'
import { parseAddressedAgents } from './addressing.ts'
import { findStalestAgent } from './staleness.ts'

export const createRoom = (
  initialProfile: RoomProfile,
  deliver?: DeliverFn,
  onTurnChanged?: OnTurnChanged,
  maxMessages?: number,
): Room => {
  let profile = initialProfile
  const messages: Message[] = []
  const members = new Set<string>()
  const messageLimit = maxMessages ?? DEFAULTS.roomMessageLimit

  // --- Turn-taking state ---
  let ttEnabled = false
  let ttPaused = false
  const ttParticipating = new Set<string>()
  let ttCurrentTurn: string | undefined

  // --- Name resolution from message history ---

  const resolveNameToId = (name: string): string | undefined => {
    const lower = name.toLowerCase()
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.senderName?.toLowerCase() === lower) return messages[i]!.senderId
    }
    return undefined
  }

  // --- Delivery helpers ---

  const deliverTo = (agentId: string, message: Message): void => {
    if (!deliver) return
    const history = messages.slice(0, -1)
    deliver(agentId, message, history)
  }

  const broadcastToMembers = (message: Message): void => {
    if (!deliver) return
    const history = messages.slice(0, -1)
    for (const id of members) {
      deliver(id, message, history)
    }
  }

  const advanceTurn = (message: Message, excludeSender?: string): void => {
    const next = findStalestAgent(messages, ttParticipating, excludeSender)
    ttCurrentTurn = next

    if (!next) {
      onTurnChanged?.(profile.id, undefined)
      return
    }

    // Check if next agent is a human participant — we can't know agent kind
    // from room alone, so we just deliver and let the system handle it.
    // The onTurnChanged callback lets the server notify the UI.
    onTurnChanged?.(profile.id, next)
    deliverTo(next, message)
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

    // 1. Check for directed addressing [[AgentName]]
    const addressedNames = parseAddressedAgents(message.content)
    if (addressedNames.length > 0) {
      const addressedIds = addressedNames
        .map(resolveNameToId)
        .filter((id): id is string => id !== undefined && members.has(id))

      if (addressedIds.length > 0) {
        for (const id of addressedIds) {
          deliverTo(id, message)
        }
        // In TT mode, set the first addressed agent as currentTurn
        // so the chain can resume after they respond
        if (ttEnabled && !ttPaused) {
          ttCurrentTurn = addressedIds[0]
          onTurnChanged?.(profile.id, ttCurrentTurn)
        }
        return message
      }
      // If no addressed agents resolved, fall through to normal delivery
    }

    // 2. Turn-taking mode
    if (ttEnabled && !ttPaused && deliver) {
      if (params.senderId === ttCurrentTurn) {
        // Current turn holder responded — advance to next stalest
        advanceTurn(message, params.senderId)
      } else if (!ttCurrentTurn) {
        // Chain is idle — kickstart from stalest
        advanceTurn(message)
      }
      // Else: someone posted while another agent has the floor.
      // Message is stored but not delivered yet — the current turn
      // holder will see it in history when the chain reaches them.
      return message
    }

    // 3. Normal broadcast (TT disabled, no addressing)
    broadcastToMembers(message)

    return message
  }

  // --- Turn-taking controls ---

  const setTurnTaking = (enabled: boolean): void => {
    ttEnabled = enabled
    if (!enabled) {
      ttCurrentTurn = undefined
      ttPaused = false
    } else if (!ttPaused && messages.length > 0) {
      // Kick off the chain from the stalest agent
      const stalest = findStalestAgent(messages, ttParticipating)
      if (stalest) {
        ttCurrentTurn = stalest
        onTurnChanged?.(profile.id, stalest)
        // Deliver the most recent message to kick things off
        const lastMsg = messages[messages.length - 1]!
        deliverTo(stalest, lastMsg)
      }
    }
  }

  const setTurnTakingPaused = (paused: boolean): void => {
    ttPaused = paused
    if (!paused && ttEnabled) {
      // Resume — advance from stalest
      const stalest = findStalestAgent(messages, ttParticipating)
      if (stalest) {
        ttCurrentTurn = stalest
        onTurnChanged?.(profile.id, stalest)
        const lastMsg = messages[messages.length - 1]
        if (lastMsg) deliverTo(stalest, lastMsg)
      }
    } else {
      ttCurrentTurn = undefined
      onTurnChanged?.(profile.id, undefined)
    }
  }

  const setParticipating = (agentId: string, participating: boolean): void => {
    if (participating) {
      ttParticipating.add(agentId)
    } else {
      ttParticipating.delete(agentId)
      if (ttCurrentTurn === agentId) {
        // Current turn holder removed from rotation — advance
        ttCurrentTurn = undefined
        if (ttEnabled && !ttPaused && messages.length > 0) {
          const stalest = findStalestAgent(messages, ttParticipating)
          if (stalest) {
            ttCurrentTurn = stalest
            onTurnChanged?.(profile.id, stalest)
            const lastMsg = messages[messages.length - 1]!
            deliverTo(stalest, lastMsg)
          }
        }
      }
    }
  }

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
    get turnTaking(): TurnTakingState {
      return {
        enabled: ttEnabled,
        paused: ttPaused,
        participating: new Set(ttParticipating),
        currentTurn: ttCurrentTurn,
      }
    },
    setTurnTaking,
    setTurnTakingPaused,
    setParticipating,
  }
}
