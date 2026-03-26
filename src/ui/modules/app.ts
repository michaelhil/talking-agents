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
  renderTypingIndicators,
  openPromptEditor,
  openFlowEditorModal,
  type UIMessage,
  type RoomProfile,
  type AgentInfo,
} from './ui-renderer.ts'

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

// === DOM refs ===

const $ = (sel: string) => document.querySelector(sel)!
const roomList = $('#room-list') as HTMLElement
const agentList = $('#agent-list') as HTMLElement
const messagesDiv = $('#messages') as HTMLElement
const chatForm = $('#chat-form') as HTMLFormElement
const chatInput = $('#chat-input') as HTMLInputElement
const roomName = $('#room-name') as HTMLElement
const typingIndicators = $('#typing-indicators') as HTMLElement
const connectionStatus = $('#connection-status') as HTMLElement
const modeSelector = $('#mode-selector') as HTMLSelectElement
const roomModeInfo = $('#room-mode-info') as HTMLElement
const flowSelector = $('#flow-selector') as HTMLSelectElement
const nameModal = $('#name-modal') as HTMLDialogElement
const nameForm = $('#name-form') as HTMLFormElement
const roomModal = $('#room-modal') as HTMLDialogElement
const roomForm = $('#room-form') as HTMLFormElement
const agentModal = $('#agent-modal') as HTMLDialogElement
const agentForm = $('#agent-form') as HTMLFormElement

// === Render helpers (delegate to ui-renderer) ===

const send = (data: unknown) => client?.send(data)

const onTogglePause = (roomId: string, paused: boolean): void => {
  const room = rooms.get(roomId)
  if (!room) return
  send({ type: 'set_paused', roomName: room.name, paused })
}

const refreshRooms = () => renderRooms(roomList, rooms, selectedRoomId, pausedRooms, selectRoom, onTogglePause)

const refreshAgents = () => renderAgents(
  agentList, agents, agentStates, mutedAgents,
  (name) => openPromptEditor(name, send),
  (id, name) => { send({ type: 'remove_agent', name }); agents.delete(id); refreshAgents() },
  (name, muted) => {
    const room = rooms.get(selectedRoomId)
    if (room) send({ type: 'set_muted', roomName: room.name, agentName: name, muted })
  },
)

const refreshFlowSelector = (): void => {
  flowSelector.innerHTML = '<option value="">Flow...</option><option value="__create__">+ Create Flow</option>'
  const room = rooms.get(selectedRoomId)
  if (!room) return
  const flows = roomFlows.get(room.name) ?? []
  for (const flow of flows) {
    const opt = document.createElement('option')
    opt.value = flow.id
    opt.textContent = `▶ ${flow.name}${flow.loop ? ' ↻' : ''}`
    flowSelector.appendChild(opt)
  }
  // Show flow selector if there are flows or we have agents
  flowSelector.classList.toggle('hidden', agents.size <= 1)
}

