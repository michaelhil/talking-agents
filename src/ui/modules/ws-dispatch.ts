// ============================================================================
// WS Dispatch — maps incoming WebSocket events to store mutations.
//
// Pure data layer: each handler reads the message and writes to stores.
// No DOM manipulation, no rendering, no side effects beyond store writes.
// DOM effects are handled by store subscriptions wired in app.ts.
// ============================================================================

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
  $flowStatus,
  $artifacts,
  $thinkingPreviews,
  $thinkingTools,
  $agentContexts,
  $messageContexts,
  $ollamaHealth,
  $ollamaMetrics,
  $connected,
  $roomIdByName,
  $agentIdByName,
  type AgentEntry,
  type StateValue,
} from './stores.ts'
import type { UIMessage, RoomProfile, AgentInfo, ArtifactInfo } from './ui-renderer.ts'

// === Snapshot sub-types ===

interface RoomState {
  readonly mode: string
  readonly paused: boolean
  readonly muted: string[]
  readonly members?: string[]
}

interface SnapshotMsg {
  readonly type: 'snapshot'
  readonly rooms: RoomProfile[]
  readonly agents: AgentInfo[]
  readonly agentId: string
  readonly sessionToken?: string
  readonly roomStates?: Record<string, RoomState>
}

// === Helpers ===

/** Convert AgentInfo from server to our AgentEntry (with typed state). */
const toAgentEntry = (a: AgentInfo): AgentEntry => ({
  id: a.id,
  name: a.name,
  kind: a.kind as 'ai' | 'human',
  model: a.model,
  state: (a.state === 'generating' ? 'generating' : 'idle') as StateValue,
  context: a.context,
})

// === Dispatch table ===

