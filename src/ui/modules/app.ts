// ============================================================================
// samsinn — UI Application
//
// Orchestrator: connects WS client, wires store subscriptions to DOM,
// handles user events. State lives in stores.ts; WS dispatch in ws-dispatch.ts.
// ============================================================================

import { createWSClient, type WSClient } from './ws-client.ts'
import { send, setWSClient } from './ws-send.ts'
import { initThinkingDisplay } from './thinking-display.ts'
import { fetchRoomMessages, fetchRoomMembers, fetchRoomArtifacts } from './room-fetchers.ts'
import { renderRooms, renderArtifacts } from './render-rooms.ts'
import { renderAgents } from './render-agents.ts'
import { mountRoomMembers, consumeAutoAddRoom, registerPendingCreateAdd, clearAutoAddRoom } from './render-room-members.ts'
import { mountRoomSwitcher } from './render-room-switcher.ts'
import { mountVisibilityPopover } from './visibility-popover.ts'
import { initMessageHeaderPrefs } from './message-header-prefs.ts'
import { renderMessage } from './render-message.ts'
import type {
  UIMessage,
  RoomProfile,
  AgentInfo,
  ArtifactInfo,
  ArtifactAction,
} from './render-types.ts'
import { derivePhase, phaseLabel, THINKING_MARKER } from './thinking-phase.ts'
import { openTextEditorModal } from './detail-modal.ts'
import { createWorkspace } from './workspace.ts'
import { wsDispatch, pendingCreateHooks } from './ws-dispatch/index.ts'
import { batched } from '../lib/nanostores.ts'
import { showToast } from './toast.ts'
import { roomNameToId, roomIdToName, agentIdToName } from './identity-lookups.ts'
import { populateModelSelect, getShowAllModels, setShowAllModels } from './model-select.ts'
import { safeFetchJson } from './fetch-helpers.ts'
import {
  updateOllamaHealthUI,
  wireOllamaDashboard,
  type OllamaDashboardElements,
} from './ollama-dashboard.ts'
import { stopProvidersPanel } from './providers-panel.ts'
import { startLoggingStateDot } from './logging-panel.ts'
import { initSettingsNav } from './settings-nav.ts'
import { hydrateIconPlaceholders, icon } from './icon.ts'
import {
  isSummaryGroupExpanded,
  initSummaryPanel,
} from './summary-panel.ts'
import { initScriptPanel } from './script-panel.ts'
import { initScriptDocPanel } from './script-doc-panel.ts'
import {
  $myAgentId,
  $sessionToken,
  $connected,
  $selectedRoomId,
  $selectedAgentId,
  $rooms,
  $pausedRooms,
  $unreadCounts,
  $agents,
  $agentIdByName,
  $roomMembers,
  $mutedAgents,
  $generatingRoomIds,
  $roomMessages,
  $artifacts,
  $selectedRoomArtifacts,
  $thinkingPreviews,
  $thinkingTools,
  $currentDeliveryMode,
  $roomPaused,
  $turnInfo,
  $ollamaHealth,
  $agentContexts,
  $agentWarnings,
  $messageContexts,
  $messageWarnings,
  $roomListView,
  $agentListView,
  $selectedHumanByRoom,
  type AgentEntry,
} from './stores.ts'

// === DOM refs ===

import { domRefs } from './app-dom.ts'
import { createThinkingController } from './app-thinking.ts'

const {
  roomList, roomHeader, roomNameEl, roomInfoBar, roomsToggle, roomsHeader,
  agentList, roomMembers, noRoomState, chatArea,
  messagesDiv, chatForm, chatInput,
  roomStatusDot, btnModeToggle, btnWorkspace,
  btnSummaryToggle, btnSummarySettings, btnSummaryInspect, btnSummaryRegenerate,
  roomModeInfo,
  nameModal, nameForm, roomModal, roomForm, agentModal, agentForm,
  agentsHeader, agentsToggle,
  ollamaStatusDot, ollamaDashboard,
  ollamaUrlSelect, ollamaUrlInput, btnOllamaUrlAdd, btnOllamaUrlDelete,
} = domRefs

// Shorthand for getting an element by selector. Used at several points below.
// Previously broken — callers assumed a global `$` that didn't exist, silently
// throwing ReferenceError at module load and halting handler wiring.
const $ = (sel: string) => document.querySelector(sel)!

// Workspace is wired later (below handleArtifactAction).
// eslint-disable-next-line prefer-const
let workspace: ReturnType<typeof createWorkspace>

// === WS client ===
// The `client` reference is held in ws-send.ts so any UI module can call
// `send(...)` without being threaded the client through imports.
let client: WSClient | null = null

// Thinking indicator ephemeral state (DOM-local, not in stores)
const firstChunkSeen = new Set<string>()

// === Action helpers ===

const handleDeleteRoom = (roomId: string, roomName: string): void => {
  if (!confirm(`Delete room "${roomName}"? This cannot be undone.`)) return
  send({ type: 'delete_room', roomName })
}

