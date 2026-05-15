// State events: snapshot, messages, agent state, room/agent membership.
//
// Pure data layer — each handler reads the message and writes to stores.
// No DOM manipulation. DOM effects come from store subscriptions in
// app.ts and the render layer.

import {
  $myAgentId,
  $sessionToken,
  $rooms,
  $agents,
  $roomMessages,
  $unreadCounts,
  $selectedRoomId,
  $pausedRooms,
  $mutedAgents,
  $roomMembers,
  $currentDeliveryMode,
  $roomPaused,
  $turnInfo,
  $thinkingPreviews,
  $thinkingTools,
  $agentContexts,
  $agentWarnings,
  $messageContexts,
  $messageWarnings,
  $roomIdByName,
  $agentIdByName,
  $pendingToolCheckins,
  $liveThinking,
  $messageThinking,
} from '../../stores.ts'
import type { WSOutbound } from '../../../../core/types/ws-protocol.ts'
import { showToast } from '../../toast.ts'
import { toUIMessage, toUIRoomProfile, toAgentEntry } from '../mappers.ts'
import { fetchRoomMessages } from '../../room-fetchers.ts'

type OutboundByType<K extends WSOutbound['type']> = Extract<WSOutbound, { readonly type: K }>

type StateHandlers = {
  readonly [K in WSOutbound['type']]?: (msg: OutboundByType<K>) => void
}

