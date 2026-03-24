// ============================================================================
// UI Renderer — DOM rendering functions for rooms, agents, and messages.
// ============================================================================

// === Types (mirror of server-side, minimal) ===

export interface UIMessage {
  id: string
  senderId: string
  content: string
  timestamp: number
  type: string
  roomId?: string
  recipientId?: string
  generationMs?: number
}

export interface RoomProfile {
  id: string
  name: string
  description?: string
  visibility: string
}

export interface AgentInfo {
  id: string
  name: string
  description: string
  kind: string
  state?: string
}

// === Rendering ===

export const renderRooms = (
  container: HTMLElement,
  rooms: Map<string, RoomProfile>,
  selectedRoomId: string,
  onSelect: (roomId: string) => void,
): void => {
  container.innerHTML = ''
  for (const room of rooms.values()) {
    const div = document.createElement('div')
    div.className = `px-3 py-2 cursor-pointer text-sm hover:bg-gray-100 ${room.id === selectedRoomId ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700'}`
    div.textContent = `${room.visibility === 'private' ? '🔒 ' : ''}${room.name}`
    div.onclick = () => onSelect(room.id)
    container.appendChild(div)
  }
}

export const renderAgents = (
  container: HTMLElement,
  agents: Map<string, AgentInfo>,
  agentStates: Map<string, { state: string; context?: string }>,
  onEditPrompt: (agentName: string) => void,
  onRemove: (agentId: string, agentName: string) => void,
): void => {
  container.innerHTML = ''
  for (const agent of agents.values()) {
    const stateInfo = agentStates.get(agent.name)
    const isGenerating = stateInfo?.state === 'generating'

    const div = document.createElement('div')
    div.className = 'px-3 py-2 border-b border-gray-100'

    const nameRow = document.createElement('div')
    nameRow.className = 'text-sm font-medium text-gray-800 flex items-center gap-1'
    const dot = document.createElement('span')
    dot.className = `inline-block w-2 h-2 rounded-full ${isGenerating ? 'bg-yellow-400 typing-indicator' : 'bg-green-400'}`
    nameRow.appendChild(dot)
    nameRow.appendChild(document.createTextNode(` ${agent.name}`))

    if (agent.kind === 'ai') {
      // ? icon with hover tooltip showing system prompt, click opens editor
      const promptWrapper = document.createElement('span')
      promptWrapper.style.position = 'relative'
      promptWrapper.style.display = 'inline-flex'

      const promptIcon = document.createElement('span')
      promptIcon.className = 'prompt-icon'
      promptIcon.textContent = '?'
      promptIcon.title = ''
      promptIcon.onclick = (e) => { e.stopPropagation(); onEditPrompt(agent.name) }

      const tooltip = document.createElement('div')
      tooltip.className = 'prompt-tooltip'
      tooltip.textContent = agent.description === 'AI agent' ? '(click to set prompt)' : agent.description
      // Fetch actual system prompt for tooltip on hover
      promptIcon.onmouseenter = () => {
        fetch(`/api/agents/${encodeURIComponent(agent.name)}`)
          .then(res => res.ok ? res.json() : null)
          .then(data => {
            if (data?.systemPrompt) {
              const text = data.systemPrompt as string
              tooltip.textContent = text.length > 200 ? text.slice(0, 200) + '…' : text
            }
          })
          .catch(() => {})
      }

      promptWrapper.appendChild(promptIcon)
      promptWrapper.appendChild(tooltip)
      nameRow.appendChild(promptWrapper)
    }

    const kindSpan = document.createElement('div')
    kindSpan.className = 'text-xs text-gray-400'
    kindSpan.textContent = `${agent.kind}${isGenerating ? ' — thinking...' : ''}`

    div.appendChild(nameRow)
    div.appendChild(kindSpan)

    if (agent.kind === 'ai') {
      const btnRow = document.createElement('div')
      btnRow.className = 'flex gap-2 mt-1'

      const removeBtn = document.createElement('button')
      removeBtn.className = 'text-xs text-red-400 hover:text-red-600'
      removeBtn.textContent = 'Remove'
      removeBtn.onclick = (e) => { e.stopPropagation(); onRemove(agent.id, agent.name) }
      btnRow.appendChild(removeBtn)

      div.appendChild(btnRow)
    }

    container.appendChild(div)
  }
}

export const renderMessage = (
  container: HTMLElement,
  msg: UIMessage,
  myAgentId: string,
  agents: Map<string, AgentInfo>,
): void => {
  const div = document.createElement('div')
  const isSystem = msg.type === 'system' || msg.type === 'join' || msg.type === 'leave' || msg.senderId === 'system'
  const isPass = msg.type === 'pass'
  const isSelf = msg.senderId === myAgentId
  const isRoomSummary = msg.type === 'room_summary'

  if (isPass) {
    const senderInfo = agents.get(msg.senderId)
    const senderName = senderInfo?.name ?? msg.senderId
    div.className = 'msg-pass text-xs py-1 px-2'
    div.textContent = `${senderName} ${msg.content}`
  } else if (isSystem || isRoomSummary) {
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

  container.appendChild(div)
}

export const renderTypingIndicators = (
  container: HTMLElement,
  agentStates: Map<string, { state: string; context?: string }>,
  selectedRoomId: string,
): void => {
  const currentRoomKey = `room:${selectedRoomId}`
  const typing: string[] = []

  for (const [agentName, info] of agentStates) {
    if (info.state === 'generating' && info.context === currentRoomKey) {
      typing.push(agentName)
    }
  }

  container.textContent = typing.length > 0
    ? `${typing.join(', ')} ${typing.length === 1 ? 'is' : 'are'} thinking...`
    : ''
}

export const openPromptEditor = (
  agentName: string,
  send: (data: unknown) => void,
): void => {
  fetch(`/api/agents/${encodeURIComponent(agentName)}`)
    .then(res => res.ok ? res.json() : null)
    .then(data => {
      if (!data) return
      const currentPrompt = data.systemPrompt ?? ''

      const overlay = document.createElement('div')
      overlay.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50'
      overlay.onclick = (e) => { if (e.target === overlay) overlay.remove() }

      const modal = document.createElement('div')
      modal.className = 'bg-white rounded-lg shadow-xl p-6 w-full max-w-lg mx-4'

      const title = document.createElement('h3')
      title.className = 'text-lg font-semibold mb-3'
      title.textContent = `System Prompt — ${agentName}`

      const textarea = document.createElement('textarea')
      textarea.className = 'w-full h-48 border rounded p-3 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-blue-300'
      textarea.value = currentPrompt

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
        send({ type: 'update_agent', name: agentName, systemPrompt: textarea.value })
        overlay.remove()
      }

      btnRow.appendChild(cancelBtn)
      btnRow.appendChild(saveBtn)
      modal.appendChild(title)
      modal.appendChild(textarea)
      modal.appendChild(btnRow)
      overlay.appendChild(modal)
      document.body.appendChild(overlay)
      textarea.focus()
    })
}
