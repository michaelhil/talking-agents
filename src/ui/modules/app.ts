// ============================================================================
// samsinn — UI Application
//
// Orchestrator: connects WS client, delegates rendering, handles events.
// No framework, no build step. Served as transpiled JS by the server.
// ============================================================================

import { createWSClient, type WSClient } from './ws-client.ts'
import {
  renderRooms,
  renderAgents,
  renderMessage,
  renderArtifacts,
  renderThinkingIndicator,
  removeThinkingIndicator,
  type UIMessage,
  type RoomProfile,
  type AgentInfo,
  type ArtifactInfo,
  type ArtifactAction,
} from './ui-renderer.ts'
import { openTextEditorModal, createModal, createButtonRow, createTextarea } from './modal.ts'
import { createWorkspace } from './workspace.ts'

// Lazy-loaded modals — only fetched on first use
const lazyFlowEditor = async (
  agents: Map<string, AgentInfo>, myAgentId: string,
  onSave: (name: string, steps: ReadonlyArray<{ agentId: string; agentName: string; stepPrompt?: string }>, loop: boolean, description?: string) => void,
) => {
  const { openFlowEditorModal } = await import('./flow-editor.ts')
  openFlowEditorModal(agents, myAgentId, onSave)
}
const selectAgentByName = async (agentName: string) => {
  // Find agent ID from name
  for (const [id, a] of agents) {
    if (a.name === agentName) { selectAgent(id); return }
  }
}

// === WS Protocol Types ===

type WSOutbound =
  | { type: 'snapshot'; rooms: RoomProfile[]; agents: AgentInfo[]; agentId: string; sessionToken?: string }
  | { type: 'message'; message: UIMessage }
  | { type: 'agent_state'; agentName: string; state: string; context?: string }
  | { type: 'room_created'; profile: RoomProfile }
  | { type: 'agent_joined'; agent: AgentInfo }
  | { type: 'agent_removed'; agentName: string }
  | { type: 'error'; message: string }
  | { type: 'delivery_mode_changed'; roomName: string; mode: string; paused: boolean }
  | { type: 'mute_changed'; roomName: string; agentName: string; muted: boolean }
  | { type: 'turn_changed'; roomName: string; agentName?: string; waitingForHuman?: boolean }
  | { type: 'flow_event'; roomName: string; event: string; detail?: Record<string, unknown> }
  | { type: 'artifact_changed'; action: 'added' | 'updated' | 'removed'; artifact: ArtifactInfo }
  | { type: 'membership_changed'; roomId: string; roomName: string; agentId: string; agentName: string; action: 'added' | 'removed' }
  | { type: 'room_deleted'; roomName: string }
  | { type: 'message_deleted'; roomName: string; messageId: string }
  | { type: 'messages_cleared'; roomName: string }

// === State ===

let client: WSClient | null = null
let myAgentId = ''
let myName = ''
let sessionToken = localStorage.getItem('ta_session') ?? ''
let selectedRoomId = ''
let selectedAgentId = ''
let currentDeliveryMode = 'broadcast'
const rooms = new Map<string, RoomProfile>()
const agents = new Map<string, AgentInfo>()
const roomMessages = new Map<string, UIMessage[]>()
const agentStates = new Map<string, { state: string; context?: string }>()
const mutedAgents = new Set<string>()  // agent names that are muted in current room
const unreadCounts = new Map<string, number>()  // roomId → unread message count
let roomPaused = false
const pausedRooms = new Set<string>()  // room IDs that are paused

// Artifact state — flat map keyed by artifact ID (all rooms)
const allArtifacts = new Map<string, ArtifactInfo>()

const getArtifactsForRoom = (roomId: string): ArtifactInfo[] =>
  [...allArtifacts.values()].filter(a => !a.resolvedAt && (a.scope.length === 0 || a.scope.includes(roomId)))

// Membership state per room
const roomMembers = new Map<string, Set<string>>()  // roomId → Set<agentId>

// === DOM refs ===

const $ = (sel: string) => document.querySelector(sel)!
const roomList = $('#room-list') as HTMLElement
const roomHeader = $('#room-header') as HTMLElement
const roomNameEl = $('#room-name') as HTMLElement
const roomInfoBar = $('#room-info-bar') as HTMLElement
const roomsToggle = $('#rooms-toggle') as HTMLElement
const roomsHeader = $('#rooms-header') as HTMLElement
const agentList = $('#agent-list') as HTMLElement
const noRoomState = $('#no-room-state') as HTMLElement
const agentArea = $('#agent-area') as HTMLElement
const chatArea = $('#chat-area') as HTMLElement
const pinnedMessagesDiv = $('#pinned-messages') as HTMLElement
const workspaceBar = $('#workspace-bar') as HTMLElement
const workspacePane = $('#workspace-pane') as HTMLElement
const workspaceContent = $('#workspace-content') as HTMLElement
const workspaceLabel = $('#workspace-label') as HTMLElement
const workspaceAddRow = $('#workspace-add-row') as HTMLElement
const artifactInput = $('#artifact-input') as HTMLInputElement
const btnArtifactSubmit = $('#btn-artifact-submit') as HTMLElement
const messagesDiv = $('#messages') as HTMLElement
const chatForm = $('#chat-form') as HTMLFormElement
const chatInput = $('#chat-input') as HTMLInputElement
// Thinking indicator timers (for cleanup)
const thinkingTimers = new Map<string, number>()
// Connection status removed — user identified by bold name in agent list
const modeSelector = $('#mode-selector') as HTMLSelectElement
const pauseToggle = $('#btn-pause-toggle') as HTMLButtonElement
const roomModeInfo = $('#room-mode-info') as HTMLElement
// flowSelector removed — flows are now in the mode selector dropdown
const nameModal = $('#name-modal') as HTMLDialogElement
const nameForm = $('#name-form') as HTMLFormElement
const roomModal = $('#room-modal') as HTMLDialogElement
const roomForm = $('#room-form') as HTMLFormElement
const agentModal = $('#agent-modal') as HTMLDialogElement
const agentForm = $('#agent-form') as HTMLFormElement

