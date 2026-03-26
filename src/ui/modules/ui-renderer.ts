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
  mutedAgents: Set<string>,
  onEditPrompt: (agentName: string) => void,
  onRemove: (agentId: string, agentName: string) => void,
  onToggleMute: (agentName: string, muted: boolean) => void,
): void => {
  container.innerHTML = ''
  for (const agent of agents.values()) {
    const stateInfo = agentStates.get(agent.name)
    const isGenerating = stateInfo?.state === 'generating'
    const isMuted = mutedAgents.has(agent.name)

    const div = document.createElement('div')
    div.className = `px-3 py-2 border-b border-gray-100 ${isMuted ? 'agent-muted' : ''}`

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

    {
      const btnRow = document.createElement('div')
      btnRow.className = 'flex gap-2 mt-1'

      const muteBtn = document.createElement('button')
      muteBtn.className = `mute-btn ${isMuted ? 'muted' : ''}`
      muteBtn.textContent = isMuted ? 'Unmute' : 'Mute'
      muteBtn.onclick = (e) => { e.stopPropagation(); onToggleMute(agent.name, !isMuted) }
      btnRow.appendChild(muteBtn)

      if (agent.kind === 'ai') {
        const removeBtn = document.createElement('button')
        removeBtn.className = 'text-xs text-red-400 hover:text-red-600'
        removeBtn.textContent = 'Remove'
        removeBtn.onclick = (e) => { e.stopPropagation(); onRemove(agent.id, agent.name) }
        btnRow.appendChild(removeBtn)
      }

      div.appendChild(btnRow)
    }

    container.appendChild(div)
  }
}