/* eslint-disable @typescript-eslint/no-explicit-any */
export const wsDispatch: Record<string, (msg: any) => void> = {

  // --- Snapshot (full state sync) ---

  snapshot(msg: SnapshotMsg): void {
    if (msg.sessionToken) {
      $sessionToken.set(msg.sessionToken)
      localStorage.setItem('ta_session', msg.sessionToken)
    }
    $myAgentId.set(msg.agentId)

    // Populate rooms
    const roomMap: Record<string, RoomProfile> = {}
    for (const r of msg.rooms) roomMap[r.id] = r
    $rooms.set(roomMap)

    // Populate agents (with state from snapshot)
    const agentMap: Record<string, AgentEntry> = {}
    for (const a of msg.agents) {
      agentMap[a.id] = toAgentEntry(a)
    }
    $agents.set(agentMap)

    // Room states: paused, members, muted
    const paused = new Set<string>()
    const membersMap: Record<string, string[]> = {}
    if (msg.roomStates) {
      for (const [roomId, rs] of Object.entries(msg.roomStates)) {
        if (rs.paused) paused.add(roomId)
        if (rs.members) membersMap[roomId] = rs.members
      }
    }
    $pausedRooms.set(paused)
    $roomMembers.set(membersMap)

    // Clear transient state
    $unreadCounts.set({})
    $artifacts.set({})
    $thinkingPreviews.set({})
    $thinkingTools.set({})
    $agentContexts.set({})
    $messageContexts.set({})
    $mutedAgents.set(new Set())
    $turnInfo.set(null)
    $flowStatus.set(null)

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

      // Muted agents: snapshot stores agent IDs in muted array
      const muted = new Set<string>()
      for (const id of rs.muted) muted.add(id)
      $mutedAgents.set(muted)
    }
  },

  // --- Messages ---

  message(msg: { message: UIMessage }): void {
    const m = msg.message
    const roomId = m.roomId ?? ''
    const current = $roomMessages.get()[roomId] ?? []

    // Deduplicate
    if (current.some(existing => existing.id === m.id)) return

    // Cap messages per room to prevent unbounded memory growth
    const updated = [...current, m]
    $roomMessages.setKey(roomId, updated.length > 200 ? updated.slice(-200) : updated)

    // Increment unread if not the selected room
    if (roomId !== $selectedRoomId.get()) {
      const counts = $unreadCounts.get()
      $unreadCounts.setKey(roomId, (counts[roomId] ?? 0) + 1)
    }

    // Clear thinking state for sender (their message arrived)
    if (m.type === 'chat') {
      const agents = $agents.get()
      const sender = agents[m.senderId]
      if (sender && sender.state === 'generating') {
        $agents.setKey(m.senderId, { ...sender, state: 'idle' as StateValue, context: undefined })
      }
      // Transfer prompt context from agent → message for post-generation inspection
      const agentCtx = $agentContexts.get()[m.senderId]
      if (agentCtx) {
        $messageContexts.setKey(m.id, agentCtx)
        const remaining = { ...$agentContexts.get() }
        delete remaining[m.senderId]
        $agentContexts.set(remaining)
      }
    }
  },

  message_deleted(msg: { roomName: string; messageId: string }): void {
    const roomId = $roomIdByName.get()[msg.roomName]
    if (!roomId) return
    const msgs = $roomMessages.get()[roomId]
    if (msgs) {
      $roomMessages.setKey(roomId, msgs.filter(m => m.id !== msg.messageId))
    }
  },

  messages_cleared(msg: { roomName: string }): void {
    const roomId = $roomIdByName.get()[msg.roomName]
    if (roomId) {
      // Remove key entirely
      const all = { ...$roomMessages.get() }
      delete all[roomId]
      $roomMessages.set(all)
    }
  },

  // --- Agent state ---

  agent_state(msg: { agentName: string; state: string; context?: string }): void {
    const id = $agentIdByName.get()[msg.agentName]
    if (!id) return
    const current = $agents.get()[id]
    if (!current) return
    $agents.setKey(id, {
      ...current,
      state: (msg.state === 'generating' ? 'generating' : 'idle') as StateValue,
      context: msg.context,
    })

    // Clear thinking state when agent goes idle
    if (msg.state !== 'generating') {
      const previews = { ...$thinkingPreviews.get() }
      delete previews[id]
      $thinkingPreviews.set(previews)
      const tools = { ...$thinkingTools.get() }
      delete tools[id]
      $thinkingTools.set(tools)
      const ctxs = { ...$agentContexts.get() }
      delete ctxs[id]
      $agentContexts.set(ctxs)
    }
  },

  agent_activity(msg: { agentName: string; event: Record<string, unknown> }): void {
    const id = $agentIdByName.get()[msg.agentName]
    if (!id) return

    const event = msg.event
    if (event.kind === 'chunk' && event.delta) {
      const prev = $thinkingPreviews.get()[id] ?? ''
      $thinkingPreviews.setKey(id, prev + (event.delta as string))
    } else if (event.kind === 'tool_start' && event.tool) {
      $thinkingTools.setKey(id, `${event.tool}...`)
    } else if (event.kind === 'tool_result' && event.tool) {
      $thinkingTools.setKey(id, `${event.tool} ${event.success ? '✓' : '✗'}`)
    } else if (event.kind === 'context_ready') {
      $agentContexts.setKey(id, {
        messages: event.messages as ReadonlyArray<{ role: string; content: string }>,
        model: event.model as string,
        temperature: event.temperature as number | undefined,
        toolCount: event.toolCount as number,
      })
    }
  },

  // --- Rooms ---

  room_created(msg: { profile: RoomProfile }): void {
    $rooms.setKey(msg.profile.id, msg.profile)
    // Auto-select if no room selected
    if (!$selectedRoomId.get()) {
      $selectedRoomId.set(msg.profile.id)
    }
  },

  room_deleted(msg: { roomName: string }): void {
    const roomId = $roomIdByName.get()[msg.roomName]
    if (!roomId) return

    // Remove from all stores
    const rooms = { ...$rooms.get() }
    delete rooms[roomId]
    $rooms.set(rooms)

    const members = { ...$roomMembers.get() }
    delete members[roomId]
    $roomMembers.set(members)

    const messages = { ...$roomMessages.get() }
    delete messages[roomId]
    $roomMessages.set(messages)

    // Deselect if this was the selected room
    if ($selectedRoomId.get() === roomId) {
      $selectedRoomId.set(null)
    }
  },

  // --- Agents ---

  agent_joined(msg: { agent: AgentInfo }): void {
    $agents.setKey(msg.agent.id, toAgentEntry(msg.agent))
  },

  agent_removed(msg: { agentName: string }): void {
    const id = $agentIdByName.get()[msg.agentName]
    if (!id) return
    const agents = { ...$agents.get() }
    delete agents[id]
    $agents.set(agents)
  },

  // --- Delivery mode ---

  delivery_mode_changed(msg: { roomName: string; mode: string; paused: boolean }): void {
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

  mute_changed(msg: { roomName: string; agentName: string; muted: boolean }): void {
    // Convert agentName to agentId for consistent ID-based storage
    const agentId = $agentIdByName.get()[msg.agentName]
    if (!agentId) return

    const muted = new Set($mutedAgents.get())
    if (msg.muted) muted.add(agentId)
    else muted.delete(agentId)
    $mutedAgents.set(muted)
  },

  // --- Turn / flow ---

  turn_changed(msg: { roomName: string; agentName?: string; waitingForHuman?: boolean }): void {
    $turnInfo.set({ roomName: msg.roomName, agentName: msg.agentName, waitingForHuman: msg.waitingForHuman })
  },

  flow_event(msg: { roomName: string; event: string; detail?: Record<string, unknown> }): void {
    $flowStatus.set({ roomName: msg.roomName, event: msg.event, detail: msg.detail })

    if (msg.event === 'completed' || msg.event === 'cancelled') {
      $currentDeliveryMode.set('broadcast')
      $roomPaused.set(true)
      const selId = $selectedRoomId.get()
      if (selId) {
        const paused = new Set($pausedRooms.get())
        paused.add(selId)
        $pausedRooms.set(paused)
      }
    }
  },

  // --- Artifacts ---

  artifact_changed(msg: { action: 'added' | 'updated' | 'removed'; artifact: ArtifactInfo }): void {
    if (msg.action === 'removed') {
      const artifacts = { ...$artifacts.get() }
      delete artifacts[msg.artifact.id]
      $artifacts.set(artifacts)
    } else {
      $artifacts.setKey(msg.artifact.id, msg.artifact)
    }
  },

  // --- Membership ---

  membership_changed(msg: { roomId: string; agentId: string; action: 'added' | 'removed' }): void {
    const members = $roomMembers.get()[msg.roomId] ?? []
    if (msg.action === 'added') {
      if (!members.includes(msg.agentId)) {
        $roomMembers.setKey(msg.roomId, [...members, msg.agentId])
      }
    } else {
      $roomMembers.setKey(msg.roomId, members.filter(id => id !== msg.agentId))
    }
  },

  // --- Ollama ---

  ollama_health(msg: Record<string, unknown>): void {
    $ollamaHealth.set((msg as { health: Record<string, unknown> }).health)
  },

  ollama_metrics(msg: Record<string, unknown>): void {
    $ollamaMetrics.set((msg as { metrics: Record<string, unknown> }).metrics)
  },

  // --- Errors ---

  error(msg: { message: string }): void {
    console.error('Server error:', msg.message)
  },

  // --- Metrics subscriptions (no-op on client, handled by WS client) ---

  subscribe_ollama_metrics(): void { /* handled by send() */ },
  unsubscribe_ollama_metrics(): void { /* handled by send() */ },
}