const handleBookmark = async (content: string): Promise<void> => {
  try {
    const res = await fetch('/api/bookmarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    if (!res.ok) throw new Error(`${res.status}`)
    showToast(document.body, 'Bookmarked')
  } catch {
    showToast(document.body, 'Bookmark failed')
  }
}

const handleDeleteMessage = (msgId: string): void => {
  const roomId = $selectedRoomId.get()
  if (!roomId) return
  const roomName = roomIdToName(roomId)
  if (!roomName) return
  send({ type: 'delete_message', roomName, messageId: msgId })
  // Remove from store immediately (optimistic)
  const msgs = $roomMessages.get()[roomId]
  if (msgs) {
    $roomMessages.setKey(roomId, msgs.filter(m => m.id !== msgId))
  }
  messagesDiv.querySelector(`[data-msg-id="${msgId}"]`)?.remove()
}

const handleArtifactAction = (action: ArtifactAction): void => {
  if (action.kind === 'add_task') {
    send({ type: 'update_artifact', artifactId: action.artifactId, body: { op: 'add_task', taskContent: action.content } })
  } else if (action.kind === 'complete_task') {
    send({ type: 'update_artifact', artifactId: action.artifactId, body: { op: action.completed ? 'complete_task' : 'update_task', taskId: action.taskId, status: action.completed ? 'completed' : 'pending' } })
  } else if (action.kind === 'cast_vote') {
    send({ type: 'cast_vote', artifactId: action.artifactId, optionId: action.optionId })
  } else if (action.kind === 'remove') {
    send({ type: 'remove_artifact', artifactId: action.artifactId })
  } else if (action.kind === 'edit_document') {
    void (async () => {
      const { openDocumentEditor } = await import('./document-editor.ts')
      openDocumentEditor(action.artifactId, action.title, action.blocks, send)
    })()
  }
}

// Prompt-context modal + per-message view-context handler live in context-modal.ts.
import { showContextModal, handleViewContext } from './context-modal.ts'

// Workspace wired here, after handleArtifactAction is in scope. Subscribers
// to $selectedRoomArtifacts and the btn-workspace click handler use this.
workspace = createWorkspace({
  button: btnWorkspace,
  send,
  roomIdToName,
  onAction: handleArtifactAction,
})
btnWorkspace.onclick = () => workspace.open()

// === Data fetching (triggered by subscriptions) ===
// Lives in room-fetchers.ts — imported above.

// === Room header status rendering (pause dot, mode icons, summary group) ===

const refreshRoomControls = (): void => {
  const paused = $roomPaused.get()
  const mode = $currentDeliveryMode.get()
  const roomId = $selectedRoomId.get()

  // Pause dot
  roomStatusDot.setAttribute('aria-pressed', paused ? 'true' : 'false')
  roomStatusDot.title = paused ? 'Paused — click to resume' : 'Active — click to pause'

  // Mode toggle: swap the inner icon and labels based on current mode.
  const isManual = mode === 'manual'
  btnModeToggle.setAttribute('aria-pressed', String(isManual))
  const altMode = isManual ? 'Broadcast' : 'Manual'
  const currentLabel = isManual ? 'Manual' : 'Broadcast'
  const labelText = `${currentLabel} — click to switch to ${altMode}`
  btnModeToggle.title = labelText
  btnModeToggle.setAttribute('aria-label', labelText)
  btnModeToggle.replaceChildren(icon(isManual ? 'hand' : 'megaphone', { size: 14 }))

  // Summary group expand state (per-room)
  const summaryExpanded = roomId ? isSummaryGroupExpanded(roomId) : false
  btnSummaryToggle.setAttribute('aria-pressed', summaryExpanded ? 'true' : 'false')
  btnSummarySettings.classList.toggle('hidden', !summaryExpanded)
  btnSummaryInspect.classList.toggle('hidden', !summaryExpanded)
  btnSummaryRegenerate.classList.toggle('hidden', !summaryExpanded)
}

// === Ollama dashboard (extracted to ollama-dashboard.ts) ===

const ollamaEls: OllamaDashboardElements = {
  statusDot: ollamaStatusDot,
  dashboard: ollamaDashboard,
  urlSelect: ollamaUrlSelect,
  urlInput: ollamaUrlInput,
  btnUrlAdd: btnOllamaUrlAdd,
  btnUrlDelete: btnOllamaUrlDelete,
}

// === Skills/Tools list ===

let roomsSectionExpanded = true
let agentsSectionExpanded = true

const updateAgentsLabel = () => {
  agentsToggle.textContent = `${agentsSectionExpanded ? '▾' : '▸'} Agents (${Object.keys($agents.get()).length})`
}

// ============================================================================
// STORE SUBSCRIPTIONS — wire reactive state to DOM
// ============================================================================

// --- Room list (batched: rooms + selection + pause + unread + generating) ---
$roomListView.subscribe(({ rooms, selectedRoomId, pausedRooms, unreadCounts, generatingRoomIds }) => {
  renderRooms(roomList, {
    rooms,
    selectedRoomId,
    pausedRooms,
    unreadCounts,
    generatingRoomIds,
    onSelect: (id) => {
      // Selecting a room dismisses any open agent modal (and clears the
      // sidebar agent-selection highlight).
      $selectedAgentId.set(null)
      $selectedRoomId.set(id)
    },
    onDelete: handleDeleteRoom,
    onTogglePaused: (_id, roomName, nowPaused) => {
      send({ type: 'set_paused', roomName, paused: nowPaused })
    },
  })
  roomsToggle.textContent = `▾ Rooms (${Object.keys(rooms).length})`
})

// --- Agent list (batched: agents + identity + selection + members) ---
// Per-room actions (add/remove/mute) live in the room-members chip row;
// this sidebar list is now a read-only global registry with in-room tint.
// Sidebar agent list: display-only — selection happens in the room chip
// row, not here. Re-renders on agent list / membership / mute / inspect
// changes; does NOT depend on $selectedHumanByRoom.
$agentListView.subscribe(({ agents, selectedAgentId, selectedRoomId, roomMemberIds }) => {
  renderAgents(agentList, {
    agents: agents as unknown as Record<string, AgentInfo>,
    selectedAgentId,
    roomMemberIds,
    hasSelectedRoom: selectedRoomId !== null,
    onInspect: (agentId) => {
      $selectedAgentId.set(agentId)
    },
    onDelete: (agentName) => {
      if (!confirm(`Delete agent ${agentName}? This cannot be undone.`)) return
      void safeFetchJson(`/api/agents/${encodeURIComponent(agentName)}`, { method: 'DELETE' })
    },
  })
  updateAgentsLabel()
})

// Auto-select / GC on room enter:
//   - GC stale per-room selections (selected agent was deleted)
//   - If exactly one human is a member of the room and no valid selection,
//     set them as poster.
const reconcileSelectionForRoom = (roomId: string): void => {
  const posterMap = $selectedHumanByRoom.get()
  const view = $agentListView.get()
  const memberSet = new Set(view.roomMemberIds)
  const allAgents = view.agents

  const current = posterMap[roomId]
  const currentValid = current && allAgents[current] && allAgents[current].kind === 'human'
  if (!currentValid && current) {
    // Drop stale entry. setKey with undefined removes via the underlying map.
    const next = { ...posterMap }
    delete next[roomId]
    $selectedHumanByRoom.set(next)
  }
  if (currentValid) return

  const humansInRoom = Object.values(allAgents).filter(a => a.kind === 'human' && memberSet.has(a.id))
  if (humansInRoom.length === 1) {
    $selectedHumanByRoom.setKey(roomId, humansInRoom[0]!.id)
  }
}

$selectedRoomId.subscribe((roomId) => {
  if (!roomId) return
  reconcileSelectionForRoom(roomId)
})

// Also reconcile when the agent list changes (e.g. snapshot just arrived
// after a fresh page load — auto-select fires once agents are visible).
$agents.listen(() => {
  const roomId = $selectedRoomId.get()
  if (roomId) reconcileSelectionForRoom(roomId)
})

// --- Room members chip row (chip row + Add picker at top of room page) ---
// Shared opener for the create-agent modal — used by both the sidebar button
// and the room-members "+ Create new…" picker.
const openCreateAgentModalShared = async (): Promise<void> => {
  const modelSelect = agentForm.querySelector('select[name="model"]') as HTMLSelectElement
  const showAllBox = document.getElementById('model-show-all') as HTMLInputElement | null
  if (showAllBox) showAllBox.checked = getShowAllModels()
  agentModal.showModal()
  await populateModelSelect(modelSelect)
}

mountRoomMembers({
  container: roomMembers,
  send,
  openCreateAgentModal: () => void openCreateAgentModalShared(),
  // Inspector is a modal — keep the user in the room (no $selectedRoomId.set(null))
  // so the modal layers over the room view rather than replacing it.
  inspectAgent: (agentId) => {
    $selectedAgentId.set(agentId)
  },
})

mountRoomSwitcher({
  button: document.getElementById('room-switcher') as HTMLButtonElement,
  popover: document.getElementById('room-switcher-popover') as HTMLElement,
  openCreateRoomModal: () => roomModal.showModal(),
})

// Apply persisted message-header field-visibility prefs as body classes
// BEFORE the first message renders. CSS rules in index.html hide
// `[data-mh-piece="<name>"]` when `body.mh-hide-<name>` is set.
initMessageHeaderPrefs()

mountVisibilityPopover({
  button: document.getElementById('btn-icon-visibility') as HTMLButtonElement,
  popover: document.getElementById('icon-visibility-popover') as HTMLElement,
  roomHeader: roomHeader,
})

// Bug-report icon in the room header — same modal as Settings → Report bug.
document.getElementById('btn-report-bug')!.onclick = () => {
  void import('./bug-modal.ts').then(m => m.openBugModal())
}

// --- Room selection: visibility, fetch data, render messages ---
$selectedRoomId.listen((roomId, prevRoomId) => {
  // Clear unread
  if (roomId) $unreadCounts.setKey(roomId, 0)

  // UI visibility
  if (roomId) {
    const room = $rooms.get()[roomId]
    if (!room) return
    noRoomState.classList.add('hidden')
    roomHeader.classList.remove('hidden')
    roomInfoBar.classList.remove('hidden')
    chatArea.classList.remove('hidden')
    roomNameEl.textContent = room.name

    // Fetch membership if needed
    if (!$roomMembers.get()[roomId]) {
      fetchRoomMembers(roomId, room.name)
    }

    // Fetch artifacts
    fetchRoomArtifacts(roomId, room.name)

    // Render messages — stamp roomId on the container for defensive checks
    messagesDiv.innerHTML = ''
    messagesDiv.setAttribute('data-room-id', roomId)
    messagesDiv.style.scrollBehavior = 'auto'
    const cached = $roomMessages.get()[roomId]
    if (cached) {
      for (const m of cached) renderMessage({
        container: messagesDiv, msg: m, myAgentId: $myAgentId.get() ?? '',
        agents: $agents.get() as unknown as Record<string, AgentInfo>,
        onDelete: handleDeleteMessage, onViewContext: handleViewContext, onBookmark: handleBookmark,
      })
    } else {
      fetchRoomMessages(roomId, room.name)
    }

    // Restore thinking indicators for agents generating in this room
    for (const [id, agent] of Object.entries($agents.get())) {
      if (agent.state === 'generating' && agent.context === roomId) {
        ensureThinkingIndicator(id, agent.name)
      }
    }

    messagesDiv.scrollTop = messagesDiv.scrollHeight
    requestAnimationFrame(() => { messagesDiv.style.scrollBehavior = '' })

    // Apply room-specific state
    refreshRoomControls()
    workspace.show()
  } else {
    // No room selected — show the empty-state. Agent inspector is now a
    // modal, so it doesn't compete with chat-area visibility anymore.
    noRoomState.classList.remove('hidden')
    roomHeader.classList.add('hidden')
    roomInfoBar.classList.add('hidden')
    chatArea.classList.add('hidden')
    workspace.hide()
  }
})

// --- Agent selection — opens the detail modal ---
// Both the sidebar agent list and the room-members chip row set
// $selectedAgentId; this listener routes both to the modal. The modal's
// own close handler clears $selectedAgentId so the sidebar drops its
// highlight when the user dismisses the dialog.
$selectedAgentId.listen(async (agentId) => {
  if (agentId) {
    const agent = $agents.get()[agentId]
    if (!agent) return
    const { openAgentDetailModal } = await import('./agent-detail-modal.ts')
    openAgentDetailModal(agent.name)
  } else {
    const { closeAgentDetailModal } = await import('./agent-detail-modal.ts')
    closeAgentDetailModal()
  }
})

// --- New messages in current room: append to DOM ---
$roomMessages.listen((allMessages, _old, changedRoomId) => {
  // Double-check: both the store and the DOM container must agree on which room is displayed
  if (!changedRoomId || changedRoomId !== $selectedRoomId.get()) return
  if (messagesDiv.getAttribute('data-room-id') !== changedRoomId) return
  // The subscription fires after setKey. We need to render only new messages.
  // Since we replace the full array in the store, we compare with what's in the DOM.
  const msgs = allMessages[changedRoomId] ?? []
  const existingIds = new Set(
    Array.from(messagesDiv.querySelectorAll('[data-msg-id]')).map(el => el.getAttribute('data-msg-id')!)
  )
  for (const m of msgs) {
    if (!existingIds.has(m.id)) {
      renderMessage({
        container: messagesDiv, msg: m, myAgentId: $myAgentId.get() ?? '',
        agents: $agents.get() as unknown as Record<string, AgentInfo>,
        onDelete: handleDeleteMessage, onViewContext: handleViewContext, onBookmark: handleBookmark,
      })
    }
  }
  // Remove deleted messages
  for (const id of existingIds) {
    if (!msgs.some(m => m.id === id)) {
      messagesDiv.querySelector(`[data-msg-id="${id}"]`)?.remove()
    }
  }
  // Ensure thinking indicators stay at the bottom (after newly appended messages)
  syncThinkingIndicators()

  // Scroll to bottom if near bottom
  if (messagesDiv.scrollHeight - messagesDiv.scrollTop - messagesDiv.clientHeight < 100) {
    messagesDiv.scrollTop = messagesDiv.scrollHeight
  }
})

// --- Thinking indicator lifecycle ---

const { ensureThinkingIndicator, clearThinkingIndicator, syncThinkingIndicators } = createThinkingController({
  messagesDiv,
  send,
  firstChunkSeen,
  $agents,
  $agentContexts,
  $agentWarnings,
  $thinkingTools,
  $thinkingPreviews,
  $selectedRoomId,
  showContextModal,
})

$agents.listen((_agents, _old, _changedId) => {
  syncThinkingIndicators()
})

// --- Thinking-indicator subscriptions live in thinking-display.ts.
//     Preview / tools / contexts / warnings listeners wired by initThinkingDisplay. ---
initThinkingDisplay({ messagesDiv, firstChunkSeen, showContextModal })

// --- Artifacts → workspace badge ---
$selectedRoomArtifacts.subscribe((artifacts) => {
  const roomId = $selectedRoomId.get()
  if (!roomId) return
  const active = artifacts.filter(a => !a.resolvedAt)
  workspace.setCount(active.length)
  refreshRoomControls()
})

// --- Mode / turn info (batched: mode + pause feed mode selector) ---
const $modeView = batched(
  [$currentDeliveryMode, $roomPaused],
  (mode: string, paused: boolean) => ({ mode, paused }),
)
$modeView.listen(() => refreshRoomControls())

$turnInfo.listen((info) => {
  if (info?.agentName) {
    roomModeInfo.textContent = `Turn: ${info.agentName}${info.waitingForHuman ? ' (waiting for input)' : ''}`
    roomModeInfo.className = 'text-xs text-accent h-4 font-medium'
  }
})

// --- Connection state ---
$connected.listen((connected) => {
  chatInput.disabled = !connected
  if (connected) chatForm.querySelector('button')!.removeAttribute('disabled')
})

// --- Sidebar resize (drag handle on right edge; drag-to-left collapses) ---
void import('./sidebar-resize.ts').then(m => m.initSidebarResize())

// --- Ollama health (metrics now polled by ollama-dashboard.ts directly via REST) ---
$ollamaHealth.listen((health) => {
  if (health) updateOllamaHealthUI(health as unknown as Record<string, unknown>, ollamaStatusDot)
})

// ============================================================================
// DOM EVENT HANDLERS
// ============================================================================

chatForm.onsubmit = (e) => {
  e.preventDefault()
  const content = chatInput.value.trim()
  const roomId = $selectedRoomId.get()
  if (!content || !roomId) return
  const roomName = roomIdToName(roomId)
  if (!roomName) return

  const posterMap = $selectedHumanByRoom.get()
  let senderId = posterMap[roomId]

  // If no human selected for this room, try to resolve. Auto-select the
  // single human in the room; otherwise open the picker modal.
  if (!senderId) {
    const view = $agentListView.get()
    const memberSet = new Set(view.roomMemberIds)
    const humansInRoom = Object.values(view.agents).filter(a => a.kind === 'human' && memberSet.has(a.id))
    if (humansInRoom.length === 1) {
      senderId = humansInRoom[0]!.id
      $selectedHumanByRoom.setKey(roomId, senderId)
    } else {
      // Hand off to the send-as picker. It re-submits when the user selects.
      void openSendAsPicker(roomId, content)
      return
    }
  }

  send({ type: 'post_message', target: { rooms: [roomName] }, content, senderId })
  chatInput.value = ''
}

// Quick "create human" path used by the send-as picker when no humans exist.
// Inline prompt → POST /api/agents/human → add to current room → select → re-send.
const createHumanInline = async (roomId: string, content: string): Promise<void> => {
  const name = window.prompt('Name for the new human:')?.trim()
  if (!name) return
  const roomName = roomIdToName(roomId)
  if (!roomName) return
  try {
    const res = await fetch('/api/agents/human', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, roomName }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string }
      showToast(document.body, data.error ?? `Create failed (${res.status})`, { type: 'error', position: 'fixed' })
      return
    }
    const { id } = await res.json() as { id: string }
    $selectedHumanByRoom.setKey(roomId, id)
    if (content) {
      send({ type: 'post_message', target: { rooms: [roomName] }, content, senderId: id })
      chatInput.value = ''
    }
  } catch {
    showToast(document.body, 'Create failed', { type: 'error', position: 'fixed' })
  }
}