// Sidebar
const sidebar = $('#sidebar') as HTMLElement
const btnCollapseSidebar = $('#btn-collapse-sidebar') as HTMLElement
const settingsHeader = $('#settings-header') as HTMLElement
const settingsToggle = $('#settings-toggle') as HTMLElement
const settingsList = $('#settings-list') as HTMLElement
const agentsHeader = $('#agents-header') as HTMLElement
const agentsToggle = $('#agents-toggle') as HTMLElement
const toolsHeader = $('#tools-header') as HTMLElement
const toolsToggle = $('#tools-toggle') as HTMLElement
const toolsList = $('#tools-list') as HTMLElement
const skillsHeader = $('#skills-header') as HTMLElement
const skillsToggle = $('#skills-toggle') as HTMLElement
const skillsList = $('#skills-list') as HTMLElement

// Workspace
const workspace = createWorkspace({ bar: workspaceBar, pane: workspacePane, chatArea, label: workspaceLabel })

// Pinned messages state
const pinnedMessageIds = new Set<string>()
const pinnedMessageData = new Map<string, { senderId: string; content: string; senderName?: string }>()

// === Render helpers (delegate to ui-renderer) ===

const send = (data: unknown) => client?.send(data)

const handleDeleteRoom = (roomId: string, roomName: string): void => {
  if (!confirm(`Delete room "${roomName}"? This cannot be undone.`)) return
  send({ type: 'delete_room', roomName })
}
const getGeneratingRoomIds = (): Set<string> => {
  const ids = new Set<string>()
  for (const [, info] of agentStates) {
    if (info.state === 'generating' && info.context) ids.add(info.context)
  }
  return ids
}

const refreshRooms = () => {
  renderRooms(roomList, rooms, selectedRoomId, pausedRooms, selectRoom, handleDeleteRoom, unreadCounts, getGeneratingRoomIds())
  roomsToggle.textContent = `▾ Rooms (${rooms.size})`
}

const refreshAgents = () => {
  const room = rooms.get(selectedRoomId)
  const memberIds = room ? roomMembers.get(room.id) : undefined
  renderAgents(
    agentList, agents, agentStates, mutedAgents, myAgentId, selectedAgentId,
    (name, muted) => {
      if (room) send({ type: 'set_muted', roomName: room.name, agentName: name, muted })
    },
    (name) => selectAgentByName(name),
    memberIds,
    room ? (_agentId, agentName) => send({ type: 'add_to_room', roomName: room.name, agentName }) : undefined,
    room ? (_agentId, agentName) => send({ type: 'remove_from_room', roomName: room.name, agentName }) : undefined,
  )
  updateAgentsLabel()
}

const refreshModeSelector = (): void => {
  modeSelector.innerHTML = ''

  // Delivery modes
  const modes = [
    { value: 'broadcast', label: 'Broadcast' },
  ]
  for (const m of modes) {
    const opt = document.createElement('option')
    opt.value = m.value
    opt.textContent = m.label
    modeSelector.appendChild(opt)
  }

  // Flow options (from artifact store)
  const room = rooms.get(selectedRoomId)
  const flowArtifacts = room ? getArtifactsForRoom(room.id).filter(a => a.type === 'flow') : []
  // Flow separator and options — always shown
  const sep = document.createElement('option')
  sep.disabled = true
  sep.textContent = '── Flows ──'
  modeSelector.appendChild(sep)

  for (const flow of flowArtifacts) {
    const flowBody = flow.body as { loop?: boolean }
    const opt = document.createElement('option')
    opt.value = `flow:${flow.id}`
    opt.textContent = `▶ ${flow.title}${flowBody.loop ? ' ↻' : ''}`
    modeSelector.appendChild(opt)
  }

  const createOpt = document.createElement('option')
  createOpt.value = '__create_flow__'
  createOpt.textContent = '+ Create Flow'
  modeSelector.appendChild(createOpt)

  // Set selected value
  if (currentDeliveryMode === 'flow') {
    const activeFlowOpt = Array.from(modeSelector.options).find(o => o.value.startsWith('flow:'))
    if (activeFlowOpt) modeSelector.value = activeFlowOpt.value
  } else {
    modeSelector.value = currentDeliveryMode
  }

  // Pause toggle state
  pauseToggle.textContent = roomPaused ? '▶' : '⏸'
  pauseToggle.title = roomPaused ? 'Resume delivery' : 'Pause delivery'
  pauseToggle.className = `w-6 h-6 flex items-center justify-center text-sm rounded hover:bg-gray-200 ${roomPaused ? 'text-green-600' : 'text-gray-400'}`
  modeSelector.disabled = roomPaused
  modeSelector.classList.toggle('opacity-50', roomPaused)
}

