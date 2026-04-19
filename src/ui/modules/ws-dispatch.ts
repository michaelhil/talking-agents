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
  $agentWarnings,
  $messageContexts,
  $messageWarnings,
  $ollamaHealth,
  $ollamaMetrics,
  $lastProviderEvent,
  $pendingModelChanges,
  $roomIdByName,
  $agentIdByName,
  type AgentEntry,
} from './stores.ts'
import type { UIMessage, RoomProfile, ArtifactInfo } from './render-types.ts'
import type { WSOutbound } from '../../core/types/ws-protocol.ts'
import type { Message, AgentProfile, RoomProfile as ServerRoomProfile } from '../../core/types/messaging.ts'
import type { Artifact } from '../../core/types/artifact.ts'
import { showToast } from './ui-utils.ts'

// === Mappers from server wire types → UI types ===

const toUIMessage = (m: Message): UIMessage => {
  const meta = (m.metadata ?? {}) as Record<string, unknown>
  return {
    id: m.id,
    senderId: m.senderId,
    content: m.content,
    timestamp: m.timestamp,
    type: m.type,
    roomId: m.roomId,
    generationMs: m.generationMs,
    ...(typeof meta.promptTokens === 'number' ? { promptTokens: meta.promptTokens } : {}),
    ...(typeof meta.completionTokens === 'number' ? { completionTokens: meta.completionTokens } : {}),
    ...(typeof meta.contextMax === 'number' ? { contextMax: meta.contextMax } : {}),
    ...(typeof meta.provider === 'string' ? { provider: meta.provider } : {}),
    ...(typeof meta.model === 'string' ? { model: meta.model } : {}),
  }
}

const toUIRoomProfile = (r: ServerRoomProfile): RoomProfile => ({
  id: r.id,
  name: r.name,
})

const toAgentEntry = (a: AgentProfile): AgentEntry => ({
  id: a.id,
  name: a.name,
  kind: a.kind,
  model: a.model,
  state: 'idle',
})

const toUIArtifact = (a: Artifact): ArtifactInfo => ({
  id: a.id,
  type: a.type,
  title: a.title,
  description: a.description,
  body: a.body,
  scope: a.scope,
  createdBy: a.createdBy,
  createdAt: a.createdAt,
  updatedAt: a.updatedAt,
  resolution: a.resolution,
  resolvedAt: a.resolvedAt,
})

// === Dedup for provider_bound toasts ===
// Keyed by `${agentId}::${newProvider}`. Same pair within 5s → suppress.
const BOUND_DEDUP_MS = 5000
const lastBoundAt = new Map<string, number>()
const shouldEmitBound = (agentId: string | null, newProvider: string, now: number): boolean => {
  const key = `${agentId ?? '__system__'}::${newProvider}`
  const prev = lastBoundAt.get(key)
  if (prev !== undefined && now - prev < BOUND_DEDUP_MS) return false
  lastBoundAt.set(key, now)
  return true
}

// === Typed dispatch map ===

type OutboundByType<K extends WSOutbound['type']> = Extract<WSOutbound, { readonly type: K }>

type Handlers = {
  readonly [K in WSOutbound['type']]?: (msg: OutboundByType<K>) => void
}

