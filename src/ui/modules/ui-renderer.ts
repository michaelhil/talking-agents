// ============================================================================
// UI Renderer — DOM rendering functions for rooms, agents, and messages.
// ============================================================================

import { createModal, createButtonRow, createTextarea } from './modal.ts'

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
  visibility: string
}

export interface AgentInfo {
  id: string
  name: string
  kind: string
  state?: string
}

// === Rendering ===

export const renderRooms = (
  container: HTMLElement,
  rooms: Map<string, RoomProfile>,
  selectedRoomId: string,
  pausedRooms: Set<string>,
  onSelect: (roomId: string) => void,
): void => {
  container.innerHTML = ''
  for (const room of rooms.values()) {
    const isPaused = pausedRooms.has(room.id)
    const isSelected = room.id === selectedRoomId
    const div = document.createElement('div')
    div.className = `px-3 py-2 cursor-pointer text-sm hover:bg-gray-100 flex items-center gap-1.5 ${isSelected ? 'bg-blue-50 font-medium' : ''} ${isPaused ? 'text-gray-400' : isSelected ? 'text-blue-700' : 'text-gray-700'}`

    const dot = document.createElement('span')
    dot.className = `inline-block w-2 h-2 rounded-full flex-shrink-0 ${isPaused ? 'bg-gray-300' : 'bg-green-400'}`
    dot.title = isPaused ? 'Paused' : 'Active'

    const nameSpan = document.createElement('span')
    nameSpan.textContent = `${room.visibility === 'private' ? '🔒 ' : ''}${room.name}`

    div.appendChild(dot)
    div.appendChild(nameSpan)
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
  onCancelGeneration: (agentName: string) => void,
): void => {
  container.innerHTML = ''
  for (const agent of agents.values()) {
    const stateInfo = agentStates.get(agent.name)
    const isGenerating = stateInfo?.state === 'generating'
    const isMuted = mutedAgents.has(agent.name)

    const div = document.createElement('div')
    div.className = `px-3 py-2 border-b border-gray-100 relative ${isMuted ? 'agent-muted' : ''}`

    if (agent.kind === 'ai') {
      const closeBtn = document.createElement('button')
      closeBtn.className = 'absolute top-1 right-1 w-5 h-5 flex items-center justify-center text-red-300 hover:text-red-600 text-xs leading-none rounded-full hover:bg-red-50'
      closeBtn.textContent = '✕'
      closeBtn.title = `Remove ${agent.name}`
      closeBtn.onclick = (e) => {
        e.stopPropagation()
        if (confirm(`Remove agent "${agent.name}"? This cannot be undone.`)) {
          onRemove(agent.id, agent.name)
        }
      }
      div.appendChild(closeBtn)
    }

    const nameRow = document.createElement('div')
    nameRow.className = 'text-sm font-medium text-gray-800 flex items-center gap-1'
    const dot = document.createElement('span')
    const dotColor = isMuted ? 'bg-gray-300' : isGenerating ? 'bg-yellow-400 typing-indicator' : 'bg-green-400'
    dot.className = `inline-block w-2.5 h-2.5 rounded-full ${dotColor}`
    if (agent.kind !== 'human') {
      dot.style.cursor = 'pointer'
      dot.title = isMuted ? `Unmute ${agent.name}` : `Mute ${agent.name}`
      dot.onclick = (e) => { e.stopPropagation(); onToggleMute(agent.name, !isMuted) }
    }
    nameRow.appendChild(dot)
    const nameText = document.createElement('span')
    nameText.textContent = ` ${agent.name}`
    if (isMuted) nameText.style.textDecoration = 'line-through'
    nameRow.appendChild(nameText)

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
      tooltip.textContent = agent.kind
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

    const kindRow = document.createElement('div')
    kindRow.className = 'text-xs text-gray-400 flex items-center gap-1'
    kindRow.textContent = `${agent.kind}${isGenerating ? ' — thinking...' : ''}`

    if (isGenerating && agent.kind === 'ai') {
      const stopBtn = document.createElement('button')
      stopBtn.className = 'text-red-400 hover:text-red-600 text-xs font-medium ml-1'
      stopBtn.textContent = '■ stop'
      stopBtn.title = `Cancel ${agent.name}'s generation`
      stopBtn.onclick = (e) => { e.stopPropagation(); onCancelGeneration(agent.name) }
      kindRow.appendChild(stopBtn)
    }

    div.appendChild(nameRow)
    div.appendChild(kindRow)

    // Mute toggle is handled via the status dot — no separate button needed

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
      const modal = createModal({ title: `System Prompt — ${agentName}` })
      const textarea = createTextarea(data.systemPrompt ?? '')
      const buttons = createButtonRow(
        modal.close,
        () => { send({ type: 'update_agent', name: agentName, systemPrompt: textarea.value }); modal.close() },
      )
      modal.body.appendChild(textarea)
      modal.body.appendChild(buttons)
      document.body.appendChild(modal.overlay)
      textarea.focus()
    })
}