// Send-as picker — modal listing humans (in-room first, then others).
// On select: sets per-room selection, closes modal, re-fires the send.
// If no humans exist anywhere, opens the create-agent modal pre-filled with
// kind=human; the new human is added to the current room and selected.
const openSendAsPicker = async (roomId: string, content: string): Promise<void> => {
  const allAgents = Object.values($agents.get())
  const humans = allAgents.filter(a => a.kind === 'human')
  const memberSet = new Set($agentListView.get().roomMemberIds)
  const roomName = roomIdToName(roomId)
  if (!roomName) return

  if (humans.length === 0) {
    // No humans in the system. Open the existing agent-create modal,
    // pre-fill the human path. On creation, auto-add to current room,
    // select, and (best-effort) re-send the queued message.
    await createHumanInline(roomId, content)
    return
  }

  const overlay = document.createElement('div')
  overlay.className = 'fixed inset-0 flex items-center justify-center z-50 p-4'
  overlay.style.background = 'var(--shadow-overlay)'
  const card = document.createElement('div')
  card.className = 'rounded-lg shadow-xl w-full max-w-md bg-surface text-text overflow-hidden'
  const header = document.createElement('div')
  header.className = 'px-6 py-3 border-b border-border'
  header.innerHTML = `<h3 class="text-base font-semibold">Post as…</h3><div class="text-xs text-text-muted mt-1">Pick a human to attribute this message to in <strong>${roomName}</strong>.</div>`
  card.appendChild(header)

  const body = document.createElement('div')
  body.className = 'px-6 py-3 max-h-[60vh] overflow-y-auto'
  const inRoom = humans.filter(h => memberSet.has(h.id))
  const elsewhere = humans.filter(h => !memberSet.has(h.id))

  const close = (): void => overlay.remove()
  overlay.onclick = (e) => { if (e.target === overlay) close() }
  const onEsc = (e: KeyboardEvent): void => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc) } }
  document.addEventListener('keydown', onEsc)

  const buildRow = (h: AgentInfo, needsAdd: boolean): HTMLElement => {
    const row = document.createElement('div')
    row.className = 'py-2 flex items-center gap-2 border-b border-border last:border-b-0 cursor-pointer hover:bg-surface-muted px-2 -mx-2 rounded'
    row.innerHTML = `<span class="font-medium flex-1">${h.name}</span><span class="text-[10px] uppercase tracking-wide text-text-subtle">${needsAdd ? 'add to room' : 'in room'}</span>`
    row.onclick = () => {
      if (needsAdd) {
        if (!confirm(`Add ${h.name} to ${roomName}?`)) return
        send({ type: 'add_to_room', roomName, agentName: h.name })
      }
      $selectedHumanByRoom.setKey(roomId, h.id)
      send({ type: 'post_message', target: { rooms: [roomName] }, content, senderId: h.id })
      chatInput.value = ''
      close()
    }
    return row
  }
  for (const h of inRoom) body.appendChild(buildRow(h, false))
  for (const h of elsewhere) body.appendChild(buildRow(h, true))

  const footer = document.createElement('div')
  footer.className = 'px-6 py-3 border-t border-border flex justify-between gap-2'
  const newBtn = document.createElement('button')
  newBtn.className = 'px-3 py-1 text-xs border border-border-strong rounded hover:bg-surface-muted'
  newBtn.textContent = '+ New human'
  newBtn.onclick = async () => { close(); await createHumanInline(roomId, content) }
  const cancel = document.createElement('button')
  cancel.className = 'px-3 py-1 text-xs text-text-muted'
  cancel.textContent = 'Cancel'
  cancel.onclick = close
  footer.appendChild(newBtn)
  footer.appendChild(cancel)
  card.appendChild(body)
  card.appendChild(footer)
  overlay.appendChild(card)
  document.body.appendChild(overlay)
}