const fetchArtifactsForRoom = async (room: RoomProfile): Promise<void> => {
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(room.name)}/artifacts`)
    if (!res.ok) return
    const artifacts = await res.json() as ArtifactInfo[]
    for (const a of artifacts) allArtifacts.set(a.id, a)
    refreshWorkspace(room)
    refreshModeSelector()
  } catch { /* ignore */ }
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

const refreshWorkspace = (room: RoomProfile): void => {
  const artifacts = getArtifactsForRoom(room.id)
  workspace.setCount(artifacts.length)
  workspace.show()
  workspaceAddRow.classList.toggle('hidden', workspace.getMode() === 'collapsed')

  if (workspace.getMode() !== 'collapsed') {
    if (artifacts.length > 0) {
      renderArtifacts(workspaceContent, artifacts, myAgentId, handleArtifactAction)
    } else {
      workspaceContent.innerHTML = '<p class="text-xs text-gray-400 italic py-0.5">No artifacts yet</p>'
    }
  }
}

const artifactTypeSelect = $('#artifact-type-select') as HTMLSelectElement

const defaultBodies: Record<string, Record<string, unknown>> = {
  task_list: { tasks: [] },
  document: { blocks: [] },
  poll: { question: '', options: [{ id: '1', text: 'Option 1' }, { id: '2', text: 'Option 2' }], allowMultiple: false, votes: {} },
  mermaid: { source: 'graph TD\n  A-->B' },
}

const submitArtifact = (): void => {
  const room = rooms.get(selectedRoomId)
  if (!room) return
  const title = artifactInput.value.trim()
  if (!title) return
  const artifactType = artifactTypeSelect.value
  const body = defaultBodies[artifactType] ?? {}
  send({ type: 'add_artifact', artifactType, title, body, scope: [room.name] })
  artifactInput.value = ''
}

btnArtifactSubmit.onclick = (e) => {
  e.stopPropagation()
  submitArtifact()
}

artifactInput.onkeydown = (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submitArtifact() }
  if (e.key === 'Escape') { artifactInput.value = ''; artifactInput.blur() }
}

// --- Settings section ---
settingsHeader.onclick = () => {
  const nowHidden = settingsList.classList.toggle('hidden')
  settingsToggle.textContent = nowHidden ? '▸ Settings' : '▾ Settings'
}

// --- Ollama URL management ---
const ollamaUrlSelect = $('#ollama-url-select') as HTMLSelectElement
const ollamaUrlInput = $('#ollama-url-input') as HTMLInputElement
const btnOllamaUrlAdd = $('#btn-ollama-url-add') as HTMLElement
const btnOllamaUrlDelete = $('#btn-ollama-url-delete') as HTMLElement

const refreshOllamaUrls = async (): Promise<void> => {
  const data = await fetch('/api/ollama/urls').then(r => r.ok ? r.json() : null).catch(() => null) as { current: string; saved: string[] } | null
  if (!data) return
  ollamaUrlSelect.innerHTML = ''
  for (const url of data.saved) {
    const opt = document.createElement('option')
    opt.value = url
    opt.textContent = url
    if (url === data.current) opt.selected = true
    ollamaUrlSelect.appendChild(opt)
  }
}

ollamaUrlSelect.onchange = async () => {
  if (!ollamaUrlSelect.value) return
  await fetch('/api/ollama/urls', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: ollamaUrlSelect.value }),
  })
}

btnOllamaUrlAdd.onclick = async () => {
  const url = ollamaUrlInput.value.trim()
  if (!url) return
  await fetch('/api/ollama/urls', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  ollamaUrlInput.value = ''
  await refreshOllamaUrls()
}

btnOllamaUrlDelete.onclick = async () => {
  const url = ollamaUrlSelect.value
  if (!url) return
  await fetch('/api/ollama/urls', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  await refreshOllamaUrls()
}

// --- Collapsible sidebar sections ---
let roomsSectionExpanded = true
let agentsSectionExpanded = true
let toolsLoaded = false
let skillsLoaded = false
let toolCount = 0
let skillCount = 0

const updateAgentsLabel = () => {
  const arrow = agentsSectionExpanded ? '▾' : '▸'
  agentsToggle.textContent = `${arrow} Agents (${agents.size})`
}

const updateToolsLabel = (expanded: boolean) => {
  toolsToggle.textContent = `${expanded ? '▾' : '▸'} Tools${toolCount > 0 ? ` (${toolCount})` : ''}`
}

const updateSkillsLabel = (expanded: boolean) => {
  skillsToggle.textContent = `${expanded ? '▾' : '▸'} Skills${skillCount > 0 ? ` (${skillCount})` : ''}`
}

// Fetch counts eagerly on load
void fetch('/api/tools').then(r => r.ok ? r.json() : []).then((t: unknown[]) => { toolCount = t.length; updateToolsLabel(false) }).catch(() => {})
void fetch('/api/skills').then(r => r.ok ? r.json() : []).then((s: unknown[]) => { skillCount = s.length; updateSkillsLabel(false) }).catch(() => {})

roomsHeader.onclick = (e) => {
  if ((e.target as HTMLElement).closest('button')) return // Don't toggle when clicking +
  roomsSectionExpanded = !roomsSectionExpanded
  roomList.classList.toggle('hidden', !roomsSectionExpanded)
  roomsToggle.textContent = `${roomsSectionExpanded ? '▾' : '▸'} Rooms (${rooms.size})`
}

agentsHeader.onclick = () => {
  agentsSectionExpanded = !agentsSectionExpanded
  agentList.classList.toggle('hidden', !agentsSectionExpanded)
  updateAgentsLabel()
}

toolsHeader.onclick = async () => {
  const nowHidden = toolsList.classList.toggle('hidden')
  updateToolsLabel(!nowHidden)
  if (!nowHidden && !toolsLoaded) {
    toolsLoaded = true
    const tools = await fetch('/api/tools').then(r => r.ok ? r.json() : []).catch(() => []) as Array<{ name: string; description: string }>
    toolCount = tools.length
    updateToolsLabel(true)
    toolsList.innerHTML = ''
    for (const t of tools) {
      const row = document.createElement('div')
      row.className = 'text-xs text-gray-600 py-0.5 px-3 hover:bg-gray-50 cursor-default truncate'
      row.title = t.description
      row.textContent = t.name
      toolsList.appendChild(row)
    }
    if (tools.length === 0) toolsList.innerHTML = '<div class="text-xs text-gray-400 px-3 py-1">No tools</div>'
  }
}

const lazySkillEditor = async (name?: string) => {
  const { openSkillEditor } = await import('./skill-editor.ts')
  openSkillEditor(name, () => { skillsLoaded = false; loadSkillsList() })
}

const loadSkillsList = async (): Promise<void> => {
  skillsLoaded = true
  const skills = await fetch('/api/skills').then(r => r.ok ? r.json() : []).catch(() => []) as Array<{ name: string; description: string; tools: string[] }>
  skillCount = skills.length
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
    row.appendChild(name)
    row.appendChild(desc)
    skillsList.appendChild(row)
  }
  if (skills.length === 0) skillsList.innerHTML = '<div class="text-xs text-gray-400 px-3 py-1">No skills</div>'
}

skillsHeader.onclick = async (e) => {
  if ((e.target as HTMLElement).closest('button')) return
  const nowHidden = skillsList.classList.toggle('hidden')
  updateSkillsLabel(!nowHidden)
  if (!nowHidden && !skillsLoaded) await loadSkillsList()
}

document.getElementById('btn-create-skill')!.onclick = (e) => {
  e.stopPropagation()
  lazySkillEditor()
}

// --- Sidebar collapse ---
const initSidebarCollapse = (): void => {
  const collapsed = localStorage.getItem('samsinn-sidebar-collapsed') === 'true'
  if (collapsed) sidebar.classList.add('sidebar-collapsed')

  btnCollapseSidebar.onclick = () => {
    sidebar.classList.toggle('sidebar-collapsed')
    const isCollapsed = sidebar.classList.contains('sidebar-collapsed')
    btnCollapseSidebar.textContent = isCollapsed ? '▶' : '◀'
    localStorage.setItem('samsinn-sidebar-collapsed', String(isCollapsed))
  }
}
initSidebarCollapse()

// --- Message pinning ---
const refreshPinnedMessages = (): void => {
  if (pinnedMessageIds.size === 0) {
    pinnedMessagesDiv.classList.add('hidden')
    return
  }
  pinnedMessagesDiv.classList.remove('hidden')
  pinnedMessagesDiv.innerHTML = ''
  for (const id of pinnedMessageIds) {
    const data = pinnedMessageData.get(id)
    if (!data) continue
    const row = document.createElement('div')
    row.className = 'px-3 py-1 text-xs flex items-center gap-2 border-b border-amber-100'
    const preview = data.content.length > 100 ? data.content.slice(0, 100) + '…' : data.content
    row.innerHTML = `<span class="text-amber-600">📌</span> <span class="font-medium">${data.senderName ?? 'unknown'}:</span> <span class="text-gray-600 flex-1 truncate">${preview}</span>`
    const unpin = document.createElement('button')
    unpin.className = 'text-amber-400 hover:text-amber-600 text-xs'
    unpin.textContent = '✕'
    unpin.onclick = () => { pinnedMessageIds.delete(id); pinnedMessageData.delete(id); refreshPinnedMessages() }
    row.appendChild(unpin)
    pinnedMessagesDiv.appendChild(row)
  }
}

const handlePin = (msgId: string, senderName: string, content: string): void => {
  pinnedMessageIds.add(msgId)
  pinnedMessageData.set(msgId, { senderId: '', content, senderName })
  refreshPinnedMessages()
}

const handleDeleteMessage = (msgId: string): void => {
  const room = rooms.get(selectedRoomId)
  if (!room) return
  send({ type: 'delete_message', roomName: room.name, messageId: msgId })
  // Remove from DOM immediately
  const msgs = roomMessages.get(selectedRoomId)
  if (msgs) {
    const idx = msgs.findIndex(m => m.id === msgId)
    if (idx !== -1) msgs.splice(idx, 1)
  }
  // Remove the message element from the DOM
  messagesDiv.querySelector(`[data-msg-id="${msgId}"]`)?.remove()
}

const updateModeUI = () => {
  refreshModeSelector()

  if (currentDeliveryMode === 'flow') {
    roomModeInfo.textContent = 'Flow active'
    roomModeInfo.className = 'text-xs text-purple-500 h-4'
  } else {
    roomModeInfo.textContent = ''
    roomModeInfo.className = 'text-xs text-gray-400 h-4'
  }
}

const showThinking = (agentName: string): void => {
  // Only show if agent is generating in the current room
  const state = agentStates.get(agentName)
  if (!state || state.state !== 'generating' || state.context !== selectedRoomId) return
  // Don't duplicate
  if (messagesDiv.querySelector(`[data-thinking-agent="${agentName}"]`)) return
  const { timer } = renderThinkingIndicator(messagesDiv, agentName, (name) => {
    send({ type: 'cancel_generation', name })
  })
  thinkingTimers.set(agentName, timer)
}

const hideThinking = (agentName: string): void => {
  removeThinkingIndicator(messagesDiv, agentName)
  const timer = thinkingTimers.get(agentName)
  if (timer) { clearInterval(timer); thinkingTimers.delete(agentName) }
}

// === Agent selection (inline inspector) ===

const selectAgent = async (agentId: string): Promise<void> => {
  selectedAgentId = agentId
  selectedRoomId = ''

  // Hide room UI
  roomHeader.classList.add('hidden')
  roomInfoBar.classList.add('hidden')
  chatArea.classList.add('hidden')
  workspace.hide()
  noRoomState.classList.add('hidden')

  // Show agent inspector
  agentArea.classList.remove('hidden')
  const agent = agents.get(agentId)
  if (!agent) return

  const { renderAgentInspector } = await import('./agent-inspector.ts')
  renderAgentInspector(agentArea, agent.name)

  refreshRooms()
  refreshAgents()
}

// === Room selection ===

const selectRoom = (roomId: string) => {
  selectedRoomId = roomId
  selectedAgentId = ''
  const room = rooms.get(roomId)
  if (!room) return

  // Hide agent inspector, show chat UI
  agentArea.classList.add('hidden')
  noRoomState.classList.add('hidden')
  roomHeader.classList.remove('hidden')
  roomInfoBar.classList.remove('hidden')
  chatArea.classList.remove('hidden')
  roomNameEl.textContent = room.name

  // Clear unread count for this room
  unreadCounts.delete(roomId)

  refreshRooms()
  updateModeUI()
  refreshWorkspace(room)
  fetchArtifactsForRoom(room)

  messagesDiv.innerHTML = ''
  messagesDiv.style.scrollBehavior = 'auto'
  const cached = roomMessages.get(roomId)
  if (cached) {
    for (const m of cached) renderMessage(messagesDiv, m, myAgentId, agents, handlePin, handleDeleteMessage)
  } else {
    fetchRoomMessages(room.name)
  }
  messagesDiv.scrollTop = messagesDiv.scrollHeight
  requestAnimationFrame(() => { messagesDiv.style.scrollBehavior = '' })
}

const fetchRoomMessages = async (name: string) => {
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(name)}?limit=50`)
    if (!res.ok) return
    const data = await res.json() as { profile: RoomProfile; messages: UIMessage[] }
    roomMessages.set(data.profile.id, data.messages)
    if (selectedRoomId === data.profile.id) {
      messagesDiv.innerHTML = ''
      messagesDiv.style.scrollBehavior = 'auto'
      for (const m of data.messages) renderMessage(messagesDiv, m, myAgentId, agents, handlePin, handleDeleteMessage)
      messagesDiv.scrollTop = messagesDiv.scrollHeight
      requestAnimationFrame(() => { messagesDiv.style.scrollBehavior = '' })
    }
  } catch { /* ignore */ }
}

