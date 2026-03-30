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
}

export interface AgentInfo {
  id: string
  name: string
  kind: string
  state?: string
  model?: string
  tags?: ReadonlyArray<string>
}

export interface TaskItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'blocked'
  assignee?: string
}

export interface PollOption {
  id: string
  text: string
  votes: ReadonlyArray<string>
}

export interface ArtifactInfo {
  id: string
  type: string
  title: string
  description?: string
  body: unknown
  scope: ReadonlyArray<string>
  createdBy: string
  createdAt: number
  updatedAt: number
  resolution?: string
  resolvedAt?: number
}

export type ArtifactAction =
  | { kind: 'add_task'; artifactId: string; content: string }
  | { kind: 'complete_task'; artifactId: string; taskId: string; completed: boolean }
  | { kind: 'cast_vote'; artifactId: string; optionId: string }
  | { kind: 'remove'; artifactId: string }

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
    nameSpan.textContent = room.name

    div.appendChild(dot)
    div.appendChild(nameSpan)
    div.onclick = () => onSelect(room.id)
    container.appendChild(div)
  }
}

const renderTaskListArtifact = (
  artifact: ArtifactInfo,
  onAction: (action: ArtifactAction) => void,
): HTMLElement => {
  const tasks = ((artifact.body as { tasks?: TaskItem[] })?.tasks ?? [])
  const completed = tasks.filter(t => t.status === 'completed').length
  const wrap = document.createElement('div')
  wrap.className = 'group space-y-0.5'

  // Header row
  const header = document.createElement('div')
  header.className = 'flex items-center gap-1'
  const titleEl = document.createElement('span')
  titleEl.className = 'text-xs font-medium text-gray-700 flex-1'
  titleEl.textContent = artifact.title
  const progress = document.createElement('span')
  progress.className = 'text-xs text-gray-400'
  progress.textContent = tasks.length > 0 ? `${completed}/${tasks.length}` : '0 tasks'
  const removeBtn = document.createElement('button')
  removeBtn.className = 'text-xs text-red-300 hover:text-red-500 opacity-0 group-hover:opacity-100 ml-1 flex-shrink-0'
  removeBtn.textContent = '✕'
  removeBtn.onclick = () => onAction({ kind: 'remove', artifactId: artifact.id })
  header.appendChild(titleEl)
  header.appendChild(progress)
  header.appendChild(removeBtn)
  wrap.appendChild(header)

  for (const task of tasks) {
    const row = document.createElement('div')
    row.className = 'flex items-center gap-1.5 pl-2 text-xs'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = task.status === 'completed'
    cb.className = 'rounded flex-shrink-0'
    cb.onchange = () => onAction({ kind: 'complete_task', artifactId: artifact.id, taskId: task.id, completed: cb.checked })
    const label = document.createElement('span')
    label.className = `flex-1 ${task.status === 'completed' ? 'line-through text-gray-400' : task.status === 'blocked' ? 'text-red-400' : 'text-gray-700'}`
    label.textContent = task.content
    row.appendChild(cb)
    row.appendChild(label)
    if (task.assignee) {
      const badge = document.createElement('span')
      badge.className = 'text-xs bg-blue-50 text-blue-500 px-1 rounded flex-shrink-0'
      badge.textContent = task.assignee
      row.appendChild(badge)
    }
    wrap.appendChild(row)
  }
  if (!artifact.resolution) {
    const addRow = document.createElement('div')
    addRow.className = 'flex items-center gap-1 pl-2 pt-0.5'
    const input = document.createElement('input')
    input.type = 'text'
    input.placeholder = 'Add task…'
    input.className = 'flex-1 text-xs border-b border-transparent hover:border-gray-200 focus:border-blue-300 bg-transparent py-0.5 focus:outline-none'
    const submit = (e: Event): void => {
      e.stopPropagation()
      const content = input.value.trim()
      if (!content) return
      onAction({ kind: 'add_task', artifactId: artifact.id, content })
      input.value = ''
    }
    input.onkeydown = (e) => { if (e.key === 'Enter') submit(e) }
    addRow.appendChild(input)
    wrap.appendChild(addRow)
  } else {
    const res = document.createElement('div')
    res.className = 'text-xs text-green-600 pl-2 italic'
    res.textContent = `✓ ${artifact.resolution}`
    wrap.appendChild(res)
  }
  return wrap
}