document.getElementById('btn-create-room')!.onclick = (e) => {
  e.stopPropagation()
  roomModal.showModal()
}

document.getElementById('btn-create-agent')!.onclick = (e) => {
  e.stopPropagation()
  void openCreateAgentModalShared()
}

// "Show all models" toggle in agent-modal: persist preference + re-populate
// the visible model select without reopening the modal.
const showAllBox = document.getElementById('model-show-all') as HTMLInputElement | null
if (showAllBox) {
  showAllBox.addEventListener('change', async () => {
    setShowAllModels(showAllBox.checked)
    const modelSelect = agentForm.querySelector('select[name="model"]') as HTMLSelectElement
    const prev = modelSelect.value
    await populateModelSelect(modelSelect, { preferredModel: prev || undefined })
  })
}

// Hot-reload: when keys change server-side, refresh any open model selects.
window.addEventListener('providers-changed', () => {
  void (async () => {
    const selects = document.querySelectorAll<HTMLSelectElement>('select[name="model"], #agent-area select')
    for (const sel of Array.from(selects)) {
      const prev = sel.value
      await populateModelSelect(sel, { preferredModel: prev || undefined })
    }
  })()
})

// --- Pause status dot (header) ---
roomStatusDot.onclick = () => {
  const roomId = $selectedRoomId.get()
  if (!roomId) return
  const roomName = roomIdToName(roomId)
  if (!roomName) return
  send({ type: 'set_paused', roomName, paused: !$roomPaused.get() })
}