// === WS message handling ===

const handleMessage = (raw: unknown) => {
  const msg = raw as WSOutbound
  switch (msg.type) {
    case 'snapshot': {
      if (msg.sessionToken) {
        sessionToken = msg.sessionToken
        localStorage.setItem('ta_session', sessionToken)
      }
      myAgentId = msg.agentId
      rooms.clear(); agents.clear(); agentStates.clear(); mutedAgents.clear(); pausedRooms.clear(); roomMembers.clear(); allArtifacts.clear()
      for (const r of msg.rooms) rooms.set(r.id, r)
      for (const a of msg.agents) {
        agents.set(a.id, a)
        if (a.state === 'generating') agentStates.set(a.name, { state: 'generating' })
      }
      // Restore per-room state from snapshot
      if (msg.roomStates) {
        for (const [roomId, rs] of Object.entries(msg.roomStates as Record<string, { mode: string; paused: boolean; muted: string[]; members?: string[] }>)) {
          if (rs.paused) pausedRooms.add(roomId)
          if (rs.members) roomMembers.set(roomId, new Set(rs.members))
        }
      }
      refreshRooms(); refreshAgents()
      if (!selectedRoomId && rooms.size > 0) {
        selectRoom(rooms.values().next().value!.id)
      }
      // Apply selected room state AFTER selectRoom (which may have set selectedRoomId)
      if (msg.roomStates && selectedRoomId && msg.roomStates[selectedRoomId]) {
        const rs2 = msg.roomStates[selectedRoomId] as { mode: string; paused: boolean; muted: string[] }
        currentDeliveryMode = rs2.mode
        roomPaused = rs2.paused
        mutedAgents.clear()
        for (const id of rs2.muted) {
          const agent = agents.get(id)
          if (agent) mutedAgents.add(agent.name)
        }
        updateModeUI()
        refreshRooms()
        refreshAgents()
      }
      break
    }
    case 'message': {
      const m = msg.message
      const roomId = m.roomId ?? `dm:${m.senderId === myAgentId ? m.recipientId : m.senderId}`
      if (!roomMessages.has(roomId)) roomMessages.set(roomId, [])
      const msgs = roomMessages.get(roomId)!
      if (!msgs.some(existing => existing.id === m.id)) {
        msgs.push(m)
        // Hide thinking indicator when agent's message arrives
        const senderAgent = agents.get(m.senderId)
        if (senderAgent && m.type === 'chat') hideThinking(senderAgent.name)
        if (roomId === selectedRoomId) {
          renderMessage(messagesDiv, m, myAgentId, agents, handlePin, handleDeleteMessage)
          messagesDiv.scrollTop = messagesDiv.scrollHeight
        } else {
          // Increment unread counter for rooms not currently viewed
          unreadCounts.set(roomId, (unreadCounts.get(roomId) ?? 0) + 1)
          refreshRooms()
        }
      }
      break
    }
    case 'agent_state': {
      agentStates.set(msg.agentName, { state: msg.state, context: msg.context })
      if (msg.state === 'generating') {
        showThinking(msg.agentName)
      } else {
        hideThinking(msg.agentName)
      }
      refreshAgents()
      refreshRooms()
      break
    }
    case 'room_created': {
      rooms.set(msg.profile.id, msg.profile)
      refreshRooms()
      // Auto-select if no room is currently selected
      if (!selectedRoomId) {
        selectRoom(msg.profile.id)
      }
      break
    }
    case 'agent_joined': {
      agents.set(msg.agent.id, msg.agent)
      refreshAgents()
      break
    }
    case 'agent_removed': {
      for (const [id, agent] of agents) {
        if (agent.name === msg.agentName) { agents.delete(id); break }
      }
      agentStates.delete(msg.agentName)
      refreshAgents()
      break
    }
    case 'delivery_mode_changed': {
      currentDeliveryMode = msg.mode
      roomPaused = msg.paused
      // Update pausedRooms set for room list dots
      const changedRoom = [...rooms.values()].find(r => r.name === msg.roomName)
      if (changedRoom) {
        if (msg.paused) pausedRooms.add(changedRoom.id)
        else pausedRooms.delete(changedRoom.id)
      }
      updateModeUI()
      refreshRooms()
      break
    }
    case 'mute_changed': {
      if (msg.muted) {
        mutedAgents.add(msg.agentName)
      } else {
        mutedAgents.delete(msg.agentName)
      }
      refreshAgents()
      break
    }
    case 'turn_changed': {
      if (msg.agentName) {
        roomModeInfo.textContent = `Turn: ${msg.agentName}${msg.waitingForHuman ? ' (waiting for input)' : ''}`
        roomModeInfo.className = 'text-xs text-blue-500 h-4 font-medium'
      }
      break
    }
    case 'flow_event': {
      if (msg.event === 'completed') {
        currentDeliveryMode = 'broadcast'
        roomPaused = true
        if (selectedRoomId) pausedRooms.add(selectedRoomId)
        updateModeUI()
        refreshRooms()
      } else if (msg.event === 'step') {
        const detail = msg.detail as Record<string, unknown> | undefined
        roomModeInfo.textContent = `Flow step ${(detail?.stepIndex as number ?? 0) + 1}: ${detail?.agentName ?? '...'}`
        roomModeInfo.className = 'text-xs text-purple-500 h-4 font-medium'
      } else if (msg.event === 'cancelled') {
        currentDeliveryMode = 'broadcast'
        roomPaused = true
        updateModeUI()
      }
      break
    }
    case 'artifact_changed': {
      const { action, artifact } = msg
      if (action === 'removed') {
        allArtifacts.delete(artifact.id)
      } else {
        allArtifacts.set(artifact.id, artifact)
      }
      // Refresh if current room is affected
      const affectedRoom = rooms.get(selectedRoomId)
      if (affectedRoom && (artifact.scope.length === 0 || artifact.scope.includes(selectedRoomId))) {
        refreshWorkspace(affectedRoom)
        refreshModeSelector()
      }
      break
    }
    case 'membership_changed': {
      // Use IDs directly — no fragile name-based lookups
      if (!roomMembers.has(msg.roomId)) roomMembers.set(msg.roomId, new Set())
      const memberSet = roomMembers.get(msg.roomId)!
      if (msg.action === 'added') memberSet.add(msg.agentId)
      else memberSet.delete(msg.agentId)
      if (msg.roomId === selectedRoomId) refreshAgents()
      break
    }
    case 'room_deleted': {
      const deletedRoom = [...rooms.values()].find(r => r.name === msg.roomName)
      if (deletedRoom) {
        rooms.delete(deletedRoom.id)
        roomMembers.delete(deletedRoom.id)
        roomMessages.delete(deletedRoom.id)
        if (selectedRoomId === deletedRoom.id) {
          selectedRoomId = ''
          noRoomState.classList.remove('hidden')
          roomHeader.classList.add('hidden')
          roomInfoBar.classList.add('hidden')
          chatArea.classList.add('hidden')
          workspace.hide()
        }
      }
      refreshRooms()
      break
    }
    case 'message_deleted': {
      const msgs = roomMessages.get(selectedRoomId)
      if (msgs) {
        const idx = msgs.findIndex(m => m.id === msg.messageId)
        if (idx !== -1) msgs.splice(idx, 1)
      }
      messagesDiv.querySelector(`[data-msg-id="${msg.messageId}"]`)?.remove()
      break
    }
    case 'messages_cleared': {
      const clearedRoom = [...rooms.values()].find(r => r.name === msg.roomName)
      if (clearedRoom) {
        roomMessages.delete(clearedRoom.id)
        if (clearedRoom.id === selectedRoomId) messagesDiv.innerHTML = ''
      }
      break
    }
    case 'error': {
      console.error('Server error:', msg.message)
      break
    }
    case 'ollama_health': {
      const health = (msg as { health: Record<string, unknown> }).health
      updateOllamaHealthUI(health)
      break
    }
    case 'ollama_metrics': {
      const metrics = (msg as { metrics: Record<string, unknown> }).metrics
      updateOllamaMetricsUI(metrics)
      break
    }
  }
}

