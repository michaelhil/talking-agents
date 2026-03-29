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
  renderTodos,
  renderTypingIndicators,
  openPromptEditor,
  openModelEditor,
  openFlowEditorModal,
  type UIMessage,
  type RoomProfile,
  type AgentInfo,
  type TodoInfo,
} from './ui-renderer.ts'
import { openTextEditorModal } from './modal.ts'

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
  | { type: 'todo_changed'; roomName: string; action: string; todo: TodoInfo }
  | { type: 'membership_changed'; roomName: string; agentName: string; action: 'added' | 'removed' }
  | { type: 'room_deleted'; roomName: string }

// === State ===

let client: WSClient | null = null
let myAgentId = ''
let sessionToken = localStorage.getItem('ta_session') ?? ''
let selectedRoomId = ''
let currentDeliveryMode = 'broadcast'
const rooms = new Map<string, RoomProfile>()
const agents = new Map<string, AgentInfo>()
const roomMessages = new Map<string, UIMessage[]>()
const agentStates = new Map<string, { state: string; context?: string }>()
const mutedAgents = new Set<string>()  // agent names that are muted in current room
let roomPaused = false
const pausedRooms = new Set<string>()  // room IDs that are paused

// Flow state per room
interface FlowInfo { id: string; name: string; steps: Array<{ agentName: string; stepPrompt?: string }>; loop: boolean }
const roomFlows = new Map<string, FlowInfo[]>()  // roomName → flows

// Todo state per room
const roomTodos = new Map<string, TodoInfo[]>()  // roomName → todos

// Membership state per room
const roomMembers = new Map<string, Set<string>>()  // roomId → Set<agentId>

// === DOM refs ===

const $ = (sel: string) => document.querySelector(sel)!
const roomList = $('#room-list') as HTMLElement
const agentList = $('#agent-list') as HTMLElement
const noRoomState = $('#no-room-state') as HTMLElement
const todoPanel = $('#todo-panel') as HTMLElement
const todoToggle = $('#todo-toggle') as HTMLElement
const todoHeader = $('#todo-header') as HTMLElement
const todoCount = $('#todo-count') as HTMLElement
const todoListEl = $('#todo-list') as HTMLElement
const todoAddRow = $('#todo-add-row') as HTMLElement
const todoInput = $('#todo-input') as HTMLInputElement
const btnTodoSubmit = $('#btn-todo-submit') as HTMLElement
const btnAddTodo = $('#btn-add-todo') as HTMLElement
const roomHeader = $('#room-header') as HTMLElement
const messagesDiv = $('#messages') as HTMLElement
const chatForm = $('#chat-form') as HTMLFormElement
const chatInput = $('#chat-input') as HTMLInputElement
const roomName = $('#room-name') as HTMLElement
const typingIndicators = $('#typing-indicators') as HTMLElement
const connectionStatus = $('#connection-status') as HTMLElement
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

// === Render helpers (delegate to ui-renderer) ===

const send = (data: unknown) => client?.send(data)

const refreshRooms = () => renderRooms(roomList, rooms, selectedRoomId, pausedRooms, selectRoom)

const refreshAgents = () => {
  const room = rooms.get(selectedRoomId)
  const memberIds = room ? roomMembers.get(room.id) : undefined
  renderAgents(
    agentList, agents, agentStates, mutedAgents,
    (name) => openPromptEditor(name, send),
    (id, name) => { send({ type: 'remove_agent', name }); agents.delete(id); refreshAgents() },
    (name, muted) => {
      if (room) send({ type: 'set_muted', roomName: room.name, agentName: name, muted })
    },
    (name) => { send({ type: 'cancel_generation', name }) },
    (name) => openModelEditor(name, (data) => {
      send(data)
      const updated = (data as { model?: string }).model
      if (updated) {
        for (const [id, a] of agents) {
          if (a.name === name) { agents.set(id, { ...a, model: updated }); break }
        }
        refreshAgents()
      }
    }),
    memberIds,
    room ? (agentId, agentName) => send({ type: 'add_to_room', roomName: room.name, agentName }) : undefined,
    room ? (_agentId, agentName) => send({ type: 'remove_from_room', roomName: room.name, agentName }) : undefined,
  )
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

  // Flow options
  const room = rooms.get(selectedRoomId)
  const flows = room ? (roomFlows.get(room.name) ?? []) : []
  // Flow separator and options — always shown
  const sep = document.createElement('option')
  sep.disabled = true
  sep.textContent = '── Flows ──'
  modeSelector.appendChild(sep)

  for (const flow of flows) {
    const opt = document.createElement('option')
    opt.value = `flow:${flow.id}`
    opt.textContent = `▶ ${flow.name}${flow.loop ? ' ↻' : ''}`
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

const fetchFlowsForRoom = async (roomName: string): Promise<void> => {
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(roomName)}/flows`)
    if (!res.ok) return
    const flows = await res.json() as FlowInfo[]
    roomFlows.set(roomName, flows)
    refreshModeSelector()
  } catch { /* ignore */ }
}

const fetchTodosForRoom = async (roomName: string): Promise<void> => {
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(roomName)}/todos`)
    if (!res.ok) return
    const todos = await res.json() as TodoInfo[]
    roomTodos.set(roomName, todos)
    refreshTodoPanel(roomName)
  } catch { /* ignore */ }
}

