// ============================================================================
// Talking Agents — UI Application
//
// Single-file UI logic. Connects via WebSocket, renders rooms/messages/agents.
// No framework, no build step. Served as transpiled JS by the server.
// ============================================================================

// === Types (mirror of server-side, minimal) ===

interface Message {
  id: string
  senderId: string
  content: string
  timestamp: number
  type: string
  roomId?: string
  recipientId?: string
  generationMs?: number
}

interface RoomProfile {
  id: string
  name: string
  description?: string
  visibility: string
}

interface AgentInfo {
  id: string
  name: string
  description: string
  kind: string
}

type WSOutbound =
  | { type: 'snapshot'; rooms: RoomProfile[]; agents: AgentInfo[]; agentId: string; sessionToken?: string }
  | { type: 'message'; message: Message }
  | { type: 'agent_state'; agentName: string; state: string; context?: string }
  | { type: 'room_created'; profile: RoomProfile }
  | { type: 'agent_joined'; agent: AgentInfo }
  | { type: 'agent_removed'; agentName: string }
  | { type: 'error'; message: string }

// === State ===

let ws: WebSocket | null = null
let myAgentId = ''
let sessionToken = localStorage.getItem('ta_session') ?? ''
let selectedRoomId = ''
const rooms = new Map<string, RoomProfile>()
const agents = new Map<string, AgentInfo & { state?: string }>()
const roomMessages = new Map<string, Message[]>()
const agentStates = new Map<string, { state: string; context?: string }>()

// === DOM refs ===

const $ = (sel: string) => document.querySelector(sel)!
const roomList = $('#room-list') as HTMLElement
const agentList = $('#agent-list') as HTMLElement
const messagesDiv = $('#messages') as HTMLElement
const chatForm = $('#chat-form') as HTMLFormElement
const chatInput = $('#chat-input') as HTMLInputElement
const roomName = $('#room-name') as HTMLElement
const roomDescription = $('#room-description') as HTMLElement
const typingIndicators = $('#typing-indicators') as HTMLElement
const connectionStatus = $('#connection-status') as HTMLElement
const nameModal = $('#name-modal') as HTMLDialogElement
const nameForm = $('#name-form') as HTMLFormElement
const roomModal = $('#room-modal') as HTMLDialogElement
const roomForm = $('#room-form') as HTMLFormElement
const agentModal = $('#agent-modal') as HTMLDialogElement
const agentForm = $('#agent-form') as HTMLFormElement

// === WebSocket ===

const connect = (name: string) => {
  const params = new URLSearchParams({ name })
  if (sessionToken) params.set('session', sessionToken)

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  ws = new WebSocket(`${protocol}//${location.host}/ws?${params}`)

  ws.onopen = () => {
    connectionStatus.textContent = `Connected as ${name}`
    connectionStatus.className = 'text-sm text-green-600'
    chatInput.disabled = false
    chatForm.querySelector('button')!.removeAttribute('disabled')
  }

  ws.onclose = () => {
    connectionStatus.textContent = 'Disconnected — reconnecting...'
    connectionStatus.className = 'text-sm text-red-500'
    chatInput.disabled = true
    setTimeout(() => connect(name), 2000)
  }

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data) as WSOutbound & { sessionToken?: string }
    handleMessage(msg)
  }
}

const send = (data: unknown) => {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data))
  }
}

// === Message handling ===

