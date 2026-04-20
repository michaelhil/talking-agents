// ============================================================================
// samsinn — UI Application
//
// Orchestrator: connects WS client, wires store subscriptions to DOM,
// handles user events. State lives in stores.ts; WS dispatch in ws-dispatch.ts.
// ============================================================================

import { createWSClient, type WSClient } from './ws-client.ts'
import { renderRooms, renderArtifacts } from './render-rooms.ts'
import { renderAgents } from './render-agents.ts'
import { mountRoomMembers, consumeAutoAddRoom, registerPendingCreateAdd, clearAutoAddRoom } from './render-room-members.ts'
import { renderMessage } from './render-message.ts'
import {
  updateThinkingPreview,
  updateThinkingTool,
  updateThinkingLabel,
  updateThinkingPreviewStyle,
  showContextIcon,
  addThinkingWarning,
} from './render-thinking.ts'
import type {
  UIMessage,
  RoomProfile,
  AgentInfo,
  ArtifactInfo,
  ArtifactAction,
} from './render-types.ts'
import { derivePhase, phaseLabel, THINKING_MARKER } from './thinking-phase.ts'
import { openTextEditorModal, createModal, createButtonRow, createTextarea } from './modal.ts'
import { createWorkspace } from './workspace.ts'
import { wsDispatch } from './ws-dispatch.ts'
import { batched } from '../lib/nanostores.ts'
import { showToast, roomNameToId, roomIdToName, agentIdToName, populateModelSelect, getShowAllModels, setShowAllModels, safeFetchJson } from './ui-utils.ts'
import {
  updateOllamaHealthUI, updateOllamaMetricsUI,
  wireOllamaDashboard, openOllamaDashboard,
  type OllamaDashboardElements,
} from './ollama-dashboard.ts'
import { startProvidersPanel, stopProvidersPanel } from './providers-panel.ts'
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
  $flowStatus,
  $pinnedMessages,
  $ollamaHealth,
  $ollamaMetrics,
  $sidebarCollapsed,
  $toolsLoaded,
  $skillsLoaded,
  $toolCount,
  $skillCount,
  $agentContexts,
  $agentWarnings,
  $messageContexts,
  $messageWarnings,
  $roomListView,
  $agentListView,
  type AgentEntry,
  type AgentContext,
} from './stores.ts'

// === DOM refs ===

import { domRefs } from './app-dom.ts'
import { createThinkingController } from './app-thinking.ts'

const {
  roomList, roomHeader, roomNameEl, roomInfoBar, roomsToggle, roomsHeader,
  agentList, roomMembers, noRoomState, agentArea, chatArea, pinnedMessagesDiv,
  workspaceBar, workspacePane, workspaceContent, workspaceLabel, workspaceAddRow,
  artifactInput, btnArtifactSubmit, messagesDiv, chatForm, chatInput,
  modeSelector, pauseToggle, roomModeInfo,
  nameModal, nameForm, roomModal, roomForm, agentModal, agentForm,
  sidebar, btnCollapseSidebar,
  agentsHeader, agentsToggle,
  toolsHeader, toolsToggle, toolsList,
  skillsHeader, skillsToggle, skillsList,
  artifactTypeSelect,
  ollamaStatusDot, ollamaDashboard, ollamaDashboardClose,
  ollamaUrlSelect, ollamaUrlInput, btnOllamaUrlAdd, btnOllamaUrlDelete,
} = domRefs

// Shorthand for getting an element by selector. Used at several points below.
// Previously broken — callers assumed a global `$` that didn't exist, silently
// throwing ReferenceError at module load and halting handler wiring.
const $ = (sel: string) => document.querySelector(sel)!

const workspace = createWorkspace({ bar: workspaceBar, pane: workspacePane, chatArea, label: workspaceLabel })

// === WS client ===

let client: WSClient | null = null
const send = (data: unknown) => client?.send(data)