let todoExpanded = false

const refreshTodoPanel = (roomName: string): void => {
  const todos = roomTodos.get(roomName) ?? []

  todoPanel.classList.toggle('hidden', !selectedRoomId)
  todoCount.textContent = todos.length > 0 ? `(${todos.length})` : ''
  todoToggle.textContent = todoExpanded ? '▼' : '▶'
  todoListEl.classList.toggle('hidden', !todoExpanded)
  todoAddRow.classList.toggle('hidden', !todoExpanded)

  if (todoExpanded) {
    if (todos.length > 0) {
      renderTodos(
        todoListEl,
        todos,
        (todoId, currentStatus) => {
          const newStatus = currentStatus === 'completed' ? 'pending' : 'completed'
          send({ type: 'update_todo', roomName, todoId, status: newStatus })
        },
        (todoId) => {
          send({ type: 'remove_todo', roomName, todoId })
        },
      )
    } else {
      todoListEl.innerHTML = '<p class="text-xs text-gray-400 italic py-0.5">No todos yet</p>'
    }
  }
}

const submitTodo = (): void => {
  const room = rooms.get(selectedRoomId)
  if (!room) return
  const content = todoInput.value.trim()
  if (!content) return
  send({ type: 'add_todo', roomName: room.name, content })
  todoInput.value = ''
}

todoHeader.onclick = () => {
  todoExpanded = !todoExpanded
  const room = rooms.get(selectedRoomId)
  if (room) refreshTodoPanel(room.name)
  if (todoExpanded) setTimeout(() => todoInput.focus(), 50)
}

btnAddTodo.onclick = (e) => {
  e.stopPropagation()
  if (!todoExpanded) {
    todoExpanded = true
    const room = rooms.get(selectedRoomId)
    if (room) refreshTodoPanel(room.name)
  }
  setTimeout(() => todoInput.focus(), 50)
}

btnTodoSubmit.onclick = (e) => {
  e.stopPropagation()
  submitTodo()
}

todoInput.onkeydown = (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submitTodo() }
  if (e.key === 'Escape') { todoInput.value = ''; todoInput.blur() }
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

const refreshTyping = () => renderTypingIndicators(typingIndicators, agentStates, selectedRoomId)

// === Room selection ===

const selectRoom = (roomId: string) => {
  selectedRoomId = roomId
  const room = rooms.get(roomId)
  if (!room) return

  // Show chat UI, hide empty state
  noRoomState.classList.add('hidden')
  roomHeader.classList.remove('hidden')
  messagesDiv.classList.remove('hidden')
  chatForm.classList.remove('hidden')

  roomName.textContent = room.name
  refreshRooms()
  updateModeUI()
  refreshTodoPanel(room.name)
  fetchFlowsForRoom(room.name)
  fetchTodosForRoom(room.name)

  messagesDiv.innerHTML = ''
  const cached = roomMessages.get(roomId)
  if (cached) {
    for (const m of cached) renderMessage(messagesDiv, m, myAgentId, agents)
  } else {
    fetchRoomMessages(room.name)
  }
  messagesDiv.scrollTop = messagesDiv.scrollHeight
}

