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
  $macroStatus,
  $selectedMacroIdByRoom,
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
} from '../stores.ts'
import type { WSOutbound } from '../../../core/types/ws-protocol.ts'
import { showToast, roomNameToId } from '../ui-utils.ts'
import {
  handleSummaryRunStarted,
  handleSummaryRunDelta,
  handleSummaryRunCompleted,
  handleSummaryRunFailed,
} from '../summary-panel.ts'
import { toUIMessage, toUIRoomProfile, toAgentEntry, toUIArtifact } from './mappers.ts'
import { shouldEmitBound } from './dedup.ts'

// --- Pending create hooks ---
// Callers (e.g. the Macro create flow) register a hook keyed by requestId
// before sending add_artifact. When the matching artifact_created arrives,
// the hook fires and is removed. Single-fire; lives only in memory.
export type PendingCreateHook = (artifactId: string, artifactType: string) => void
export const pendingCreateHooks = new Map<string, PendingCreateHook>()

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

    // Room states: paused, members, muted, selectedMacroId
    const paused = new Set<string>()
    const membersMap: Record<string, string[]> = {}
    const selectionMap: Record<string, string | null> = {}
    if (msg.roomStates) {
      for (const [roomId, rs] of Object.entries(msg.roomStates)) {
        if (rs.paused) paused.add(roomId)
        if (rs.members) membersMap[roomId] = [...rs.members]
        selectionMap[roomId] = rs.selectedMacroId ?? null
      }
    }
    $pausedRooms.set(paused)
    $roomMembers.set(membersMap)
    $selectedMacroIdByRoom.set(selectionMap)

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
    $macroStatus.set(null)

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

  // --- Turn / macro ---

  turn_changed(msg) {
    $turnInfo.set({ roomName: msg.roomName, agentName: msg.agentName, waitingForHuman: msg.waitingForHuman })
  },

  macro_event(msg) {
    $macroStatus.set({ roomName: msg.roomName, event: msg.event, detail: msg.detail })
    // Macro lifecycle no longer mutates mode or pause — those are purely user-controlled now.
  },

  macro_selection_changed(msg) {
    const roomId = roomNameToId(msg.roomName)
    if (!roomId) return
    const current = $selectedMacroIdByRoom.get()
    $selectedMacroIdByRoom.set({ ...current, [roomId]: msg.macroArtifactId })
    // Toast: look up title from current artifact list; fall back to id.
    if (msg.macroArtifactId === null) {
      showToast(document.body, 'Macro selection cleared (macro deleted)', { position: 'fixed', durationMs: 4000 })
    } else {
      const artifact = Object.values($artifacts.get()).find(a => a.id === msg.macroArtifactId)
      const name = artifact?.title ?? 'macro'
      showToast(document.body, `Selected: ${name}`, { position: 'fixed', durationMs: 2500 })
    }
  },

  artifact_created(msg) {
    // Route to anyone listening on this requestId (see pendingCreateHooks below).
    const hook = pendingCreateHooks.get(msg.requestId)
    if (hook) {
      pendingCreateHooks.delete(msg.requestId)
      hook(msg.artifactId, msg.artifactType)
    }
  },

  mode_auto_switched(msg) {
    showToast(
      document.body,
      `Two AI agents in "${msg.roomName}" — switched to Manual. Click 📣 to go back to Broadcast.`,
      { position: 'fixed', durationMs: 7000 },
    )
  },

  next_result(msg) {
    if (!msg.advanced) {
      if (msg.reason) showToast(document.body, `Next: ${msg.reason}`, { type: 'error', position: 'fixed' })
      return
    }
    if (msg.activatedAgentName) {
      const note = msg.queued ? ' (queued)' : ''
      showToast(document.body, `Activated ${msg.activatedAgentName}${note}`, { position: 'fixed', durationMs: 2500 })
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

  providers_changed(_msg) {
    // A key was added/removed/updated live. Prompt the providers panel to
    // re-poll and any open model dropdown to refetch /api/models. We use a
    // CustomEvent so subscribers (agent-modal, inspector, editor) can opt in
    // without tight coupling to this dispatcher.
    window.dispatchEvent(new CustomEvent('providers-changed'))
  },

  packs_changed(_msg) {
    // A pack was installed / updated / uninstalled. The packs panel listens
    // for this CustomEvent and re-fetches /api/packs. Tool/skill sections
    // refresh lazily on next open (their `loaded` flag is reset here).
    window.dispatchEvent(new CustomEvent('packs-changed'))
  },

  // --- Summary + compression ---

  summary_config_changed(_msg) {
    // Room config is server-authoritative; the settings modal re-fetches on open.
    // No store write needed unless we want to surface the current config elsewhere.
  },

  summary_run_started(msg) {
    handleSummaryRunStarted(msg.roomName, msg.target)
  },

  summary_run_delta(msg) {
    handleSummaryRunDelta(msg.roomName, msg.target, msg.delta)
  },

  summary_run_completed(msg) {
    handleSummaryRunCompleted(msg.roomName, msg.target, msg.text)
  },

  summary_run_failed(msg) {
    handleSummaryRunFailed(msg.roomName, msg.target, msg.reason)
    showToast(document.body, `Summary (${msg.target}) failed: ${msg.reason}`, { type: 'error', position: 'fixed' })
  },

  // --- Errors ---

  error(msg) {
    console.error('Server error:', msg.message)
  },
}

export const wsDispatch = handlers as Record<string, (msg: WSOutbound) => void>