// === Connect ===

const connect = (name: string) => {
  client = createWSClient(name, sessionToken, handleMessage, (connected) => {
    // Connection state visible through agent list + Ollama indicator
    chatInput.disabled = !connected
    if (connected) chatForm.querySelector('button')!.removeAttribute('disabled')
  })
}

// === Event handlers ===

chatForm.onsubmit = (e) => {
  e.preventDefault()
  const content = chatInput.value.trim()
  if (!content || !selectedRoomId) return
  const room = rooms.get(selectedRoomId)
  if (!room) return

  // If a flow is selected in the mode dropdown, start it with this message
  const selectedMode = modeSelector.value
  if (selectedMode.startsWith('flow:')) {
    const flowArtifactId = selectedMode.slice(5)
    send({ type: 'start_flow', roomName: room.name, flowArtifactId, content })
    chatInput.value = ''
    chatInput.placeholder = 'Type a message...'
    return
  }

  send({ type: 'post_message', target: { rooms: [room.name] }, content })
  chatInput.value = ''
}

document.getElementById('btn-create-room')!.onclick = () => roomModal.showModal()
document.getElementById('btn-create-agent')!.onclick = async () => {
  // Populate model dropdown before showing modal
  const modelSelect = agentForm.querySelector('select[name="model"]') as HTMLSelectElement
  modelSelect.innerHTML = '<option value="">Loading...</option>'
  agentModal.showModal()
  try {
    const res = await fetch('/api/models')
    const data = await res.json() as { running: string[]; available: string[] }
    modelSelect.innerHTML = ''
    const allModels = [...data.running, ...data.available]
    // Prefer the lightest model as default: qwen3:4b > llama3.2 > first available
    const preferredDefaults = ['llama3.2:latest', 'qwen3:4b', 'llama3.2:3b']
    const defaultModel = preferredDefaults.find(p => allModels.includes(p)) ?? allModels[0] ?? ''
    if (data.running.length > 0) {
      const group = document.createElement('optgroup')
      group.label = 'Running'
      for (const m of data.running) {
        const opt = document.createElement('option')
        opt.value = m; opt.textContent = m; opt.selected = m === defaultModel
        group.appendChild(opt)
      }
      modelSelect.appendChild(group)
    }
    if (data.available.length > 0) {
      const group = document.createElement('optgroup')
      group.label = 'Available'
      for (const m of data.available) {
        const opt = document.createElement('option')
        opt.value = m; opt.textContent = m; opt.selected = m === defaultModel
        group.appendChild(opt)
      }
      modelSelect.appendChild(group)
    }
    if (allModels.length === 0) {
      modelSelect.innerHTML = '<option value="">No models found</option>'
    }
  } catch {
    modelSelect.innerHTML = '<option value="">Failed to load models</option>'
  }
}