// Thinking indicator ephemeral state (DOM-local, not in stores)
const firstChunkSeen = new Set<string>()

// === Lazy imports ===

const lazyFlowEditor = async (
  agents: Map<string, AgentInfo>, myAgentId: string,
  onSave: (name: string, steps: ReadonlyArray<{ agentId: string; agentName: string; stepPrompt?: string }>, loop: boolean, description?: string) => void,
) => {
  const { openFlowEditorModal } = await import('./flow-editor.ts')
  openFlowEditorModal(agents, myAgentId, onSave)
}

const lazySkillEditor = async (name?: string) => {
  const { openSkillEditor } = await import('./skill-editor.ts')
  openSkillEditor(name, () => { $skillsLoaded.set(false); loadSkillsList() })
}

// === Action helpers ===

const handleDeleteRoom = (roomId: string, roomName: string): void => {
  if (!confirm(`Delete room "${roomName}"? This cannot be undone.`)) return
  send({ type: 'delete_room', roomName })
}

const handlePin = (msgId: string, senderName: string, content: string): void => {
  $pinnedMessages.setKey(msgId, { senderId: '', content, senderName })
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

const showContextModal = (context: AgentContext, warnings?: string[]): void => {
  const modal = createModal({ title: 'Prompt Context', width: 'max-w-3xl' })
  const headerEl = document.createElement('div')
  headerEl.className = 'text-xs text-gray-500 mb-3'
  headerEl.textContent = `Model: ${context.model} | Temperature: ${context.temperature ?? 'default'} | Tools: ${context.toolCount}`
  modal.body.appendChild(headerEl)
  // Warnings
  if (warnings && warnings.length > 0) {
    const warnBox = document.createElement('div')
    warnBox.className = 'text-xs text-amber-700 bg-amber-50 rounded p-2 mb-3 space-y-0.5'
    for (const w of warnings) {
      const line = document.createElement('div')
      line.textContent = `\u26a0 ${w}`
      warnBox.appendChild(line)
    }
    modal.body.appendChild(warnBox)
  }
  for (const msg of context.messages) {
    const section = document.createElement('div')
    section.className = 'mb-3'
    const roleLabel = document.createElement('div')
    roleLabel.className = 'text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1 border-b border-gray-100 pb-1'
    roleLabel.textContent = msg.role
    const content = document.createElement('pre')
    content.className = 'text-xs text-gray-700 whitespace-pre-wrap font-mono bg-gray-50 rounded p-2 max-h-64 overflow-y-auto'
    content.textContent = msg.content
    section.appendChild(roleLabel)
    section.appendChild(content)
    modal.body.appendChild(section)
  }
  document.body.appendChild(modal.overlay)
}

const handleViewContext = (msgId: string): void => {
  const ctx = $messageContexts.get()[msgId]
  if (ctx) {
    showContextModal(ctx, $messageWarnings.get()[msgId])
  } else {
    showToast(document.body, 'Prompt context not captured for this message (e.g. older message or after page reload).', { position: 'fixed' })
  }
}

const submitArtifact = (): void => {
  const roomId = $selectedRoomId.get()
  if (!roomId) return
  const roomName = roomIdToName(roomId)
  if (!roomName) return
  const title = artifactInput.value.trim()
  if (!title) return
  const artifactType = artifactTypeSelect.value
  const defaultBodies: Record<string, Record<string, unknown>> = {
    task_list: { tasks: [] },
    document: { blocks: [] },
    poll: { question: '', options: [{ id: '1', text: 'Option 1' }, { id: '2', text: 'Option 2' }], allowMultiple: false, votes: {} },
    mermaid: { source: 'graph TD\n  A-->B' },
  }
  send({ type: 'add_artifact', artifactType, title, body: defaultBodies[artifactType] ?? {}, scope: [roomName] })
  artifactInput.value = ''
}

// === Data fetching (triggered by subscriptions) ===

const fetchRoomMessages = async (roomId: string, roomName: string): Promise<void> => {
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(roomName)}?limit=50`)
    if (!res.ok) return
    const data = await res.json() as { profile: RoomProfile; messages: UIMessage[] }
    $roomMessages.setKey(data.profile.id, data.messages)
  } catch { /* ignore */ }
}

const fetchRoomMembers = async (roomId: string, roomName: string): Promise<void> => {
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(roomName)}/members`)
    if (!res.ok) return
    const members = await res.json() as Array<{ id: string }>
    $roomMembers.setKey(roomId, members.map(m => m.id))
  } catch { /* ignore */ }
}