const renderPollArtifact = (
  artifact: ArtifactInfo,
  myAgentId: string,
  onAction: (action: ArtifactAction) => void,
): HTMLElement => {
  const body = artifact.body as { question?: string; options?: PollOption[]; allowMultiple?: boolean }
  const wrap = document.createElement('div')
  wrap.className = 'group space-y-1'

  const header = document.createElement('div')
  header.className = 'flex items-center gap-1'
  const titleEl = document.createElement('span')
  titleEl.className = 'text-xs font-medium text-gray-700 flex-1'
  titleEl.textContent = artifact.title
  const removeBtn = document.createElement('button')
  removeBtn.className = 'text-xs text-red-300 hover:text-red-500 opacity-0 group-hover:opacity-100 ml-1 flex-shrink-0'
  removeBtn.textContent = '✕'
  removeBtn.onclick = () => onAction({ kind: 'remove', artifactId: artifact.id })
  header.appendChild(titleEl)
  header.appendChild(removeBtn)
  wrap.appendChild(header)

  if (body.question) {
    const q = document.createElement('div')
    q.className = 'text-xs text-gray-500 pl-2 italic'
    q.textContent = body.question
    wrap.appendChild(q)
  }

  for (const opt of (body.options ?? [])) {
    const row = document.createElement('div')
    row.className = 'flex items-center gap-1.5 pl-2 text-xs'
    const hasVoted = opt.votes.includes(myAgentId)
    const voteBtn = document.createElement('button')
    voteBtn.className = `px-1.5 py-0.5 rounded text-xs flex-shrink-0 ${hasVoted ? 'bg-blue-100 text-blue-600 font-medium' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`
    voteBtn.textContent = hasVoted ? '✓' : 'Vote'
    voteBtn.disabled = artifact.resolvedAt !== undefined
    voteBtn.onclick = () => onAction({ kind: 'cast_vote', artifactId: artifact.id, optionId: opt.id })
    const optLabel = document.createElement('span')
    optLabel.className = 'flex-1 text-gray-700'
    optLabel.textContent = opt.text
    const count = document.createElement('span')
    count.className = 'text-gray-400 flex-shrink-0'
    count.textContent = `${opt.votes.length}`
    row.appendChild(voteBtn)
    row.appendChild(optLabel)
    row.appendChild(count)
    wrap.appendChild(row)
  }

  if (artifact.resolution) {
    const res = document.createElement('div')
    res.className = 'text-xs text-green-600 pl-2 italic'
    res.textContent = `✓ ${artifact.resolution}`
    wrap.appendChild(res)
  }
  return wrap
}

const renderFlowArtifact = (artifact: ArtifactInfo, onAction: (action: ArtifactAction) => void): HTMLElement => {
  const body = artifact.body as { steps?: Array<{ agentName: string }>; loop?: boolean }
  const wrap = document.createElement('div')
  wrap.className = 'group'
  const row = document.createElement('div')
  row.className = 'flex items-center gap-1 text-xs'
  const titleEl = document.createElement('span')
  titleEl.className = 'font-medium text-purple-700 flex-1'
  titleEl.textContent = artifact.title
  const steps = (body.steps ?? []).map(s => s.agentName).join(' → ')
  const stepsEl = document.createElement('span')
  stepsEl.className = 'text-gray-400 truncate max-w-[120px]'
  stepsEl.title = steps
  stepsEl.textContent = steps
  const loopEl = body.loop ? document.createElement('span') : null
  if (loopEl) { loopEl.className = 'text-purple-400 flex-shrink-0'; loopEl.textContent = '↻' }
  const removeBtn = document.createElement('button')
  removeBtn.className = 'text-xs text-red-300 hover:text-red-500 opacity-0 group-hover:opacity-100 flex-shrink-0'
  removeBtn.textContent = '✕'
  removeBtn.onclick = () => onAction({ kind: 'remove', artifactId: artifact.id })
  row.appendChild(titleEl)
  row.appendChild(stepsEl)
  if (loopEl) row.appendChild(loopEl)
  row.appendChild(removeBtn)
  wrap.appendChild(row)
  return wrap
}