// === Flow Editor Modal ===
// Full editor: name the flow, add ordered steps with agent selection + step prompts,
// toggle loop, reorder with up/down buttons. Saves via callback.

interface FlowStepInput {
  agentId: string
  agentName: string
  stepPrompt: string
}

export const openFlowEditorModal = (
  agents: Map<string, AgentInfo>,
  myAgentId: string,
  onSave: (name: string, steps: ReadonlyArray<{ agentId: string; agentName: string; stepPrompt?: string }>, loop: boolean) => void,
  existingName?: string,
  existingSteps?: ReadonlyArray<FlowStepInput>,
  existingLoop?: boolean,
): void => {
  const steps: FlowStepInput[] = existingSteps
    ? existingSteps.map(s => ({ ...s }))
    : [...agents.values()].map(a => ({ agentId: a.id, agentName: a.name, stepPrompt: '' }))

  const { overlay, body: modal, close } = createModal({
    title: existingName ? `Edit Flow: ${existingName}` : 'Create Flow',
  })
  // Override card style for scrollable flow content
  modal.className = 'bg-white rounded-lg shadow-xl p-6 w-full max-w-lg mx-4 max-h-[90vh] flex flex-col'
  modal.onclick = (e) => e.stopPropagation()

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
      for (const agent of agents.values()) {
        const opt = document.createElement('option')
        opt.value = agent.id
        opt.textContent = agent.name
        if (agent.id === step.agentId) opt.selected = true
        select.appendChild(opt)
      }
      select.onchange = () => {
        const selectedAgent = [...agents.values()].find(a => a.id === select.value)
        if (selectedAgent) { step.agentId = selectedAgent.id; step.agentName = selectedAgent.name }
      }

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

      const dupBtn = document.createElement('button')
      dupBtn.type = 'button'
      dupBtn.className = 'text-xs text-purple-400 hover:text-purple-600 leading-none'
      dupBtn.title = 'Duplicate step'
      dupBtn.textContent = '⧉'
      dupBtn.onclick = () => { steps.splice(i + 1, 0, { ...step, stepPrompt: step.stepPrompt }); renderSteps() }

      const removeBtn = document.createElement('button')
      removeBtn.type = 'button'
      removeBtn.className = 'text-xs text-red-400 hover:text-red-600 leading-none'
      removeBtn.textContent = '✕'
      removeBtn.onclick = () => { steps.splice(i, 1); renderSteps() }

      controls.appendChild(upBtn)
      controls.appendChild(downBtn)
      controls.appendChild(dupBtn)
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
    const defaultAgent = [...agents.values()].find(a => a.kind === 'ai') ?? [...agents.values()][0]
    if (!defaultAgent) return
    steps.push({ agentId: defaultAgent.id, agentName: defaultAgent.name, stepPrompt: '' })
    renderSteps()
    stepsContainer.scrollTop = stepsContainer.scrollHeight
  }

  // Bottom buttons
  const btnRow = createButtonRow(
    close,
    () => {
      const flowName = nameInput.value.trim()
      if (!flowName) { nameInput.focus(); return }
      if (steps.length === 0) return
      const cleanSteps = steps.map(s => ({
        agentName: s.agentName,
        ...(s.stepPrompt.trim() ? { stepPrompt: s.stepPrompt.trim() } : {}),
      }))
      onSave(flowName, cleanSteps, loopCheckbox.checked)
      close()
    },
    'Save Flow',
    'bg-purple-500 hover:bg-purple-600',
  )

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