const handleMessage = (msg: WSOutbound & { sessionToken?: string }) => {
  switch (msg.type) {
    case 'snapshot': {
      if (msg.sessionToken) {
        sessionToken = msg.sessionToken
        localStorage.setItem('ta_session', sessionToken)
      }
      myAgentId = msg.agentId
      rooms.clear()
      agents.clear()
      for (const r of msg.rooms) rooms.set(r.id, r)
      for (const a of msg.agents) agents.set(a.id, a)
      renderRooms()
      renderAgents()
      // Auto-select first room
      if (!selectedRoomId && rooms.size > 0) {
        selectRoom(rooms.values().next().value!.id)
      }
      break
    }
    case 'message': {
      const m = msg.message
      const roomId = m.roomId ?? `dm:${m.senderId === myAgentId ? m.recipientId : m.senderId}`
      if (!roomMessages.has(roomId)) roomMessages.set(roomId, [])
      const msgs = roomMessages.get(roomId)!
      // Dedup by correlationId or id
      if (!msgs.some(existing => existing.id === m.id)) {
        msgs.push(m)
        if (roomId === selectedRoomId) {
          renderMessage(m)
          messagesDiv.scrollTop = messagesDiv.scrollHeight
        }
      }
      break
    }
    case 'agent_state': {
      agentStates.set(msg.agentName, { state: msg.state, context: msg.context })
      renderAgents()
      renderTypingIndicators()
      break
    }
    case 'room_created': {
      rooms.set(msg.profile.id, msg.profile)
      renderRooms()
      break
    }
    case 'agent_joined': {
      agents.set(msg.agent.id, msg.agent)
      renderAgents()
      break
    }
    case 'agent_removed': {
      for (const [id, agent] of agents) {
        if (agent.name === msg.agentName) { agents.delete(id); break }
      }
      agentStates.delete(msg.agentName)
      renderAgents()
      renderTypingIndicators()
      break
    }
    case 'error': {
      console.error('Server error:', msg.message)
      break
    }
  }
}

// === Rendering ===

const renderRooms = () => {
  roomList.innerHTML = ''
  for (const room of rooms.values()) {
    const div = document.createElement('div')
    div.className = `px-3 py-2 cursor-pointer text-sm hover:bg-gray-100 ${room.id === selectedRoomId ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700'}`
    div.textContent = `${room.visibility === 'private' ? '🔒 ' : ''}${room.name}`
    div.onclick = () => selectRoom(room.id)
    roomList.appendChild(div)
  }
}

const renderAgents = () => {
  agentList.innerHTML = ''
  for (const agent of agents.values()) {
    const stateInfo = agentStates.get(agent.name)
    const isGenerating = stateInfo?.state === 'generating'

    const div = document.createElement('div')
    div.className = 'px-3 py-2 border-b border-gray-100'

    const nameSpan = document.createElement('div')
    nameSpan.className = 'text-sm font-medium text-gray-800 flex items-center gap-1'
    const dot = document.createElement('span')
    dot.className = `inline-block w-2 h-2 rounded-full ${isGenerating ? 'bg-yellow-400 typing-indicator' : 'bg-green-400'}`
    nameSpan.appendChild(dot)
    nameSpan.appendChild(document.createTextNode(` ${agent.name}`))

    const descSpan = document.createElement('div')
    descSpan.className = 'text-xs text-gray-500 truncate'
    descSpan.textContent = agent.description

    const kindSpan = document.createElement('div')
    kindSpan.className = 'text-xs text-gray-400'
    kindSpan.textContent = `${agent.kind}${isGenerating ? ' — thinking...' : ''}`

    div.appendChild(nameSpan)
    div.appendChild(descSpan)
    div.appendChild(kindSpan)

    if (agent.kind === 'ai') {
      const removeBtn = document.createElement('button')
      removeBtn.className = 'text-xs text-red-400 hover:text-red-600 mt-1'
      removeBtn.textContent = 'Remove'
      removeBtn.onclick = (e) => {
        e.stopPropagation()
        send({ type: 'remove_agent', name: agent.name })
        agents.delete(agent.id)
        renderAgents()
      }
      div.appendChild(removeBtn)
    }

    agentList.appendChild(div)
  }
}