const renderGenericArtifact = (artifact: ArtifactInfo, onAction: (action: ArtifactAction) => void): HTMLElement => {
  const wrap = document.createElement('div')
  wrap.className = 'group flex items-center gap-1 text-xs'
  const titleEl = document.createElement('span')
  titleEl.className = 'flex-1 text-gray-700'
  titleEl.textContent = artifact.title
  const typeEl = document.createElement('span')
  typeEl.className = 'text-gray-400 flex-shrink-0'
  typeEl.textContent = `[${artifact.type}]`
  const removeBtn = document.createElement('button')
  removeBtn.className = 'text-xs text-red-300 hover:text-red-500 opacity-0 group-hover:opacity-100 flex-shrink-0'
  removeBtn.textContent = '✕'
  removeBtn.onclick = () => onAction({ kind: 'remove', artifactId: artifact.id })
  wrap.appendChild(titleEl)
  wrap.appendChild(typeEl)
  wrap.appendChild(removeBtn)
  return wrap
}

export const renderArtifacts = (
  container: HTMLElement,
  artifacts: ReadonlyArray<ArtifactInfo>,
  myAgentId: string,
  onAction: (action: ArtifactAction) => void,
): void => {
  container.innerHTML = ''
  for (const artifact of artifacts) {
    const wrap = document.createElement('div')
    wrap.className = 'py-1 border-b border-gray-100 last:border-0'
    let inner: HTMLElement
    if (artifact.type === 'task_list') inner = renderTaskListArtifact(artifact, onAction)
    else if (artifact.type === 'poll') inner = renderPollArtifact(artifact, myAgentId, onAction)
    else if (artifact.type === 'flow') inner = renderFlowArtifact(artifact, onAction)
    else inner = renderGenericArtifact(artifact, onAction)
    wrap.appendChild(inner)
    container.appendChild(wrap)
  }
}

