// ============================================================================
// Talking Agents — UI Application
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

// === State ===

let client: WSClient | null = null
let myAgentId = ''
let sessionToken = localStorage.getItem('ta_session') ?? ''
let selectedRoomId = ''
const rooms = new Map<string, RoomProfile>()
const agents = new Map<string, AgentInfo>()
const roomMessages = new Map<string, UIMessage[]>()
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

// === Render helpers (delegate to ui-renderer) ===

const send = (data: unknown) => client?.send(data)

const refreshRooms = () => renderRooms(roomList, rooms, selectedRoomId, selectRoom)

const refreshAgents = () => renderAgents(
  agentList, agents, agentStates,
  (name) => openPromptEditor(name, send),
  (id, name) => { send({ type: 'remove_agent', name }); agents.delete(id); refreshAgents() },
)

const refreshTyping = () => renderTypingIndicators(typingIndicators, agentStates, selectedRoomId)

// === Room selection ===

const selectRoom = (roomId: string) => {
  selectedRoomId = roomId
  const room = rooms.get(roomId)
  if (!room) return

  roomName.textContent = room.name
  roomDescription.textContent = room.description ?? ''
  refreshRooms()

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
      rooms.clear(); agents.clear(); agentStates.clear()
      for (const r of msg.rooms) rooms.set(r.id, r)
      for (const a of msg.agents) {
        agents.set(a.id, a)
        if (a.state === 'generating') agentStates.set(a.name, { state: 'generating' })
      }
      refreshRooms(); refreshAgents(); refreshTyping()
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
  send({ type: 'post_message', target: { rooms: [room.name] }, content })
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
      description: 'AI agent',
      model: data.get('model') as string,
      systemPrompt: data.get('systemPrompt') as string,
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