// Pause toggle
pauseToggle.onclick = () => {
  const room = rooms.get(selectedRoomId)
  if (!room) return
  send({ type: 'set_paused', roomName: room.name, paused: !roomPaused })
}

// Mode selector — controls delivery mode and flows
modeSelector.onchange = () => {
  const room = rooms.get(selectedRoomId)
  if (!room) return
  const val = modeSelector.value

  // Create flow
  if (val === '__create_flow__') {
    refreshModeSelector()  // revert selector to current state
    lazyFlowEditor(agents, myAgentId, (name, steps, loop, description) => {
      send({ type: 'add_artifact', artifactType: 'flow', title: name, body: { steps, loop }, scope: [room.name], ...(description !== undefined ? { description } : {}) })
    })
    return
  }

  // Start a flow
  if (val.startsWith('flow:')) {
    const flowArtifactId = val.slice(5)
    const content = chatInput.value.trim()
    if (!content) {
      chatInput.placeholder = 'Type a message to start the flow...'
      chatInput.focus()
      return
    }
    send({ type: 'start_flow', roomName: room.name, flowArtifactId, content })
    chatInput.value = ''
    chatInput.placeholder = 'Type a message...'
    return
  }

  // Base delivery mode (broadcast) — also unpauses
  send({ type: 'set_delivery_mode', roomName: room.name, mode: val })
}