// --- Mode icon pair (Broadcast / Manual) ---
const setMode = (mode: 'broadcast' | 'manual'): void => {
  const roomId = $selectedRoomId.get()
  if (!roomId) return
  const roomName = roomIdToName(roomId)
  if (!roomName) return
  send({ type: 'set_delivery_mode', roomName, mode })
}
// Single mode toggle — flips between broadcast and manual. The icon and
// title are kept in sync by refreshRoomControls() driven by $modeView.
btnModeToggle.onclick = () => {
  const next = $currentDeliveryMode.get() === 'manual' ? 'broadcast' : 'manual'
  setMode(next)
}

// --- Summary group (Toggle, Settings, Inspect, Regenerate) lives in summary-panel.ts.
//     Wired once below via initSummaryPanel. ---

initSummaryPanel({ onRefreshRoomControls: refreshRoomControls })
initScriptPanel({ onRefreshRoomControls: refreshRoomControls })
initScriptDocPanel()
void import('./reset-button.ts').then(m => m.initResetPanel())

roomForm.onsubmit = (e) => {
  e.preventDefault()
  const data = new FormData(roomForm)
  const roomPrompt = (data.get('roomPrompt') as string | null)?.trim() || undefined
  send({ type: 'create_room', name: data.get('name') as string, ...(roomPrompt ? { roomPrompt } : {}) })
  roomModal.close(); roomForm.reset()
}

