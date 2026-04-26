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
  updateOllamaHealthUI, updateOllamaMetricsUI,
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
  $myName,
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
  $ollamaMetrics,
  $agentContexts,
  $agentWarnings,
  $messageContexts,
  $messageWarnings,
  $roomListView,
  $agentListView,
  type AgentEntry,
} from './stores.ts'

// === DOM refs ===

import { domRefs } from './app-dom.ts'
import { createThinkingController } from './app-thinking.ts'

const {
  roomList, roomHeader, roomNameEl, roomInfoBar, roomsToggle, roomsHeader,
  agentList, roomMembers, noRoomState, agentArea, chatArea,
  messagesDiv, chatForm, chatInput,
  roomStatusDot, btnModeToggle, btnWorkspace,
  btnSummaryToggle, btnSummarySettings, btnSummaryInspect, btnSummaryRegenerate,
  roomModeInfo,
  nameModal, nameForm, roomModal, roomForm, agentModal, agentForm,
  agentsHeader, agentsToggle,
  ollamaStatusDot, ollamaDashboard, ollamaDashboardClose,
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
  closeBtn: ollamaDashboardClose,
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
$agentListView.subscribe(({ agents, myAgentId, selectedAgentId, selectedRoomId, roomMemberIds }) => {
  renderAgents(agentList, {
    agents: agents as unknown as Record<string, AgentInfo>,
    myAgentId,
    selectedAgentId,
    roomMemberIds,
    hasSelectedRoom: selectedRoomId !== null,
    onInspect: (agentId) => {
      $selectedRoomId.set(null)
      $selectedAgentId.set(agentId)
    },
    onDelete: (agentName) => {
      if (!confirm(`Delete agent ${agentName}? This cannot be undone.`)) return
      void safeFetchJson(`/api/agents/${encodeURIComponent(agentName)}`, { method: 'DELETE' })
    },
  })
  updateAgentsLabel()
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
  inspectAgent: (agentId) => {
    $selectedRoomId.set(null)
    $selectedAgentId.set(agentId)
  },
})

mountRoomSwitcher({
  button: document.getElementById('room-switcher') as HTMLButtonElement,
  popover: document.getElementById('room-switcher-popover') as HTMLElement,
  openCreateRoomModal: () => roomModal.showModal(),
})

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
    agentArea.classList.add('hidden')
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
  } else if (!$selectedAgentId.get()) {
    noRoomState.classList.remove('hidden')
    roomHeader.classList.add('hidden')
    roomInfoBar.classList.add('hidden')
    chatArea.classList.add('hidden')
    workspace.hide()
  }
})

// --- Agent selection (inspector) ---
$selectedAgentId.listen(async (agentId) => {
  if (agentId) {
    roomHeader.classList.add('hidden')
    roomInfoBar.classList.add('hidden')
    chatArea.classList.add('hidden')
    workspace.hide()
    noRoomState.classList.add('hidden')
    agentArea.classList.remove('hidden')

    const agent = $agents.get()[agentId]
    if (!agent) return
    const { renderAgentInspector } = await import('./agent-inspector.ts')
    renderAgentInspector(agentArea, agent.name)
  } else {
    agentArea.classList.add('hidden')
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

// --- Ollama health/metrics ---
$ollamaHealth.listen((health) => {
  if (health) updateOllamaHealthUI(health, ollamaStatusDot)
})
$ollamaMetrics.listen((metrics) => {
  if (metrics) updateOllamaMetricsUI(metrics)
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

  send({ type: 'post_message', target: { rooms: [roomName] }, content })
  chatInput.value = ''
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

agentForm.onsubmit = (e) => {
  e.preventDefault()
  const data = new FormData(agentForm)
  const rawTags = (data.get('tags') as string | null)?.trim() ?? ''
  const tags = rawTags ? rawTags.split(',').map(t => t.trim()).filter(Boolean) : undefined
  const agentName = data.get('name') as string
  const autoAddRoom = consumeAutoAddRoom()
  if (autoAddRoom) registerPendingCreateAdd(agentName, autoAddRoom)
  send({ type: 'create_agent', config: { name: agentName, model: data.get('model') as string, persona: data.get('persona') as string, ...(tags && tags.length > 0 ? { tags } : {}) } })
  agentModal.close(); agentForm.reset()
}

// If the create-agent modal is closed without submitting, drop any pending
// auto-add-to-room intent so it doesn't leak into the next open.
agentModal.addEventListener('close', () => {
  // Consuming clears it; we only need to clear if still set (i.e. cancel path,
  // since submit already consumed it before close).
  clearAutoAddRoom()
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

const connect = (name: string) => {
  client = createWSClient(name, $sessionToken.get(), (raw) => {
    const msg = raw as { type?: string }
    if (typeof msg.type !== 'string') return
    const handler = wsDispatch[msg.type]
    if (handler) handler(raw as Parameters<typeof handler>[0])
  }, (connected) => {
    $connected.set(connected)
  })
  // Expose the active client to any module that imports send() from ws-send.ts.
  // Mirrors the local `client` ref.
  setWSClient(client)
}

const savedName = localStorage.getItem('ta_name')

nameForm.onsubmit = (e) => {
  e.preventDefault()
  const name = (new FormData(nameForm).get('name') as string).trim()
  if (!name) return
  $myName.set(name)
  localStorage.setItem('ta_name', name)
  nameModal.close()
  connect(name)
}

// Boot order: auth gate must complete before we open a WebSocket — the
// upgrade rejects unauthenticated connections in deploy mode and would
// otherwise spin in the reconnect loop.
void (async () => {
  const { ensureAuthenticated } = await import('./auth.ts')
  await ensureAuthenticated()
  if (savedName) {
    $myName.set(savedName)
    connect(savedName)
  } else {
    nameModal.showModal()
  }
})()