const fetchRoomMessages = async (name: string) => {
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(name)}?limit=50`)
    if (!res.ok) return
    const data = await res.json() as { profile: RoomProfile; messages: UIMessage[] }
    roomMessages.set(data.profile.id, data.messages)
    if (selectedRoomId === data.profile.id) {
      messagesDiv.innerHTML = ''
      for (const m of data.messages) renderMessage(messagesDiv, m, myAgentId, agents)
      messagesDiv.scrollTop = messagesDiv.scrollHeight
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
      rooms.clear(); agents.clear(); agentStates.clear(); mutedAgents.clear(); pausedRooms.clear(); roomMembers.clear()
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
      if (msg.roomStates && selectedRoomId && msg.roomStates[selectedRoomId]) {
        const rs = msg.roomStates[selectedRoomId] as { mode: string; paused: boolean; muted: string[] }
        currentDeliveryMode = rs.mode
        roomPaused = rs.paused
        for (const id of rs.muted) {
          const agent = agents.get(id)
          if (agent) mutedAgents.add(agent.name)
        }
      }
      refreshRooms(); refreshAgents(); refreshTyping()
      if (!selectedRoomId && rooms.size > 0) {
        selectRoom(rooms.values().next().value!.id)
      }
      // Apply room state AFTER selectRoom sets selectedRoomId
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
        if (roomId === selectedRoomId) {
          renderMessage(messagesDiv, m, myAgentId, agents)
          messagesDiv.scrollTop = messagesDiv.scrollHeight
        }
      }
      break
    }
    case 'agent_state': {
      agentStates.set(msg.agentName, { state: msg.state, context: msg.context })
      refreshAgents(); refreshTyping()
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
      refreshAgents(); refreshTyping()
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
    case 'todo_changed': {
      // Update local cache for the affected room
      const current = roomTodos.get(msg.roomName) ?? []
      if (msg.action === 'added') {
        roomTodos.set(msg.roomName, [...current, msg.todo as TodoInfo])
      } else if (msg.action === 'updated') {
        roomTodos.set(msg.roomName, current.map(t => t.id === msg.todo.id ? msg.todo as TodoInfo : t))
      } else if (msg.action === 'removed') {
        roomTodos.set(msg.roomName, current.filter(t => t.id !== msg.todo.id))
      }
      // Only refresh panel if this is the currently selected room
      const selectedRoom = rooms.get(selectedRoomId)
      if (selectedRoom?.name === msg.roomName) refreshTodoPanel(msg.roomName)
      break
    }
    case 'membership_changed': {
      const changedRoom = [...rooms.values()].find(r => r.name === msg.roomName)
      if (changedRoom) {
        if (!roomMembers.has(changedRoom.id)) roomMembers.set(changedRoom.id, new Set())
        const memberSet = roomMembers.get(changedRoom.id)!
        // Find agent by name to get their ID
        for (const [agentId, agent] of agents) {
          if (agent.name === msg.agentName) {
            if (msg.action === 'added') memberSet.add(agentId)
            else memberSet.delete(agentId)
            break
          }
        }
        if (changedRoom.id === selectedRoomId) refreshAgents()
      }
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
          messagesDiv.classList.add('hidden')
          chatForm.classList.add('hidden')
          todoPanel.classList.add('hidden')
        }
      }
      refreshRooms()
      break
    }
    case 'error': {
      console.error('Server error:', msg.message)
      break
    }
  }
}

// === Connect ===

const connect = (name: string) => {
  client = createWSClient(name, sessionToken, handleMessage, (connected) => {
    connectionStatus.textContent = connected ? `Connected as ${name}` : 'Disconnected — reconnecting...'
    connectionStatus.className = `text-sm ${connected ? 'text-green-600' : 'text-red-500'}`
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
    const flowId = selectedMode.slice(5)
    send({ type: 'start_flow', roomName: room.name, flowId, content })
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
    if (data.running.length > 0) {
      const group = document.createElement('optgroup')
      group.label = 'Running'
      for (const m of data.running) {
        const opt = document.createElement('option')
        opt.value = m; opt.textContent = m; opt.selected = data.running.indexOf(m) === 0
        group.appendChild(opt)
      }
      modelSelect.appendChild(group)
    }
    if (data.available.length > 0) {
      const group = document.createElement('optgroup')
      group.label = 'Available'
      for (const m of data.available) {
        const opt = document.createElement('option')
        opt.value = m; opt.textContent = m
        group.appendChild(opt)
      }
      modelSelect.appendChild(group)
    }
    if (data.running.length === 0 && data.available.length === 0) {
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
    openFlowEditorModal(agents, myAgentId, (name, steps, loop) => {
      send({ type: 'add_flow', roomName: room.name, name, steps, loop })
      setTimeout(() => fetchFlowsForRoom(room.name), 200)
    })
    return
  }

  // Start a flow
  if (val.startsWith('flow:')) {
    const flowId = val.slice(5)
    const content = chatInput.value.trim()
    if (!content) {
      chatInput.placeholder = 'Type a message to start the flow...'
      chatInput.focus()
      return
    }
    send({ type: 'start_flow', roomName: room.name, flowId, content })
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
  send({
    type: 'create_agent',
    config: {
      name: data.get('name') as string,
      model: data.get('model') as string,
      systemPrompt: data.get('systemPrompt') as string,
    },
  })
  agentModal.close()
  agentForm.reset()
}

// === Prompt editing — house, room, response format ===

const btnHousePrompt = $('#btn-house-prompt') as HTMLButtonElement
btnHousePrompt.onclick = () => openTextEditorModal(
  'House Rules', '/api/house/prompts', 'housePrompt', '/api/house/prompts',
)

const btnResponseFormat = $('#btn-response-format') as HTMLButtonElement
btnResponseFormat.onclick = () => openTextEditorModal(
  'Response Format', '/api/house/prompts', 'responseFormat', '/api/house/prompts',
)

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

// === Startup ===

const savedName = localStorage.getItem('ta_name')

nameForm.onsubmit = (e) => {
  e.preventDefault()
  const name = (new FormData(nameForm).get('name') as string).trim()
  if (!name) return
  localStorage.setItem('ta_name', name)
  nameModal.close()
  connect(name)
}

if (savedName) {
  connect(savedName)
} else {
  nameModal.showModal()
}