// Kind-tab state. Default 'ai' on each open. Reset on close in the
// agentModal close listener below.
let agentModalKind: 'ai' | 'human' = 'ai'
const setAgentModalKind = (kind: 'ai' | 'human'): void => {
  agentModalKind = kind
  const titleEl = document.getElementById('agent-modal-title')
  if (titleEl) titleEl.textContent = kind === 'ai' ? 'Create AI Agent' : 'Create Human'
  const aiFields = document.querySelector('[data-ai-fields]') as HTMLElement | null
  if (aiFields) aiFields.style.display = kind === 'ai' ? '' : 'none'
  const tabsRoot = document.getElementById('agent-kind-tabs')
  if (tabsRoot) {
    for (const btn of Array.from(tabsRoot.querySelectorAll<HTMLButtonElement>('button[data-kind]'))) {
      const active = btn.dataset.kind === kind
      btn.setAttribute('aria-selected', String(active))
      btn.classList.toggle('border-accent', active)
      btn.classList.toggle('text-text-strong', active)
      btn.classList.toggle('border-transparent', !active)
      btn.classList.toggle('text-text-muted', !active)
    }
  }
  // Toggle `required` on AI-only fields so the browser doesn't block
  // the human-form submit on missing model/persona.
  const modelSelect = agentForm.querySelector('select[name="model"]') as HTMLSelectElement | null
  const personaTA = agentForm.querySelector('textarea[name="persona"]') as HTMLTextAreaElement | null
  if (modelSelect) modelSelect.required = kind === 'ai'
  if (personaTA) personaTA.required = kind === 'ai'
}
const tabsRoot = document.getElementById('agent-kind-tabs')
if (tabsRoot) {
  tabsRoot.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-kind]')
    if (!btn) return
    setAgentModalKind(btn.dataset.kind as 'ai' | 'human')
  })
}