roomForm.onsubmit = (e) => {
  e.preventDefault()
  const data = new FormData(roomForm)
  const roomPrompt = (data.get('roomPrompt') as string | null)?.trim() || undefined
  send({
    type: 'create_room',
    name: data.get('name') as string,
    ...(roomPrompt ? { roomPrompt } : {}),
  })
  roomModal.close()
  roomForm.reset()
}

agentForm.onsubmit = (e) => {
  e.preventDefault()
  const data = new FormData(agentForm)
  const rawTags = (data.get('tags') as string | null)?.trim() ?? ''
  const tags = rawTags ? rawTags.split(',').map(t => t.trim()).filter(Boolean) : undefined
  send({
    type: 'create_agent',
    config: {
      name: data.get('name') as string,
      model: data.get('model') as string,
      systemPrompt: data.get('systemPrompt') as string,
      ...(tags && tags.length > 0 ? { tags } : {}),
    },
  })
  agentModal.close()
  agentForm.reset()
}

// === Prompt editing — house, room, response format ===

const btnSystemPrompt = $('#btn-system-prompt') as HTMLButtonElement
btnSystemPrompt.onclick = () => {
  fetch('/api/house/prompts')
    .then(r => r.ok ? r.json() : null)
    .then((data: { housePrompt?: string; responseFormat?: string } | null) => {
      if (!data) return
      const modal = createModal({ title: '', width: 'max-w-2xl' })
      // Replace the default title with a matching label style
      const titleRow = modal.body.querySelector('div')
      if (titleRow) {
        const titleEl = titleRow.querySelector('h3')
        if (titleEl) {
          titleEl.className = 'text-xs font-semibold text-gray-400 uppercase tracking-wide'
          titleEl.textContent = 'System Prompt'
        }
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

      let savedHouse = houseArea.value
      let savedFormat = formatArea.value

      const isDirty = () => houseArea.value !== savedHouse || formatArea.value !== savedFormat
      const updateStyle = () => {
        updateBtn.className = isDirty()
          ? 'text-xs px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 cursor-pointer'
          : 'text-xs px-3 py-1 bg-gray-300 text-white rounded cursor-not-allowed'
      }
      houseArea.oninput = updateStyle
      formatArea.oninput = updateStyle

      updateBtn.onclick = async () => {
        if (!isDirty()) return
        await fetch('/api/house/prompts', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ housePrompt: houseArea.value, responseFormat: formatArea.value }),
        }).catch(() => {})
        savedHouse = houseArea.value
        savedFormat = formatArea.value
        updateStyle()
        const toast = document.createElement('div')
        toast.className = 'absolute left-1/2 -translate-x-1/2 bg-green-600 text-white text-xs px-3 py-1 rounded shadow transition-opacity duration-700'
        toast.style.bottom = '4px'
        toast.textContent = 'Prompts updated'
        btnRow.appendChild(toast)
        setTimeout(() => { toast.style.opacity = '0' }, 2000)
        setTimeout(() => { toast.remove() }, 3000)
      }

      document.body.appendChild(modal.overlay)
    })
}

const btnClearMessages = $('#btn-clear-messages') as HTMLButtonElement
btnClearMessages.onclick = () => {
  const room = rooms.get(selectedRoomId)
  if (!room) return
  if (!confirm(`Clear all messages in "${room.name}"?`)) return
  send({ type: 'clear_messages', roomName: room.name })
  roomMessages.delete(selectedRoomId)
  messagesDiv.innerHTML = ''
}