const fetchFlowsForRoom = async (roomName: string): Promise<void> => {
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(roomName)}/flows`)
    if (!res.ok) return
    const flows = await res.json() as FlowInfo[]
    roomFlows.set(roomName, flows)
    refreshFlowSelector()
  } catch { /* ignore */ }
}

const updateModeUI = () => {
  modeSelector.value = currentDeliveryMode
  const isFlow = currentDeliveryMode === 'flow'

  if (isFlow) {
    roomModeInfo.textContent = 'Flow active'
    roomModeInfo.className = 'text-xs text-purple-500 h-4'
  } else if (currentDeliveryMode === 'staleness') {
    roomModeInfo.textContent = 'Staleness turn-taking active'
    roomModeInfo.className = 'text-xs text-blue-500 h-4'
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

  roomName.textContent = room.name
  refreshRooms()
  updateModeUI()
  fetchFlowsForRoom(room.name)

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
      rooms.clear(); agents.clear(); agentStates.clear(); mutedAgents.clear(); pausedRooms.clear()
      for (const r of msg.rooms) rooms.set(r.id, r)
      for (const a of msg.agents) {
        agents.set(a.id, a)
        if (a.state === 'generating') agentStates.set(a.name, { state: 'generating' })
      }
      // Restore per-room state from snapshot
      if (msg.roomStates) {
        for (const [roomId, rs] of Object.entries(msg.roomStates as Record<string, { mode: string; paused: boolean; muted: string[] }>)) {
          if (rs.paused) pausedRooms.add(roomId)
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

  // If a flow is selected, start it with this message
  const selectedFlow = flowSelector.value
  if (selectedFlow && selectedFlow !== '__create__') {
    send({ type: 'start_flow', roomName: room.name, flowId: selectedFlow, content })
    chatInput.value = ''
    flowSelector.value = ''
    chatInput.placeholder = 'Type a message...'
    return
  }

  send({ type: 'post_message', target: { rooms: [room.name] }, content })
  chatInput.value = ''
}

document.getElementById('btn-create-room')!.onclick = () => roomModal.showModal()
document.getElementById('btn-create-agent')!.onclick = () => agentModal.showModal()

// Mode selector
modeSelector.onchange = () => {
  const room = rooms.get(selectedRoomId)
  if (!room) return
  roomPaused = false  // switching mode clears pause
  send({ type: 'set_delivery_mode', roomName: room.name, mode: modeSelector.value })
}

// Flow selector
flowSelector.onchange = () => {
  const room = rooms.get(selectedRoomId)
  if (!room) return
  const val = flowSelector.value

  if (val === '__create__') {
    flowSelector.value = ''
    openFlowEditorModal(agents, myAgentId, (name, steps, loop) => {
      send({ type: 'add_flow', roomName: room.name, name, steps, loop })
      // Refresh flows after a short delay to pick up the new flow
      setTimeout(() => fetchFlowsForRoom(room.name), 200)
    })
    return
  }

  if (val) {
    const content = chatInput.value.trim()
    if (!content) {
      chatInput.placeholder = 'Type a message to start the flow...'
      chatInput.focus()
      flowSelector.value = val // keep selection
      return
    }
    // Start the flow with the message
    send({ type: 'start_flow', roomName: room.name, flowId: val, content })
    chatInput.value = ''
    flowSelector.value = ''
  }
}

roomForm.onsubmit = (e) => {
  e.preventDefault()
  const data = new FormData(roomForm)
  send({
    type: 'create_room',
    name: data.get('name') as string,
    visibility: data.get('visibility') as string,
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

const openTextEditor = (
  title: string,
  fetchUrl: string,
  fieldName: string,
  saveUrl: string,
  method = 'PUT',
  extractValue?: (data: Record<string, unknown>) => string,
): void => {
  fetch(fetchUrl)
    .then(res => res.ok ? res.json() : null)
    .then(data => {
      if (!data) return
      const currentValue = extractValue
        ? extractValue(data as Record<string, unknown>)
        : ((data[fieldName] ?? '') as string)

      const overlay = document.createElement('div')
      overlay.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50'
      overlay.onclick = (e) => { if (e.target === overlay) overlay.remove() }

      const modal = document.createElement('div')
      modal.className = 'bg-white rounded-lg shadow-xl p-6 w-full max-w-lg mx-4'

      const heading = document.createElement('h3')
      heading.className = 'text-lg font-semibold mb-3'
      heading.textContent = title

      const textarea = document.createElement('textarea')
      textarea.className = 'w-full h-48 border rounded p-3 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-blue-300'
      textarea.value = currentValue

      const btnRow = document.createElement('div')
      btnRow.className = 'flex justify-end gap-2 mt-3'

      const cancelBtn = document.createElement('button')
      cancelBtn.className = 'px-4 py-2 text-sm text-gray-600 hover:text-gray-800'
      cancelBtn.textContent = 'Cancel'
      cancelBtn.onclick = () => overlay.remove()

      const saveBtn = document.createElement('button')
      saveBtn.className = 'px-4 py-2 text-sm bg-blue-500 text-white rounded hover:bg-blue-600'
      saveBtn.textContent = 'Save'
      saveBtn.onclick = () => {
        fetch(saveUrl, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [fieldName]: textarea.value }),
        }).catch(() => {})
        overlay.remove()
      }

      btnRow.appendChild(cancelBtn)
      btnRow.appendChild(saveBtn)
      modal.appendChild(heading)
      modal.appendChild(textarea)
      modal.appendChild(btnRow)
      overlay.appendChild(modal)
      document.body.appendChild(overlay)
      textarea.focus()
    })
    .catch(() => {})
}

const btnHousePrompt = $('#btn-house-prompt') as HTMLButtonElement
btnHousePrompt.onclick = () => openTextEditor(
  'House Rules',
  '/api/house/prompts', 'housePrompt', '/api/house/prompts',
)

const btnResponseFormat = $('#btn-response-format') as HTMLButtonElement
btnResponseFormat.onclick = () => openTextEditor(
  'Response Format',
  '/api/house/prompts', 'responseFormat', '/api/house/prompts',
)

const btnRoomPrompt = $('#btn-room-prompt') as HTMLButtonElement
btnRoomPrompt.onclick = () => {
  const room = rooms.get(selectedRoomId)
  if (!room) return
  openTextEditor(
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