agentForm.onsubmit = (e) => {
  e.preventDefault()
  const data = new FormData(agentForm)
  const agentName = (data.get('name') as string).trim()
  if (!agentName) return

  if (agentModalKind === 'human') {
    // POST to /api/agents/human with name + optional persona/tags + optional room.
    const autoAddRoom = consumeAutoAddRoom()
    const persona = (data.get('persona') as string | null)?.trim() || undefined
    const rawTagsHuman = (data.get('tags') as string | null)?.trim() ?? ''
    const humanTags = rawTagsHuman ? rawTagsHuman.split(',').map(t => t.trim()).filter(Boolean) : undefined
    void (async () => {
      try {
        const res = await fetch('/api/agents/human', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: agentName,
            ...(persona ? { persona } : {}),
            ...(humanTags && humanTags.length > 0 ? { tags: humanTags } : {}),
            ...(autoAddRoom ? { roomName: autoAddRoom } : {}),
          }),
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({})) as { error?: string }
          showToast(document.body, body.error ?? `Create failed (${res.status})`, { type: 'error', position: 'fixed' })
          return
        }
        showToast(document.body, `Created ${agentName}`, { type: 'success', position: 'fixed' })
      } catch {
        showToast(document.body, 'Create failed', { type: 'error', position: 'fixed' })
      }
    })()
    agentModal.close(); agentForm.reset()
    return
  }

  // AI path (existing flow).
  const rawTags = (data.get('tags') as string | null)?.trim() ?? ''
  const tags = rawTags ? rawTags.split(',').map(t => t.trim()).filter(Boolean) : undefined
  const autoAddRoom = consumeAutoAddRoom()
  if (autoAddRoom) registerPendingCreateAdd(agentName, autoAddRoom)
  send({ type: 'create_agent', config: { name: agentName, model: data.get('model') as string, persona: data.get('persona') as string, ...(tags && tags.length > 0 ? { tags } : {}) } })
  agentModal.close(); agentForm.reset()
}

// If the create-agent modal is closed without submitting, drop any pending
// auto-add-to-room intent so it doesn't leak into the next open. Also reset
// the kind tabs so the next open defaults to AI.
agentModal.addEventListener('close', () => {
  clearAutoAddRoom()
  setAgentModalKind('ai')
})

// Artifact submit + input handlers now live inside the workspace modal
// (workspace.ts), so app.ts no longer wires them.