const fetchArtifactsForRoom = async (roomId: string, roomName: string): Promise<void> => {
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(roomName)}/artifacts`)
    if (!res.ok) return
    const artifacts = await res.json() as ArtifactInfo[]
    for (const a of artifacts) $artifacts.setKey(a.id, a)
  } catch { /* ignore */ }
}

// === Mode selector rendering ===

const refreshModeSelector = (): void => {
  modeSelector.innerHTML = ''
  const modes = [
    { value: 'broadcast', label: 'Broadcast' },
    { value: 'manual', label: 'Manual' },
  ]
  for (const m of modes) {
    const opt = document.createElement('option')
    opt.value = m.value
    opt.textContent = m.label
    modeSelector.appendChild(opt)
  }
  // Flow options
  const roomId = $selectedRoomId.get()
  const artifacts = roomId ? $selectedRoomArtifacts.get().filter(a => !a.resolvedAt && a.type === 'flow') : []
  const sep = document.createElement('option')
  sep.disabled = true
  sep.textContent = '── Flows ──'
  modeSelector.appendChild(sep)
  for (const flow of artifacts) {
    const flowBody = flow.body as { loop?: boolean }
    const opt = document.createElement('option')
    opt.value = `flow:${flow.id}`
    opt.textContent = `${flow.title}${flowBody.loop ? ' ↻' : ''}`
    modeSelector.appendChild(opt)
  }
  const createOpt = document.createElement('option')
  createOpt.value = '__create_flow__'
  createOpt.textContent = '+ Create Flow'
  modeSelector.appendChild(createOpt)

  const mode = $currentDeliveryMode.get()
  if (mode === 'flow') {
    const activeFlowOpt = Array.from(modeSelector.options).find(o => o.value.startsWith('flow:'))
    if (activeFlowOpt) modeSelector.value = activeFlowOpt.value
  } else {
    modeSelector.value = mode
  }

  const paused = $roomPaused.get()
  pauseToggle.textContent = paused ? '▶' : '⏸'
  pauseToggle.title = paused ? 'Resume delivery' : 'Pause delivery'
  pauseToggle.className = `w-6 h-6 flex items-center justify-center text-sm rounded hover:bg-gray-200 ${paused ? 'text-green-600' : 'text-gray-400'}`
  modeSelector.disabled = paused
  modeSelector.classList.toggle('opacity-50', paused)
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

const loadSkillsList = async (): Promise<void> => {
  $skillsLoaded.set(true)
  const skills = await fetch('/api/skills').then(r => r.ok ? r.json() : []).catch(() => []) as Array<{ name: string; description: string; tools: string[] }>
  $skillCount.set(skills.length)
  updateSkillsLabel(!skillsList.classList.contains('hidden'))
  skillsList.innerHTML = ''
  for (const s of skills) {
    const row = document.createElement('div')
    row.className = 'px-3 py-1 cursor-pointer hover:bg-gray-50'
    row.onclick = () => lazySkillEditor(s.name)
    const name = document.createElement('div')
    name.className = 'text-xs font-medium text-gray-700'
    name.textContent = s.name
    const desc = document.createElement('div')
    desc.className = 'text-xs text-gray-400 truncate'
    desc.textContent = s.description
    row.appendChild(name); row.appendChild(desc)
    skillsList.appendChild(row)
  }
  if (skills.length === 0) skillsList.innerHTML = '<div class="text-xs text-gray-400 px-3 py-1">No skills</div>'
}

let roomsSectionExpanded = true
let agentsSectionExpanded = true

const updateAgentsLabel = () => {
  agentsToggle.textContent = `${agentsSectionExpanded ? '▾' : '▸'} Agents (${Object.keys($agents.get()).length})`
}

const updateToolsLabel = (expanded: boolean) => {
  const count = $toolCount.get()
  toolsToggle.textContent = `${expanded ? '▾' : '▸'} Tools${count > 0 ? ` (${count})` : ''}`
}

const updateSkillsLabel = (expanded: boolean) => {
  const count = $skillCount.get()
  skillsToggle.textContent = `${expanded ? '▾' : '▸'} Skills${count > 0 ? ` (${count})` : ''}`
}

// Fetch counts eagerly
void fetch('/api/tools').then(r => r.ok ? r.json() : []).then((t: unknown[]) => { $toolCount.set(t.length); updateToolsLabel(false) }).catch(() => {})
void fetch('/api/skills').then(r => r.ok ? r.json() : []).then((s: unknown[]) => { $skillCount.set(s.length); updateSkillsLabel(false) }).catch(() => {})

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
    fetchArtifactsForRoom(roomId, room.name)

    // Render messages — stamp roomId on the container for defensive checks
    messagesDiv.innerHTML = ''
    messagesDiv.setAttribute('data-room-id', roomId)
    messagesDiv.style.scrollBehavior = 'auto'
    const cached = $roomMessages.get()[roomId]
    if (cached) {
      for (const m of cached) renderMessage({
        container: messagesDiv, msg: m, myAgentId: $myAgentId.get() ?? '',
        agents: $agents.get() as unknown as Record<string, AgentInfo>,
        onPin: handlePin, onDelete: handleDeleteMessage, onViewContext: handleViewContext, onBookmark: handleBookmark,
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
    refreshModeSelector()
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
        onPin: handlePin, onDelete: handleDeleteMessage, onViewContext: handleViewContext, onBookmark: handleBookmark,
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

// --- Thinking preview content ---

$thinkingPreviews.listen((previews, _old, changedId) => {
  if (!changedId) return
  const agentName = agentIdToName(changedId)
  if (!agentName) return
  // First chunk → switch label from "Sending to model..." to "Generating..."
  if (!firstChunkSeen.has(changedId)) {
    firstChunkSeen.add(changedId)
    updateThinkingLabel(messagesDiv, agentName, `${agentName}: Generating...`)
  }
  updateThinkingPreview(messagesDiv, agentName, previews[changedId] ?? '')
})

$thinkingTools.listen((tools, _old, changedId) => {
  if (!changedId) return
  const agentName = agentIdToName(changedId)
  if (!agentName) return
  const toolText = tools[changedId] ?? ''
  if (toolText === '__thinking__') {
    // Model is in CoT thinking phase — update label, style preview as dimmed
    updateThinkingLabel(messagesDiv, agentName, `${agentName}: Thinking...`)
    updateThinkingPreviewStyle(messagesDiv, agentName, true)
  } else if (toolText === '') {
    // Thinking phase ended, response starting — update label, restore normal style
    updateThinkingLabel(messagesDiv, agentName, `${agentName}: Generating...`)
    updateThinkingPreviewStyle(messagesDiv, agentName, false)
    firstChunkSeen.add(changedId) // treat as first chunk seen
  } else {
    updateThinkingTool(messagesDiv, agentName, toolText)
    if (toolText.endsWith('...')) {
      updateThinkingLabel(messagesDiv, agentName, `${agentName}: ${toolText}`)
    } else {
      updateThinkingLabel(messagesDiv, agentName, `${agentName}: Generating...`)
    }
  }
})

// --- Prompt context (for inspector icon on thinking indicator) ---
$agentContexts.listen((contexts, _old, changedId) => {
  if (!changedId) return
  const agentName = agentIdToName(changedId)
  if (!agentName) return
  const ctx = contexts[changedId]
  if (ctx) {
    // Context ready → waiting for LLM to start generating (prefill phase)
    updateThinkingLabel(messagesDiv, agentName, `${agentName}: Waiting for ${ctx.model}...`)
    showContextIcon(messagesDiv, agentName, () => showContextModal(ctx, $agentWarnings.get()[changedId]))
  }
})

// --- Eval warnings (context trimming, LLM errors, retries) ---
$agentWarnings.listen((warnings, _old, changedId) => {
  if (!changedId) return
  const agentName = agentIdToName(changedId)
  if (!agentName) return
  const msgs = warnings[changedId] ?? []
  // Show the latest warning (new ones are appended)
  if (msgs.length > 0) {
    addThinkingWarning(messagesDiv, agentName, msgs[msgs.length - 1]!)
  }
})

// --- Artifacts → workspace ---
$selectedRoomArtifacts.subscribe((artifacts) => {
  const roomId = $selectedRoomId.get()
  if (!roomId) return
  const active = artifacts.filter(a => !a.resolvedAt)
  workspace.setCount(active.length)
  workspaceAddRow.classList.toggle('hidden', workspace.getMode() === 'collapsed')
  if (workspace.getMode() !== 'collapsed') {
    if (active.length > 0) {
      renderArtifacts(workspaceContent, active, $myAgentId.get() ?? '', handleArtifactAction)
    } else {
      workspaceContent.innerHTML = '<p class="text-xs text-gray-400 italic py-0.5">No artifacts yet</p>'
    }
  }
  // Update mode selector (flow artifacts may have changed)
  refreshModeSelector()
})

// --- Mode / turn / flow info (batched: mode + pause + artifacts all feed mode selector) ---
// Note: $selectedRoomArtifacts subscription also calls refreshModeSelector for flow changes.
// This batched subscription handles mode/pause state changes.
const $modeView = batched(
  [$currentDeliveryMode, $roomPaused],
  (mode: string, paused: boolean) => ({ mode, paused }),
)
$modeView.listen(() => refreshModeSelector())

$turnInfo.listen((info) => {
  if (info?.agentName) {
    roomModeInfo.textContent = `Turn: ${info.agentName}${info.waitingForHuman ? ' (waiting for input)' : ''}`
    roomModeInfo.className = 'text-xs text-blue-500 h-4 font-medium'
  }
})

$flowStatus.listen((status) => {
  if (!status) return
  if (status.event === 'step') {
    const detail = status.detail
    roomModeInfo.textContent = `Flow step ${((detail?.stepIndex as number) ?? 0) + 1}: ${detail?.agentName ?? '...'}`
    roomModeInfo.className = 'text-xs text-purple-500 h-4 font-medium'
  } else if (status.event === 'completed') {
    refreshModeSelector()
  }
})

// --- Pinned messages ---
$pinnedMessages.subscribe((pinned) => {
  const entries = Object.entries(pinned)
  if (entries.length === 0) {
    pinnedMessagesDiv.classList.add('hidden')
    return
  }
  pinnedMessagesDiv.classList.remove('hidden')
  pinnedMessagesDiv.innerHTML = ''
  for (const [id, data] of entries) {
    const row = document.createElement('div')
    row.className = 'px-3 py-1 text-xs flex items-center gap-2 border-b border-amber-100'
    const preview = data.content.length > 100 ? data.content.slice(0, 100) + '…' : data.content
    row.innerHTML = `<span class="text-amber-600">📌</span> <span class="font-medium">${data.senderName ?? 'unknown'}:</span> <span class="text-gray-600 flex-1 truncate">${preview}</span>`
    const unpin = document.createElement('button')
    unpin.className = 'text-amber-400 hover:text-amber-600 text-xs'
    unpin.textContent = '✕'
    unpin.onclick = () => {
      const current = { ...$pinnedMessages.get() }
      delete current[id]
      $pinnedMessages.set(current)
    }
    row.appendChild(unpin)
    pinnedMessagesDiv.appendChild(row)
  }
})

// --- Connection state ---
$connected.listen((connected) => {
  chatInput.disabled = !connected
  if (connected) chatForm.querySelector('button')!.removeAttribute('disabled')
})

// --- Sidebar collapse ---
$sidebarCollapsed.subscribe((collapsed) => {
  sidebar.classList.toggle('sidebar-collapsed', collapsed)
  btnCollapseSidebar.textContent = collapsed ? '▶' : '◀'
  localStorage.setItem('samsinn-sidebar-collapsed', String(collapsed))
})

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

  const selectedMode = modeSelector.value
  if (selectedMode.startsWith('flow:')) {
    send({ type: 'start_flow', roomName, flowArtifactId: selectedMode.slice(5), content })
    chatInput.value = ''
    chatInput.placeholder = 'Type a message...'
    return
  }
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

pauseToggle.onclick = () => {
  const roomId = $selectedRoomId.get()
  if (!roomId) return
  const roomName = roomIdToName(roomId)
  if (!roomName) return
  send({ type: 'set_paused', roomName, paused: !$roomPaused.get() })
}

modeSelector.onchange = () => {
  const roomId = $selectedRoomId.get()
  if (!roomId) return
  const roomName = roomIdToName(roomId)
  if (!roomName) return
  const val = modeSelector.value

  if (val === '__create_flow__') {
    refreshModeSelector()
    const agentsMap = new Map(Object.entries($agents.get()).map(([id, a]) => [id, a as AgentInfo]))
    lazyFlowEditor(agentsMap, $myAgentId.get() ?? '', (name, steps, loop, description) => {
      send({ type: 'add_artifact', artifactType: 'flow', title: name, body: { steps, loop }, scope: [roomName], ...(description !== undefined ? { description } : {}) })
    })
    return
  }
  if (val.startsWith('flow:')) {
    const content = chatInput.value.trim()
    if (!content) { chatInput.placeholder = 'Type a message to start the flow...'; chatInput.focus(); return }
    send({ type: 'start_flow', roomName, flowArtifactId: val.slice(5), content })
    chatInput.value = ''; chatInput.placeholder = 'Type a message...'
    return
  }
  send({ type: 'set_delivery_mode', roomName, mode: val })
}

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

btnArtifactSubmit.onclick = (e) => { e.stopPropagation(); submitArtifact() }
artifactInput.onkeydown = (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submitArtifact() }
  if (e.key === 'Escape') { artifactInput.value = ''; artifactInput.blur() }
}

// Sidebar section toggles
roomsHeader.onclick = (e) => {
  if ((e.target as HTMLElement).closest('button')) return
  roomsSectionExpanded = !roomsSectionExpanded
  roomList.classList.toggle('hidden', !roomsSectionExpanded)
  roomsToggle.textContent = `${roomsSectionExpanded ? '▾' : '▸'} Rooms (${Object.keys($rooms.get()).length})`
}

agentsHeader.onclick = () => {
  agentsSectionExpanded = !agentsSectionExpanded
  agentList.classList.toggle('hidden', !agentsSectionExpanded)
  updateAgentsLabel()
}

toolsHeader.onclick = async () => {
  const nowHidden = toolsList.classList.toggle('hidden')
  updateToolsLabel(!nowHidden)
  if (!nowHidden && !$toolsLoaded.get()) {
    $toolsLoaded.set(true)
    const tools = await fetch('/api/tools').then(r => r.ok ? r.json() : []).catch(() => []) as Array<{ name: string; description: string }>
    $toolCount.set(tools.length)
    updateToolsLabel(true)
    toolsList.innerHTML = ''
    for (const t of tools) {
      const row = document.createElement('div')
      row.className = 'text-xs text-gray-600 py-0.5 px-3 hover:bg-gray-50 cursor-default truncate'
      row.title = t.description; row.textContent = t.name
      toolsList.appendChild(row)
    }
    if (tools.length === 0) toolsList.innerHTML = '<div class="text-xs text-gray-400 px-3 py-1">No tools</div>'
  }
}

skillsHeader.onclick = async (e) => {
  if ((e.target as HTMLElement).closest('button')) return
  const nowHidden = skillsList.classList.toggle('hidden')
  updateSkillsLabel(!nowHidden)
  if (!nowHidden && !$skillsLoaded.get()) await loadSkillsList()
}

document.getElementById('btn-create-skill')!.onclick = (e) => { e.stopPropagation(); lazySkillEditor() }

btnCollapseSidebar.onclick = () => $sidebarCollapsed.set(!$sidebarCollapsed.get())

// Prompt editing
const btnSystemPrompt = $('#btn-system-prompt') as HTMLButtonElement
btnSystemPrompt.onclick = () => {
  fetch('/api/house/prompts')
    .then(r => r.ok ? r.json() : null)
    .then((data: { housePrompt?: string; responseFormat?: string } | null) => {
      if (!data) return
      const modal = createModal({ title: '', width: 'max-w-2xl' })
      const titleRow = modal.body.querySelector('div')
      if (titleRow) {
        const titleEl = titleRow.querySelector('h3')
        if (titleEl) { titleEl.className = 'text-xs font-semibold text-gray-400 uppercase tracking-wide'; titleEl.textContent = 'System Prompt' }
      }
      const houseArea = createTextarea(data.housePrompt ?? '', 6)
      modal.body.appendChild(houseArea)
      const formatLabel = document.createElement('div')
      formatLabel.className = 'text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1 mt-3'
      formatLabel.textContent = 'Response Format'
      modal.body.appendChild(formatLabel)
      const formatArea = createTextarea(data.responseFormat ?? '', 6)
      modal.body.appendChild(formatArea)
      const btnRow = document.createElement('div')
      btnRow.className = 'flex justify-end mt-3 relative'
      const updateBtn = document.createElement('button')
      updateBtn.className = 'text-xs px-3 py-1 bg-gray-300 text-white rounded cursor-not-allowed'
      updateBtn.textContent = 'Update'
      btnRow.appendChild(updateBtn)
      modal.body.appendChild(btnRow)
      let savedHouse = houseArea.value; let savedFormat = formatArea.value
      const isDirty = () => houseArea.value !== savedHouse || formatArea.value !== savedFormat
      const updateStyle = () => {
        updateBtn.className = isDirty()
          ? 'text-xs px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 cursor-pointer'
          : 'text-xs px-3 py-1 bg-gray-300 text-white rounded cursor-not-allowed'
      }
      houseArea.oninput = updateStyle; formatArea.oninput = updateStyle
      updateBtn.onclick = async () => {
        if (!isDirty()) return
        await fetch('/api/house/prompts', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ housePrompt: houseArea.value, responseFormat: formatArea.value }) }).catch(() => {})
        savedHouse = houseArea.value; savedFormat = formatArea.value; updateStyle()
        showToast(btnRow, 'Prompts updated')
      }
      document.body.appendChild(modal.overlay)
    })
}

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
    send,
    getSelectedRoomName: () => {
      const rid = $selectedRoomId.get()
      return rid ? roomIdToName(rid) ?? undefined : undefined
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

// Providers dashboard — Ollama wiring + cloud providers panel
wireOllamaDashboard(ollamaEls, send)

document.getElementById('btn-ollama-dashboard')!.onclick = async () => {
  await openOllamaDashboard(ollamaEls, send)
  void startProvidersPanel()
}

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

if (savedName) {
  $myName.set(savedName)
  connect(savedName)
} else {
  nameModal.showModal()
}