export const stateHandlers: StateHandlers = {

  // --- Snapshot (full state sync) ---

  snapshot(msg) {
    if (msg.sessionToken) {
      $sessionToken.set(msg.sessionToken)
      localStorage.setItem('ta_session', msg.sessionToken)
    }
    // v15+: snapshot.agentId is now optional and unused. WS sessions are
    // pure viewers — there's no per-tab "my" agent. "Self" styling has
    // been dropped from the UI; the per-room selected human is the actor.
    if (msg.agentId) $myAgentId.set(msg.agentId)
    else $myAgentId.set(null)

    // Populate rooms (UI-shaped via toUIRoomProfile; type inferred)
    const roomMap = Object.fromEntries(msg.rooms.map(r => [r.id, toUIRoomProfile(r)]))
    $rooms.set(roomMap)

    // Populate agents (UI-shaped via toAgentEntry; type inferred)
    const agentMap = Object.fromEntries(msg.agents.map(a => [a.id, toAgentEntry(a)]))
    $agents.set(agentMap)

    // Room states: paused, members, muted
    const paused = new Set<string>()
    const membersMap: Record<string, string[]> = {}
    if (msg.roomStates) {
      for (const [roomId, rs] of Object.entries(msg.roomStates)) {
        if (rs.paused) paused.add(roomId)
        if (rs.members) membersMap[roomId] = [...rs.members]
      }
    }
    $pausedRooms.set(paused)
    $roomMembers.set(membersMap)

    // Clear transient state
    $unreadCounts.set({})
    $thinkingPreviews.set({})
    $thinkingTools.set({})
    $agentContexts.set({})
    $agentWarnings.set({})
    $messageContexts.set({})
    $messageWarnings.set({})
    $liveThinking.set({})
    $messageThinking.set({})
    $mutedAgents.set(new Set())
    $turnInfo.set(null)

    // Auto-select first room if none selected
    if (!$selectedRoomId.get() && msg.rooms.length > 0) {
      $selectedRoomId.set(msg.rooms[0]!.id)
    }

    // Apply selected room's mode/pause/mute state
    const selId = $selectedRoomId.get()
    if (selId && msg.roomStates?.[selId]) {
      const rs = msg.roomStates[selId]!
      $currentDeliveryMode.set(rs.mode)
      $roomPaused.set(rs.paused)

      const muted = new Set<string>()
      for (const id of rs.muted) muted.add(id)
      $mutedAgents.set(muted)
    }

    // Server is authoritative. Drop the stale per-room message cache so the
    // $roomMessages.listen() renderer at app.ts:433 receives a per-room
    // `changedKey` and diffs the old DOM against the new (empty) array,
    // removing phantom messages from a previous server instance. Bare
    // `$roomMessages.set({})` would empty the cache but not trigger the
    // listener (changedKey would be undefined) — same gotcha already
    // documented in the messages_cleared handler above.
    //
    // Then eagerly refetch the selected room so the user sees fresh state
    // without a manual room-switch. Other rooms refetch lazily on click via
    // the room-select listener in app.ts:371.
    //
    // Residual race: if a fetchRoomMessages from a prior room-switch is
    // still in flight, its eventual setKey could land after our clear and
    // write stale data. Accepted: rare, and the next snapshot re-clears.
    // TODO: $thinkingPreviews / $thinkingTools / $agentContexts /
    // $agentWarnings are cleared with bare set({}) above. If a future
    // consumer's listener relies on `changedKey` semantics, the same
    // listener-doesn't-fire trap will bite them. Convert to setKey
    // iteration the moment that surfaces; no preemptive fix.
    const previouslyCached = Object.keys($roomMessages.get())
    for (const roomId of previouslyCached) {
      $roomMessages.setKey(roomId, [])
    }
    const finalSelId = $selectedRoomId.get()
    const selRoom = finalSelId ? $rooms.get()[finalSelId] : null
    if (selRoom) void fetchRoomMessages(selRoom.id, selRoom.name)
  },

  // --- Messages ---

  message(msg) {
    const m = toUIMessage(msg.message)
    const roomId = m.roomId ?? ''
    const current = $roomMessages.get()[roomId] ?? []

    if (current.some(existing => existing.id === m.id)) return

    // Transfer thinking BEFORE the $roomMessages setKey — the listener
    // that runs renderMessage fires synchronously off the setKey, so
    // $messageThinking[m.id] must already exist by then for the bubble
    // to render the persisted reasoning. Warnings/contexts don't need
    // this because they're rendered through separate stores consulted
    // after-the-fact via the context modal, not in the initial render.
    if (m.type === 'chat') {
      const liveThink = $liveThinking.get()[m.senderId]
      if (liveThink && liveThink.length > 0) {
        $messageThinking.setKey(m.id, liveThink)
        const remainingT = { ...$liveThinking.get() }
        delete remainingT[m.senderId]
        $liveThinking.set(remainingT)
      }
    }

    const updated = [...current, m]
    $roomMessages.setKey(roomId, updated.length > 200 ? updated.slice(-200) : updated)

    if (roomId !== $selectedRoomId.get()) {
      const counts = $unreadCounts.get()
      $unreadCounts.setKey(roomId, (counts[roomId] ?? 0) + 1)
    }

    if (m.type === 'chat' || m.type === 'pass' || m.type === 'error') {
      const agents = $agents.get()
      const sender = agents[m.senderId]
      if (sender && sender.state === 'generating') {
        $agents.setKey(m.senderId, { ...sender, state: 'idle', context: undefined })
      }
      const agentCtx = $agentContexts.get()[m.senderId]
      if (agentCtx) {
        $messageContexts.setKey(m.id, agentCtx)
        const remaining = { ...$agentContexts.get() }
        delete remaining[m.senderId]
        $agentContexts.set(remaining)
      }
      const agentWarn = $agentWarnings.get()[m.senderId]
      if (agentWarn && agentWarn.length > 0) {
        $messageWarnings.setKey(m.id, agentWarn)
        const remainingW = { ...$agentWarnings.get() }
        delete remainingW[m.senderId]
        $agentWarnings.set(remainingW)
      }
    }
  },

  message_deleted(msg) {
    const roomId = $roomIdByName.get()[msg.roomName]
    if (!roomId) return
    const msgs = $roomMessages.get()[roomId]
    if (msgs) {
      $roomMessages.setKey(roomId, msgs.filter(m => m.id !== msg.messageId))
    }
  },

  messages_cleared(msg) {
    const roomId = $roomIdByName.get()[msg.roomName]
    if (roomId) {
      // Use setKey so the renderer's listener receives a `changedKey` and
      // diffs the empty array against the DOM. A bare set() leaves
      // changedKey undefined, which the renderer treats as "irrelevant
      // change" and skips DOM removal — leaving phantom messages on screen.
      $roomMessages.setKey(roomId, [])
    }
  },

  activation_result(msg) {
    if (!msg.ok) {
      showToast(document.body, `${msg.agentName}: ${msg.reason ?? 'activation failed'}`, { position: 'fixed' })
      return
    }
    if (msg.queued) {
      showToast(document.body, `${msg.agentName} busy — activation queued`, { position: 'fixed' })
    }
  },

  // --- Agent state ---

  agent_state(msg) {
    const id = $agentIdByName.get()[msg.agentName]
    if (!id) return
    const current = $agents.get()[id]
    if (!current) return
    $agents.setKey(id, {
      ...current,
      state: msg.state,
      context: msg.context,
      // Carry the server's generation start time when present. Drives the
      // computed $visibleThinkingIndicators and the indicator's elapsed
      // counter — survives tab reload via the snapshot path.
      ...(msg.generationStarted !== undefined ? { generationStarted: msg.generationStarted } : {}),
    })

    // Per-agent content stores ($thinkingPreviews / $thinkingTools /
    // $agentContexts / $agentWarnings) used to be cleared synchronously on
    // state→idle. That raced with the new MIN_VISIBLE_MS hold in the
    // renderer — preview text would vanish during the 400ms hold leaving
    // an empty box. Cleanup is now done by the renderer as part of its
    // clearThinkingIndicator path, AFTER the hold.
  },

  agent_activity(msg) {
    const id = $agentIdByName.get()[msg.agentName]
    if (!id) return

    const event = msg.event
    if (event.kind === 'thinking' && event.delta) {
      // Live display (cleared when chunks arrive — existing behavior).
      const prev = $thinkingPreviews.get()[id] ?? ''
      $thinkingPreviews.setKey(id, prev + event.delta)
      $thinkingTools.setKey(id, '__thinking__')
      // Dedicated accumulator that survives the chunk-overwrite and gets
      // transferred to $messageThinking when the message lands. This is
      // the persistence path the user sees on the message bubble.
      const liveSoFar = $liveThinking.get()[id] ?? ''
      $liveThinking.setKey(id, liveSoFar + event.delta)
    } else if (event.kind === 'chunk' && event.delta) {
      const tools = $thinkingTools.get()[id]
      if (tools === '__thinking__') {
        $thinkingPreviews.setKey(id, event.delta)
        $thinkingTools.setKey(id, '')
      } else {
        const prev = $thinkingPreviews.get()[id] ?? ''
        $thinkingPreviews.setKey(id, prev + event.delta)
      }
    } else if (event.kind === 'tool_start' && event.tool) {
      $thinkingTools.setKey(id, `${event.tool}...`)
    } else if (event.kind === 'tool_result' && event.tool) {
      $thinkingTools.setKey(id, `${event.tool} ${event.success ? '✓' : '✗'}`)
    } else if (event.kind === 'context_ready') {
      $agentContexts.setKey(id, {
        messages: event.messages,
        model: event.model,
        temperature: event.temperature,
        toolCount: event.toolCount,
      })
    } else if (event.kind === 'warning') {
      const existing = $agentWarnings.get()[id] ?? []
      $agentWarnings.setKey(id, [...existing, event.message])
    } else if (event.kind === 'tool_iteration_checkin') {
      $pendingToolCheckins.setKey(id, {
        iterations: event.iterations,
        roomId: event.roomId,
        recentTools: event.recentTools,
      })
    } else if (event.kind === 'model_fallback') {
      // Non-blocking notice that the agent's preferred model resolved to
      // a different effective model. Reason determines the copy:
      //   preferred_unavailable — runtime failover (e.g. Gemini Pro→Flash on
      //     503), fired by ai-agent.ts after a fallbackable upstream error
      //   preferred_blank — agent had no model set; cold-boot default kicked in
      const existing = $agentWarnings.get()[id] ?? []
      const note = event.reason === 'preferred_blank'
        ? `No model configured; using "${event.effective}"`
        : `Falling back from "${event.preferred}" to "${event.effective}" (preferred unavailable)`
      $agentWarnings.setKey(id, [...existing, note])
    }
  },

  // --- Rooms ---

  room_created(msg) {
    $rooms.setKey(msg.profile.id, toUIRoomProfile(msg.profile))
    if (!$selectedRoomId.get()) {
      $selectedRoomId.set(msg.profile.id)
    }
  },

  room_deleted(msg) {
    const roomId = $roomIdByName.get()[msg.roomName]
    if (!roomId) return

    const rooms = { ...$rooms.get() }
    delete rooms[roomId]
    $rooms.set(rooms)

    const members = { ...$roomMembers.get() }
    delete members[roomId]
    $roomMembers.set(members)

    const messages = { ...$roomMessages.get() }
    delete messages[roomId]
    $roomMessages.set(messages)

    if ($selectedRoomId.get() === roomId) {
      $selectedRoomId.set(null)
    }

    // Drop any active-demo pin for the deleted room so stale keys don't
    // accumulate. Async import to keep the dispatcher cycle-free.
    void import('../../demos/active-demo-store.ts').then(m => m.clearDemoForRoom(roomId))
  },

  // --- Agents ---

  agent_joined(msg) {
    $agents.setKey(msg.agent.id, toAgentEntry(msg.agent))
  },

  agent_removed(msg) {
    const id = $agentIdByName.get()[msg.agentName]
    if (!id) return
    const agents = { ...$agents.get() }
    delete agents[id]
    $agents.set(agents)
  },

  agent_renamed(msg) {
    const existing = $agents.get()[msg.id]
    if (!existing) return
    $agents.setKey(msg.id, { ...existing, name: msg.newName })
  },

  // --- Delivery mode ---

  delivery_mode_changed(msg) {
    const roomId = $roomIdByName.get()[msg.roomName]

    $currentDeliveryMode.set(msg.mode)
    $roomPaused.set(msg.paused)

    if (roomId) {
      const paused = new Set($pausedRooms.get())
      if (msg.paused) paused.add(roomId)
      else paused.delete(roomId)
      $pausedRooms.set(paused)
    }
  },

  // --- Mute ---

  mute_changed(msg) {
    const agentId = $agentIdByName.get()[msg.agentName]
    if (!agentId) return

    const muted = new Set($mutedAgents.get())
    if (msg.muted) muted.add(agentId)
    else muted.delete(agentId)
    $mutedAgents.set(muted)
  },

  // --- Turn ---

  turn_changed(msg) {
    $turnInfo.set({ roomName: msg.roomName, agentName: msg.agentName, waitingForHuman: msg.waitingForHuman })
  },

  mode_auto_switched(msg) {
    showToast(
      document.body,
      `Two AI agents in "${msg.roomName}" — switched to Manual. Click 📣 to go back to Broadcast.`,
      { position: 'fixed', durationMs: 7000 },
    )
  },

  // --- Membership ---

  membership_changed(msg) {
    const members = $roomMembers.get()[msg.roomId] ?? []
    if (msg.action === 'added') {
      if (!members.includes(msg.agentId)) {
        $roomMembers.setKey(msg.roomId, [...members, msg.agentId])
      }
    } else {
      $roomMembers.setKey(msg.roomId, members.filter(id => id !== msg.agentId))
    }
  },
}