// Sidebar section toggles
// Section toggles: click the dedicated toggle button (with aria-expanded)
// rather than the whole header — keeps the +create button and toggle as
// distinct keyboard targets.
const roomsToggleBtn = $('#rooms-toggle-btn') as HTMLButtonElement
roomsToggleBtn.onclick = () => {
  roomsSectionExpanded = !roomsSectionExpanded
  roomList.classList.toggle('hidden', !roomsSectionExpanded)
  roomsToggle.textContent = `${roomsSectionExpanded ? '▾' : '▸'} Rooms (${Object.keys($rooms.get()).length})`
  roomsToggleBtn.setAttribute('aria-expanded', String(roomsSectionExpanded))
}

const agentsToggleBtn = $('#agents-toggle-btn') as HTMLButtonElement
agentsToggleBtn.onclick = () => {
  agentsSectionExpanded = !agentsSectionExpanded
  agentList.classList.toggle('hidden', !agentsSectionExpanded)
  updateAgentsLabel()
  agentsToggleBtn.setAttribute('aria-expanded', String(agentsSectionExpanded))
}

// Settings sidebar section — single nav entry to six modal rows.
hydrateIconPlaceholders()
initSettingsNav()

// === Global modal UX: click outside to close ===
//
// Native <dialog>.showModal() supports Escape via the `cancel` event and a
// click on the dialog element targets the backdrop area. We wire a single
// listener per <dialog> that closes on backdrop click. Dialogs built via
// createModal() already have their own overlay-click handler; that path is
// untouched. Visible × close buttons are de-emphasized (CSS) so click-
// outside is the canonical close affordance.
for (const dlg of Array.from(document.querySelectorAll<HTMLDialogElement>('dialog'))) {
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg && dlg.open) dlg.close()
  })
}
// Keep the logging recording dot fresh in the sidebar even when the
// Logging modal isn't open.
startLoggingStateDot()

const btnClearMessages = $('#btn-clear-messages') as HTMLButtonElement
btnClearMessages.onclick = () => {
  const roomId = $selectedRoomId.get()
  if (!roomId) return
  const roomName = roomIdToName(roomId)
  if (!roomName) return
  if (!confirm(`Clear all messages in "${roomName}"?`)) return
  send({ type: 'clear_messages', roomName })
}

const btnBookmarks = $('#btn-bookmarks') as HTMLButtonElement
btnBookmarks.onclick = async () => {
  const { openBookmarksPanel } = await import('./bookmarks-panel.ts')
  await openBookmarksPanel({
    setComposerText: (text: string) => {
      chatInput.value = text
      chatInput.focus()
    },
  })
}

const btnRoomPrompt = $('#btn-room-prompt') as HTMLButtonElement
btnRoomPrompt.onclick = () => {
  const roomId = $selectedRoomId.get()
  if (!roomId) return
  const room = $rooms.get()[roomId]
  if (!room) return
  openTextEditorModal(
    `Room Prompt — ${room.name}`,
    `/api/rooms/${encodeURIComponent(room.name)}`,
    'roomPrompt',
    `/api/rooms/${encodeURIComponent(room.name)}/prompt`,
    'PUT',
    (data) => ((data.profile as Record<string, unknown>)?.roomPrompt as string) ?? '',
  )
}

// Theme toggle + app info (version + repo link in sidebar footer)
void (async () => {
  const { wireThemeToggle, onThemeChange } = await import('./theme.ts')
  wireThemeToggle()
  onThemeChange(async () => {
    try {
      const { reRenderAllMermaid } = await import('./mermaid/index.ts')
      await reRenderAllMermaid()
    } catch { /* mermaid may not be loaded yet */ }
  })
  try {
    const info = await fetch('/api/system/info').then(r => r.ok ? r.json() : null) as { version: string; repoUrl: string } | null
    if (!info) return
    const vEl = document.getElementById('app-version')
    if (vEl) vEl.textContent = `v${info.version}`
    const linkEl = document.getElementById('app-repo-link') as HTMLButtonElement | null
    if (linkEl && info.repoUrl) {
      linkEl.onclick = () => window.open(info.repoUrl, '_blank', 'noopener,noreferrer')
    }
  } catch { /* non-fatal */ }
})()

// Providers dashboard — one-time wiring. Opener lives in providers-modal.ts,
// routed from the Settings > Providers sidebar row.
wireOllamaDashboard(ollamaEls, send)

// Stop polling when dashboard closes (reuses existing close event on the dialog).
ollamaEls.dashboard.addEventListener('close', () => stopProvidersPanel())

// ============================================================================
// CONNECT + STARTUP
// ============================================================================

const connect = () => {
  client = createWSClient($sessionToken.get(), (raw) => {
    const msg = raw as { type?: string }
    if (typeof msg.type !== 'string') return
    const handler = wsDispatch[msg.type]
    if (handler) handler(raw as Parameters<typeof handler>[0])
  }, (connected) => {
    $connected.set(connected)
  })
  setWSClient(client)
}

// v15+: WS sessions are pure viewers — no name, no agent binding.
// The legacy localStorage `ta_name` (and the never-shown #name-modal)
// are vestigial; we ignore both.
void (async () => {
  const { ensureAuthenticated } = await import('./auth.ts')
  await ensureAuthenticated()
  connect()
})()