const renderAgentRow = (
  agent: AgentInfo,
  agentStates: Map<string, { state: string; context?: string }>,
  mutedAgents: Set<string>,
  onEditPrompt: (agentName: string) => void,
  onRemove: (agentId: string, agentName: string) => void,
  onToggleMute: (agentName: string, muted: boolean) => void,
  onCancelGeneration: (agentName: string) => void,
  onEditModel: (agentName: string) => void,
  roomAction?: { inRoom: boolean; onAddToRoom?: (id: string, name: string) => void; onRemoveFromRoom?: (id: string, name: string) => void },
): HTMLElement => {
  const stateInfo = agentStates.get(agent.name)
  const isGenerating = stateInfo?.state === 'generating'
  const isMuted = mutedAgents.has(agent.name)

  const div = document.createElement('div')
  div.className = `px-3 py-2 border-b border-gray-100 relative ${isMuted ? 'agent-muted' : ''}`

  // Top-right action button: remove-from-room (in room) or add-to-room (available) or delete-agent (no room context)
  if (roomAction) {
    if (roomAction.inRoom && roomAction.onRemoveFromRoom) {
      const leaveBtn = document.createElement('button')
      leaveBtn.className = 'absolute top-1 right-1 w-5 h-5 flex items-center justify-center text-orange-300 hover:text-orange-600 text-xs leading-none rounded-full hover:bg-orange-50'
      leaveBtn.textContent = '✕'
      leaveBtn.title = `Remove ${agent.name} from room`
      leaveBtn.onclick = (e) => { e.stopPropagation(); roomAction.onRemoveFromRoom!(agent.id, agent.name) }
      div.appendChild(leaveBtn)
    } else if (!roomAction.inRoom && roomAction.onAddToRoom) {
      const addBtn = document.createElement('button')
      addBtn.className = 'absolute top-1 right-1 w-5 h-5 flex items-center justify-center text-green-400 hover:text-green-700 text-xs leading-none rounded-full hover:bg-green-50'
      addBtn.textContent = '+'
      addBtn.title = `Add ${agent.name} to room`
      addBtn.onclick = (e) => { e.stopPropagation(); roomAction.onAddToRoom!(agent.id, agent.name) }
      div.appendChild(addBtn)
    }
  } else if (agent.kind === 'ai') {
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

  if (agent.kind === 'ai') {
    const kindLabel = document.createElement('span')
    kindLabel.textContent = isGenerating ? 'ai — thinking...' : 'ai'
    kindRow.appendChild(kindLabel)

    if (agent.model) {
      const modelLabel = document.createElement('span')
      modelLabel.className = 'text-gray-300 cursor-pointer hover:text-purple-400 hover:underline ml-1 truncate max-w-[90px]'
      modelLabel.textContent = `· ${agent.model}`
      modelLabel.title = `Model: ${agent.model} (click to change)`
      modelLabel.onclick = (e) => { e.stopPropagation(); onEditModel(agent.name) }
      kindRow.appendChild(modelLabel)
    }

    if (isGenerating) {
      const stopBtn = document.createElement('button')
      stopBtn.className = 'text-red-400 hover:text-red-600 text-xs font-medium ml-1'
      stopBtn.textContent = '■ stop'
      stopBtn.title = `Cancel ${agent.name}'s generation`
      stopBtn.onclick = (e) => { e.stopPropagation(); onCancelGeneration(agent.name) }
      kindRow.appendChild(stopBtn)
    }
  } else {
    kindRow.textContent = agent.kind
  }

  div.appendChild(nameRow)
  div.appendChild(kindRow)

  if (agent.tags && agent.tags.length > 0) {
    const tagRow = document.createElement('div')
    tagRow.className = 'flex flex-wrap gap-1 mt-0.5'
    for (const tag of agent.tags) {
      const chip = document.createElement('span')
      chip.className = 'text-xs bg-purple-900/40 text-purple-300 px-1.5 py-0 rounded cursor-default'
      chip.title = `Tag: ${tag} — address with [[tag:${tag}]]`
      chip.textContent = tag
      tagRow.appendChild(chip)
    }
    div.appendChild(tagRow)
  }

  return div
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
  onEditModel: (agentName: string) => void,
  roomMemberIds?: Set<string>,
  onAddToRoom?: (agentId: string, agentName: string) => void,
  onRemoveFromRoom?: (agentId: string, agentName: string) => void,
): void => {
  container.innerHTML = ''

  if (roomMemberIds) {
    // Room-aware mode: split into two sections
    const inRoom = [...agents.values()].filter(a => roomMemberIds.has(a.id))
    const available = [...agents.values()].filter(a => !roomMemberIds.has(a.id))

    const makeHeader = (text: string): HTMLElement => {
      const h = document.createElement('div')
      h.className = 'px-3 py-1 text-xs font-semibold text-gray-400 uppercase tracking-wide bg-gray-50 border-b border-gray-100'
      h.textContent = text
      return h
    }

    container.appendChild(makeHeader(`In room (${inRoom.length})`))
    for (const agent of inRoom) {
      container.appendChild(renderAgentRow(
        agent, agentStates, mutedAgents,
        onEditPrompt, onRemove, onToggleMute, onCancelGeneration, onEditModel,
        { inRoom: true, onRemoveFromRoom },
      ))
    }

    container.appendChild(makeHeader(`Available (${available.length})`))
    for (const agent of available) {
      container.appendChild(renderAgentRow(
        agent, agentStates, mutedAgents,
        onEditPrompt, onRemove, onToggleMute, onCancelGeneration, onEditModel,
        { inRoom: false, onAddToRoom },
      ))
    }
  } else {
    for (const agent of agents.values()) {
      container.appendChild(renderAgentRow(
        agent, agentStates, mutedAgents,
        onEditPrompt, onRemove, onToggleMute, onCancelGeneration, onEditModel,
      ))
    }
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

export const openModelEditor = (
  agentName: string,
  send: (data: unknown) => void,
): void => {
  const modal = createModal({ title: `Model — ${agentName}` })

  const select = document.createElement('select')
  select.className = 'w-full px-3 py-2 border rounded text-sm focus:outline-none focus:ring-2 focus:ring-purple-300'
  select.innerHTML = '<option value="">Loading models…</option>'
  modal.body.appendChild(select)

  const buttons = createButtonRow(
    modal.close,
    () => {
      if (select.value) {
        send({ type: 'update_agent', name: agentName, model: select.value })
      }
      modal.close()
    },
    'Change Model',
  )
  modal.body.appendChild(buttons)
  document.body.appendChild(modal.overlay)

  // Fetch current model + available models in parallel
  Promise.all([
    fetch(`/api/agents/${encodeURIComponent(agentName)}`).then(r => r.ok ? r.json() : null),
    fetch('/api/models').then(r => r.ok ? r.json() : { running: [], available: [] }),
  ]).then(([agentData, modelsData]: [{ model?: string } | null, { running: string[]; available: string[] }]) => {
    select.innerHTML = ''
    const { running = [], available = [] } = modelsData
    if (running.length > 0) {
      const group = document.createElement('optgroup')
      group.label = 'Running'
      for (const m of running) {
        const opt = document.createElement('option')
        opt.value = m; opt.textContent = m
        if (m === agentData?.model) opt.selected = true
        group.appendChild(opt)
      }
      select.appendChild(group)
    }
    if (available.length > 0) {
      const group = document.createElement('optgroup')
      group.label = 'Available'
      for (const m of available) {
        const opt = document.createElement('option')
        opt.value = m; opt.textContent = m
        if (m === agentData?.model) opt.selected = true
        group.appendChild(opt)
      }
      select.appendChild(group)
    }
    if (running.length === 0 && available.length === 0) {
      select.innerHTML = '<option value="">No models found</option>'
    }
  }).catch(() => {
    select.innerHTML = '<option value="">Failed to load models</option>'
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
  onSave: (name: string, steps: ReadonlyArray<{ agentId: string; agentName: string; stepPrompt?: string }>, loop: boolean, description?: string) => void,
  existingName?: string,
  existingSteps?: ReadonlyArray<FlowStepInput>,
  existingLoop?: boolean,
  existingDescription?: string,
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

  // Description
  const descInput = document.createElement('input')
  descInput.className = 'w-full px-3 py-2 border rounded text-sm mb-3 focus:outline-none focus:ring-1 focus:ring-purple-300'
  descInput.placeholder = 'Description / goal (optional)'
  descInput.value = existingDescription ?? ''

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
      const desc = descInput.value.trim() || undefined
      onSave(flowName, cleanSteps, loopCheckbox.checked, desc)
      close()
    },
    'Save Flow',
    'bg-purple-500 hover:bg-purple-600',
  )

  modal.appendChild(nameInput)
  modal.appendChild(descInput)
  modal.appendChild(loopRow)
  modal.appendChild(stepsContainer)
  modal.appendChild(addStepBtn)
  modal.appendChild(btnRow)
  overlay.appendChild(modal)
  document.body.appendChild(overlay)

  renderSteps()
  nameInput.focus()
}