// Render Markdown content safely. Falls back to textContent if libraries not loaded.
const renderMarkdownContent = (el: HTMLElement, text: string): void => {
  const w = globalThis as unknown as Record<string, unknown>
  const markedLib = w.marked as { parse?: (src: string) => string } | undefined
  const purifyLib = w.DOMPurify as { sanitize?: (html: string) => string } | undefined

  if (markedLib?.parse && purifyLib?.sanitize) {
    el.className += ' msg-prose'
    el.innerHTML = purifyLib.sanitize(markedLib.parse(text))
  } else {
    el.textContent = text
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
  const isMute = msg.type === 'mute'
  const isSelf = msg.senderId === myAgentId
  const isRoomSummary = msg.type === 'room_summary'

  if (isPass) {
    const senderInfo = agents.get(msg.senderId)
    const senderName = senderInfo?.name ?? msg.senderId
    div.className = 'msg-pass text-xs py-1 px-2'
    div.textContent = `${senderName} ${msg.content}`
  } else if (isMute) {
    div.className = 'msg-system text-xs py-1 px-2 text-gray-400'
    div.textContent = msg.content
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
    renderMarkdownContent(content, msg.content)

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

// === Flow Editor Modal ===
// Full editor: name the flow, add ordered steps with agent selection + step prompts,
// toggle loop, reorder with up/down buttons. Saves via callback.

interface FlowStepInput {
  agentName: string
  stepPrompt: string
}

export const openFlowEditorModal = (
  agents: Map<string, AgentInfo>,
  myAgentId: string,
  onSave: (name: string, steps: ReadonlyArray<{ agentName: string; stepPrompt?: string }>, loop: boolean) => void,
  existingName?: string,
  existingSteps?: ReadonlyArray<FlowStepInput>,
  existingLoop?: boolean,
): void => {
  const steps: FlowStepInput[] = existingSteps
    ? existingSteps.map(s => ({ ...s }))
    : []

  const agentNames = [...agents.values()].map(a => a.name)

  const overlay = document.createElement('div')
  overlay.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50'
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove() }

  const modal = document.createElement('div')
  modal.className = 'bg-white rounded-lg shadow-xl p-6 w-full max-w-lg mx-4 max-h-[90vh] flex flex-col'
  modal.onclick = (e) => e.stopPropagation()

  // Title
  const title = document.createElement('h3')
  title.className = 'text-lg font-semibold mb-3'
  title.textContent = existingName ? `Edit Flow: ${existingName}` : 'Create Flow'

  // Flow name
  const nameInput = document.createElement('input')
  nameInput.className = 'w-full px-3 py-2 border rounded text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-purple-300'
  nameInput.placeholder = 'Flow name'
  nameInput.value = existingName ?? ''

  // Loop toggle
  const loopRow = document.createElement('label')
  loopRow.className = 'flex items-center gap-2 text-sm mb-3 cursor-pointer'
  const loopCheckbox = document.createElement('input')
  loopCheckbox.type = 'checkbox'
  loopCheckbox.checked = existingLoop ?? false
  loopRow.appendChild(loopCheckbox)
  loopRow.appendChild(document.createTextNode('Loop (repeat continuously)'))

  // Steps list
  const stepsContainer = document.createElement('div')
  stepsContainer.className = 'flex-1 overflow-y-auto space-y-2 mb-3 min-h-0'

  const renderSteps = (): void => {
    stepsContainer.innerHTML = ''
    steps.forEach((step, i) => {
      const row = document.createElement('div')
      row.className = 'flex gap-2 items-start bg-gray-50 rounded p-2'

      // Step number
      const num = document.createElement('span')
      num.className = 'text-xs text-gray-400 font-mono pt-2 w-5 text-right shrink-0'
      num.textContent = `${i + 1}.`

      // Agent selector
      const select = document.createElement('select')
      select.className = 'text-sm border rounded px-2 py-1 bg-white shrink-0'
      for (const name of agentNames) {
        const opt = document.createElement('option')
        opt.value = name
        opt.textContent = name
        if (name === step.agentName) opt.selected = true
        select.appendChild(opt)
      }
      select.onchange = () => { step.agentName = select.value }

      // Step prompt
      const promptInput = document.createElement('input')
      promptInput.className = 'flex-1 text-sm border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-purple-300'
      promptInput.placeholder = 'Step prompt (optional)'
      promptInput.value = step.stepPrompt
      promptInput.oninput = () => { step.stepPrompt = promptInput.value }

      // Up/Down/Remove buttons
      const controls = document.createElement('div')
      controls.className = 'flex flex-col gap-0.5 shrink-0'

      const upBtn = document.createElement('button')
      upBtn.type = 'button'
      upBtn.className = 'text-xs text-gray-400 hover:text-gray-700 leading-none'
      upBtn.textContent = '▲'
      upBtn.onclick = () => {
        if (i > 0) { [steps[i - 1]!, steps[i]!] = [steps[i]!, steps[i - 1]!]; renderSteps() }
      }

      const downBtn = document.createElement('button')
      downBtn.type = 'button'
      downBtn.className = 'text-xs text-gray-400 hover:text-gray-700 leading-none'
      downBtn.textContent = '▼'
      downBtn.onclick = () => {
        if (i < steps.length - 1) { [steps[i]!, steps[i + 1]!] = [steps[i + 1]!, steps[i]!]; renderSteps() }
      }

      const removeBtn = document.createElement('button')
      removeBtn.type = 'button'
      removeBtn.className = 'text-xs text-red-400 hover:text-red-600 leading-none'
      removeBtn.textContent = '✕'
      removeBtn.onclick = () => { steps.splice(i, 1); renderSteps() }

      controls.appendChild(upBtn)
      controls.appendChild(downBtn)
      controls.appendChild(removeBtn)

      row.appendChild(num)
      row.appendChild(select)
      row.appendChild(promptInput)
      row.appendChild(controls)
      stepsContainer.appendChild(row)
    })

    if (steps.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'text-sm text-gray-400 text-center py-4'
      empty.textContent = 'No steps yet. Click "+ Add Step" to start building your flow.'
      stepsContainer.appendChild(empty)
    }
  }

  // Add step button
  const addStepBtn = document.createElement('button')
  addStepBtn.type = 'button'
  addStepBtn.className = 'text-xs bg-purple-100 text-purple-700 px-3 py-1 rounded hover:bg-purple-200 mb-3'
  addStepBtn.textContent = '+ Add Step'
  addStepBtn.onclick = () => {
    const defaultName = agentNames[0] ?? ''
    steps.push({ agentName: defaultName, stepPrompt: '' })
    renderSteps()
    stepsContainer.scrollTop = stepsContainer.scrollHeight
  }

  // Bottom buttons
  const btnRow = document.createElement('div')
  btnRow.className = 'flex justify-end gap-2'

  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'px-4 py-2 text-sm text-gray-600 hover:text-gray-800'
  cancelBtn.textContent = 'Cancel'
  cancelBtn.onclick = () => overlay.remove()

  const saveBtn = document.createElement('button')
  saveBtn.type = 'button'
  saveBtn.className = 'px-4 py-2 text-sm bg-purple-500 text-white rounded hover:bg-purple-600'
  saveBtn.textContent = 'Save Flow'
  saveBtn.onclick = () => {
    const flowName = nameInput.value.trim()
    if (!flowName) { nameInput.focus(); return }
    if (steps.length === 0) return
    const cleanSteps = steps.map(s => ({
      agentName: s.agentName,
      ...(s.stepPrompt.trim() ? { stepPrompt: s.stepPrompt.trim() } : {}),
    }))
    onSave(flowName, cleanSteps, loopCheckbox.checked)
    overlay.remove()
  }

  btnRow.appendChild(cancelBtn)
  btnRow.appendChild(saveBtn)

  modal.appendChild(title)
  modal.appendChild(nameInput)
  modal.appendChild(loopRow)
  modal.appendChild(stepsContainer)
  modal.appendChild(addStepBtn)
  modal.appendChild(btnRow)
  overlay.appendChild(modal)
  document.body.appendChild(overlay)

  renderSteps()
  nameInput.focus()
}

// === Targeted Send Modal ===
// Shows a modal with agent checkboxes. Calls onSend with selected agent names.

export const openTargetedSendModal = (
  agents: Map<string, AgentInfo>,
  mutedAgents: Set<string>,
  myAgentId: string,
  onSend: (agentNames: ReadonlyArray<string>) => void,
): void => {
  const overlay = document.createElement('div')
  overlay.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50'
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove() }

  const modal = document.createElement('div')
  modal.className = 'bg-white rounded-lg shadow-xl p-6 w-full max-w-sm mx-4'

  const title = document.createElement('h3')
  title.className = 'text-lg font-semibold mb-3'
  title.textContent = 'Send to...'

  const list = document.createElement('div')
  list.className = 'space-y-2 max-h-64 overflow-y-auto'

  const checkboxes: Array<{ name: string; checkbox: HTMLInputElement }> = []
  for (const agent of agents.values()) {
    if (agent.id === myAgentId) continue
    if (mutedAgents.has(agent.name)) continue

    const label = document.createElement('label')
    label.className = 'flex items-center gap-2 text-sm cursor-pointer hover:bg-gray-50 p-1 rounded'

    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.className = 'rounded'

    const nameSpan = document.createElement('span')
    nameSpan.textContent = agent.name

    const kindSpan = document.createElement('span')
    kindSpan.className = 'text-xs text-gray-400'
    kindSpan.textContent = `(${agent.kind})`

    label.appendChild(checkbox)
    label.appendChild(nameSpan)
    label.appendChild(kindSpan)
    list.appendChild(label)
    checkboxes.push({ name: agent.name, checkbox })
  }

  const btnRow = document.createElement('div')
  btnRow.className = 'flex justify-end gap-2 mt-4'

  const cancelBtn = document.createElement('button')
  cancelBtn.className = 'px-4 py-2 text-sm text-gray-600 hover:text-gray-800'
  cancelBtn.textContent = 'Cancel'
  cancelBtn.onclick = () => overlay.remove()

  const sendBtn = document.createElement('button')
  sendBtn.className = 'px-4 py-2 text-sm bg-blue-500 text-white rounded hover:bg-blue-600'
  sendBtn.textContent = 'Send'
  sendBtn.onclick = () => {
    const selected = checkboxes.filter(c => c.checkbox.checked).map(c => c.name)
    if (selected.length > 0) {
      onSend(selected)
    }
    overlay.remove()
  }

  btnRow.appendChild(cancelBtn)
  btnRow.appendChild(sendBtn)
  modal.appendChild(title)
  modal.appendChild(list)
  modal.appendChild(btnRow)
  overlay.appendChild(modal)
  document.body.appendChild(overlay)
}