const btnRoomPrompt = $('#btn-room-prompt') as HTMLButtonElement
btnRoomPrompt.onclick = () => {
  const room = rooms.get(selectedRoomId)
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

// === Ollama Dashboard ===

const ollamaStatusDot = document.getElementById('ollama-status-dot') as HTMLElement
const ollamaDashboard = document.getElementById('ollama-dashboard') as HTMLDialogElement
const ollamaDashboardClose = document.getElementById('ollama-dashboard-close') as HTMLButtonElement

const statusColors: Record<string, string> = {
  healthy: 'bg-green-500',
  degraded: 'bg-yellow-400',
  down: 'bg-red-500',
}

const updateOllamaHealthUI = (health: Record<string, unknown>): void => {
  const status = health.status as string ?? 'down'
  ollamaStatusDot.className = `inline-block w-2 h-2 rounded-full ${statusColors[status] ?? 'bg-gray-400'}`

  // Update dashboard if open
  const dotEl = document.getElementById('od-status-dot')
  const textEl = document.getElementById('od-status-text')
  const latencyEl = document.getElementById('od-latency')
  if (dotEl) dotEl.className = `inline-block w-3 h-3 rounded-full ${statusColors[status] ?? 'bg-gray-400'}`
  if (textEl) textEl.textContent = status.charAt(0).toUpperCase() + status.slice(1)
  if (latencyEl) latencyEl.textContent = `${health.latencyMs ?? 0}ms`

  // Update models
  const modelsEl = document.getElementById('od-models')
  const loaded = health.loadedModels as Array<{ name: string; sizeVram: number; expiresAt?: string }> ?? []
  if (modelsEl) {
    if (loaded.length === 0) {
      modelsEl.textContent = 'No models loaded'
    } else {
      modelsEl.innerHTML = loaded.map(m => {
        const sizeMb = Math.round(m.sizeVram / 1e6)
        const unloadBtn = `<button class="od-unload text-xs text-red-400 hover:text-red-600 ml-2" data-model="${m.name}">unload</button>`
        return `<div class="flex items-center justify-between py-0.5"><span class="font-mono text-xs">${m.name}</span><span class="text-xs text-gray-400">${sizeMb}MB${unloadBtn}</span></div>`
      }).join('')
      // Wire unload buttons
      modelsEl.querySelectorAll('.od-unload').forEach(btn => {
        btn.addEventListener('click', async () => {
          const model = (btn as HTMLElement).dataset.model
          if (model) {
            await fetch(`/api/ollama/models/${encodeURIComponent(model)}/unload`, { method: 'POST' })
          }
        })
      })
    }

    // Load model controls
    const loadedNames = new Set(loaded.map(m => m.name))
    const available = health.availableModels as string[] ?? []
    const unloaded = available.filter(m => !loadedNames.has(m))
    let loadRow = modelsEl.querySelector('.od-load-row') as HTMLElement | null
    if (!loadRow) {
      loadRow = document.createElement('div')
      loadRow.className = 'od-load-row flex items-center gap-1 mt-2 pt-2 border-t border-gray-100'
      modelsEl.appendChild(loadRow)
    }
    if (unloaded.length > 0) {
      loadRow.innerHTML = `<select class="od-load-select flex-1 text-xs border rounded px-1 py-0.5">${unloaded.map(m => `<option value="${m}">${m}</option>`).join('')}</select><button class="od-load-btn text-xs px-2 py-0.5 bg-blue-500 text-white rounded hover:bg-blue-600">Load</button>`
      loadRow.querySelector('.od-load-btn')?.addEventListener('click', async () => {
        const sel = loadRow!.querySelector('.od-load-select') as HTMLSelectElement
        if (sel?.value) await fetch(`/api/ollama/models/${encodeURIComponent(sel.value)}/load`, { method: 'POST' })
      })
    } else {
      loadRow.innerHTML = '<span class="text-xs text-gray-400">All models loaded</span>'
    }
  }
}

const updateOllamaMetricsUI = (metrics: Record<string, unknown>): void => {
  const tpsEl = document.getElementById('od-tps')
  const p50El = document.getElementById('od-p50')
  const errorsEl = document.getElementById('od-errors')
  const queueEl = document.getElementById('od-queue')
  const concurrentEl = document.getElementById('od-concurrent')
  const circuitEl = document.getElementById('od-circuit')
  const requestsEl = document.getElementById('od-requests')

  if (tpsEl) tpsEl.textContent = `${(metrics.avgTokensPerSecond as number ?? 0).toFixed(1)}`
  if (p50El) {
    const ms = metrics.p50Latency as number ?? 0
    p50El.textContent = ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
  }
  if (errorsEl) errorsEl.textContent = `${((metrics.errorRate as number ?? 0) * 100).toFixed(0)}%`
  if (queueEl) queueEl.textContent = `${metrics.queueDepth ?? 0}`
  if (concurrentEl) concurrentEl.textContent = `${metrics.concurrentRequests ?? 0}`
  if (circuitEl) {
    const state = metrics.circuitState as string ?? 'closed'
    circuitEl.textContent = state
    circuitEl.className = `text-lg font-semibold ${state === 'closed' ? 'text-green-600' : state === 'open' ? 'text-red-600' : 'text-yellow-500'}`
  }
  if (requestsEl) requestsEl.textContent = `${metrics.requestCount ?? 0}`
}

// Dashboard open/close
document.getElementById('btn-ollama-dashboard')!.onclick = async () => {
  ollamaDashboard.showModal()
  send({ type: 'subscribe_ollama_metrics' } as unknown as Parameters<typeof send>[0])
  void refreshOllamaUrls()

  // Fetch initial data
  try {
    const [healthRes, metricsRes, configRes] = await Promise.all([
      fetch('/api/ollama/health'),
      fetch('/api/ollama/metrics'),
      fetch('/api/ollama/config'),
    ])
    if (healthRes.ok) updateOllamaHealthUI(await healthRes.json() as Record<string, unknown>)
    if (metricsRes.ok) updateOllamaMetricsUI(await metricsRes.json() as Record<string, unknown>)
    if (configRes.ok) {
      const cfg = await configRes.json() as Record<string, unknown>
      const cfgConcurrent = document.getElementById('od-cfg-concurrent') as HTMLInputElement
      const cfgQueue = document.getElementById('od-cfg-queue') as HTMLInputElement
      const cfgTimeout = document.getElementById('od-cfg-timeout') as HTMLInputElement
      const cfgKeepalive = document.getElementById('od-cfg-keepalive') as HTMLInputElement
      if (cfgConcurrent) cfgConcurrent.value = String(cfg.maxConcurrent ?? 2)
      if (cfgQueue) cfgQueue.value = String(cfg.maxQueueDepth ?? 6)
      if (cfgTimeout) cfgTimeout.value = String(cfg.queueTimeoutMs ?? 30000)
      if (cfgKeepalive) cfgKeepalive.value = String(cfg.keepAlive ?? '30m')
    }
  } catch { /* ignore fetch errors on dashboard open */ }
}

ollamaDashboardClose.onclick = () => {
  ollamaDashboard.close()
  send({ type: 'unsubscribe_ollama_metrics' } as unknown as Parameters<typeof send>[0])
}

ollamaDashboard.addEventListener('close', () => {
  send({ type: 'unsubscribe_ollama_metrics' } as unknown as Parameters<typeof send>[0])
})

// Config save
document.getElementById('od-cfg-save')!.onclick = async () => {
  const body: Record<string, unknown> = {}
  const cfgConcurrent = document.getElementById('od-cfg-concurrent') as HTMLInputElement
  const cfgQueue = document.getElementById('od-cfg-queue') as HTMLInputElement
  const cfgTimeout = document.getElementById('od-cfg-timeout') as HTMLInputElement
  const cfgKeepalive = document.getElementById('od-cfg-keepalive') as HTMLInputElement
  if (cfgConcurrent?.value) body.maxConcurrent = parseInt(cfgConcurrent.value)
  if (cfgQueue?.value) body.maxQueueDepth = parseInt(cfgQueue.value)
  if (cfgTimeout?.value) body.queueTimeoutMs = parseInt(cfgTimeout.value)
  if (cfgKeepalive?.value) body.keepAlive = cfgKeepalive.value
  await fetch('/api/ollama/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// === Startup ===

const savedName = localStorage.getItem('ta_name')

nameForm.onsubmit = (e) => {
  e.preventDefault()
  const name = (new FormData(nameForm).get('name') as string).trim()
  if (!name) return
  myName = name
  localStorage.setItem('ta_name', name)
  nameModal.close()
  connect(name)
}

if (savedName) {
  myName = savedName
  connect(savedName)
} else {
  nameModal.showModal()
}