const selectRoom = (roomId: string) => {
  selectedRoomId = roomId
  const room = rooms.get(roomId)
  if (!room) return

  roomName.textContent = room.name
  roomDescription.textContent = room.description ?? ''
  renderRooms()

  // Load messages from cache or fetch from API
  messagesDiv.innerHTML = ''
  const cached = roomMessages.get(roomId)
  if (cached) {
    for (const m of cached) renderMessage(m)
  } else {
    fetchRoomMessages(room.name)
  }
  messagesDiv.scrollTop = messagesDiv.scrollHeight
}

const fetchRoomMessages = async (name: string) => {
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(name)}?limit=50`)
    if (!res.ok) return
    const data = await res.json() as { profile: RoomProfile; messages: Message[] }
    roomMessages.set(data.profile.id, data.messages)
    if (selectedRoomId === data.profile.id) {
      messagesDiv.innerHTML = ''
      for (const m of data.messages) renderMessage(m)
      messagesDiv.scrollTop = messagesDiv.scrollHeight
    }
  } catch { /* ignore */ }
}

const renderMessage = (msg: Message) => {
  const div = document.createElement('div')
  const isSystem = msg.type === 'system' || msg.type === 'join' || msg.type === 'leave' || msg.senderId === 'system'
  const isSelf = msg.senderId === myAgentId
  const isRoomSummary = msg.type === 'room_summary'

  if (isSystem || isRoomSummary) {
    div.className = 'msg-system text-xs py-1 px-2'
    div.textContent = msg.content
  } else {
    div.className = `rounded px-3 py-2 text-sm ${isSelf ? 'msg-self' : 'msg-agent'}`

    const header = document.createElement('div')
    header.className = 'flex items-center gap-2 mb-1'

    const nameEl = document.createElement('span')
    nameEl.className = 'font-medium text-gray-800 text-xs'
    const sender = agents.get(msg.senderId)
    nameEl.textContent = sender?.name ?? msg.senderId

    const timeEl = document.createElement('span')
    timeEl.className = 'text-xs text-gray-400'
    timeEl.textContent = new Date(msg.timestamp).toLocaleTimeString()

    header.appendChild(nameEl)
    header.appendChild(timeEl)

    if (msg.generationMs) {
      const genEl = document.createElement('span')
      genEl.className = 'text-xs text-blue-400'
      genEl.textContent = `${(msg.generationMs / 1000).toFixed(1)}s`
      header.appendChild(genEl)
    }

    const content = document.createElement('div')
    content.className = 'text-gray-700'
    content.textContent = msg.content

    div.appendChild(header)
    div.appendChild(content)
  }

  messagesDiv.appendChild(div)
}

const renderTypingIndicators = () => {
  const currentRoomKey = `room:${selectedRoomId}`
  const typing: string[] = []

  for (const [agentName, info] of agentStates) {
    if (info.state === 'generating' && info.context === currentRoomKey) {
      typing.push(agentName)
    }
  }

  typingIndicators.textContent = typing.length > 0
    ? `${typing.join(', ')} ${typing.length === 1 ? 'is' : 'are'} thinking...`
    : ''
}

// === Event handlers ===

chatForm.onsubmit = (e) => {
  e.preventDefault()
  const content = chatInput.value.trim()
  if (!content || !selectedRoomId) return

  const room = rooms.get(selectedRoomId)
  if (!room) return

  send({
    type: 'post_message',
    target: { rooms: [room.name] },
    content,
  })
  chatInput.value = ''
}

document.getElementById('btn-create-room')!.onclick = () => roomModal.showModal()
document.getElementById('btn-create-agent')!.onclick = () => agentModal.showModal()

roomForm.onsubmit = (e) => {
  e.preventDefault()
  const data = new FormData(roomForm)
  send({
    type: 'create_room',
    name: data.get('name') as string,
    description: data.get('description') as string || undefined,
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
      description: data.get('description') as string || '',
      model: data.get('model') as string,
      systemPrompt: data.get('systemPrompt') as string,
      cooldownMs: 15000,
    },
  })
  agentModal.close()
  agentForm.reset()
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