const handlers: Handlers = {

  // --- Snapshot (full state sync) ---

  snapshot(msg) {
    if (msg.sessionToken) {
      $sessionToken.set(msg.sessionToken)
      localStorage.setItem('ta_session', msg.sessionToken)
    }
    $myAgentId.set(msg.agentId)

    // Populate rooms
    const roomMap: Record<string, RoomProfile> = {}
    for (const r of msg.rooms) roomMap[r.id] = toUIRoomProfile(r)
    $rooms.set(roomMap)

    // Populate agents
    const agentMap: Record<string, AgentEntry> = {}
    for (const a of msg.agents) agentMap[a.id] = toAgentEntry(a)
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
    $artifacts.set({})
    $thinkingPreviews.set({})
    $thinkingTools.set({})
    $agentContexts.set({})
    $agentWarnings.set({})
    $messageContexts.set({})
    $messageWarnings.set({})
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

      const muted = new Set<string>()
      for (const id of rs.muted) muted.add(id)
      $mutedAgents.set(muted)
    }
  },

  // --- Messages ---

  message(msg) {
    const m = toUIMessage(msg.message)
    const roomId = m.roomId ?? ''
    const current = $roomMessages.get()[roomId] ?? []

    if (current.some(existing => existing.id === m.id)) return

    const updated = [...current, m]
    $roomMessages.setKey(roomId, updated.length > 200 ? updated.slice(-200) : updated)

    if (roomId !== $selectedRoomId.get()) {
      const counts = $unreadCounts.get()
      $unreadCounts.setKey(roomId, (counts[roomId] ?? 0) + 1)
    }

    if (m.type === 'chat' || m.type === 'pass') {
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
      const all = { ...$roomMessages.get() }
      delete all[roomId]
      $roomMessages.set(all)
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
    })

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
      const warns = { ...$agentWarnings.get() }
      delete warns[id]
      $agentWarnings.set(warns)
    }
  },

  agent_activity(msg) {
    const id = $agentIdByName.get()[msg.agentName]
    if (!id) return

    const event = msg.event
    if (event.kind === 'thinking' && event.delta) {
      const prev = $thinkingPreviews.get()[id] ?? ''
      $thinkingPreviews.setKey(id, prev + event.delta)
      $thinkingTools.setKey(id, '__thinking__')
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

  // --- Turn / flow ---

  turn_changed(msg) {
    $turnInfo.set({ roomName: msg.roomName, agentName: msg.agentName, waitingForHuman: msg.waitingForHuman })
  },

  flow_event(msg) {
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

  artifact_changed(msg) {
    if (msg.action === 'removed') {
      const artifacts = { ...$artifacts.get() }
      delete artifacts[msg.artifact.id]
      $artifacts.set(artifacts)
    } else {
      $artifacts.setKey(msg.artifact.id, toUIArtifact(msg.artifact))
    }
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

  // --- Ollama ---

  ollama_health(msg) {
    $ollamaHealth.set(msg.health)
  },

  ollama_metrics(msg) {
    $ollamaMetrics.set(msg.metrics)
  },

  // --- Provider routing ---

  provider_bound(msg) {
    const now = Date.now()
    $lastProviderEvent.set({ ...msg, at: now })

    // Pending user-initiated model change: if this agent has one and the
    // model matches, clear it (verified successfully).
    if (msg.agentId) {
      const pending = $pendingModelChanges.get()[msg.agentId]
      if (pending && pending.model === msg.model) {
        const { [msg.agentId]: _removed, ...rest } = $pendingModelChanges.get()
        $pendingModelChanges.set(rest)
      }
    }

    // Suppress first-ever bindings (oldProvider === null) unless the agent
    // has a pending change — the initial bind is noise; the verified change
    // is the meaningful signal.
    const isPendingVerification = msg.agentId
      ? $pendingModelChanges.get()[msg.agentId] !== undefined
      : false
    if (msg.oldProvider === null && !isPendingVerification) return

    // Dedup: same (agentId, newProvider) within 5s only fires once.
    if (!shouldEmitBound(msg.agentId, msg.newProvider, now)) return

    const who = msg.agentName ? `${msg.agentName}: ` : ''
    const label = `${msg.newProvider}:${msg.model}`
    showToast(document.body, `${who}now using ${label}`, { type: 'success', position: 'fixed' })
  },

  provider_all_failed(msg) {
    const now = Date.now()
    $lastProviderEvent.set({ ...msg, at: now })
    if (msg.agentId) {
      const pending = $pendingModelChanges.get()[msg.agentId]
      if (pending && pending.model === msg.model) {
        const { [msg.agentId]: _removed, ...rest } = $pendingModelChanges.get()
        $pendingModelChanges.set(rest)
      }
    }
    const who = msg.agentName ? `${msg.agentName}: ` : ''
    const providers = msg.attempts.map(a => a.provider).join(', ') || 'no eligible providers'
    showToast(document.body, `${who}all providers failed for ${msg.model} (${providers})`, { type: 'error', position: 'fixed' })
  },

  provider_stream_failed(msg) {
    const now = Date.now()
    $lastProviderEvent.set({ ...msg, at: now })
    const who = msg.agentName ? `${msg.agentName}: ` : ''
    showToast(document.body, `${who}stream interrupted on ${msg.provider} (response may be partial)`, { type: 'error', position: 'fixed' })
  },

  // --- Errors ---

  error(msg) {
    console.error('Server error:', msg.message)
  },
}

export const wsDispatch = handlers as Record<string, (msg: WSOutbound) => void>
