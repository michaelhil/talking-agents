// ============================================================================
// UI Renderer — DOM rendering functions for rooms, agents, and messages.
//
// Artifact-type renderers are in artifact-renderers.ts.
// ============================================================================

import {
  renderTaskListArtifact,
  renderPollArtifact,
  renderFlowArtifact,
  renderDocumentArtifact,
  renderMermaidArtifact,
  renderGenericArtifact,
} from './artifact-renderers.ts'


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
  state: string
  model?: string
  context?: string
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
  | { kind: 'edit_document'; artifactId: string; title: string; blocks: ReadonlyArray<{ id: string; type: string; content: string }> }

// === Rendering ===

export interface RenderRoomsOptions {
  rooms: Record<string, RoomProfile>
  selectedRoomId: string | null
  pausedRooms: Set<string>
  unreadCounts: Record<string, number>
  generatingRoomIds: Set<string>
  onSelect: (roomId: string) => void
  onDelete?: (roomId: string, roomName: string) => void
}

export const renderRooms = (
  container: HTMLElement,
  opts: RenderRoomsOptions,
): void => {
  container.innerHTML = ''
  for (const room of Object.values(opts.rooms)) {
    const isPaused = opts.pausedRooms.has(room.id)
    const isSelected = room.id === opts.selectedRoomId
    const unread = opts.unreadCounts[room.id] ?? 0
    const isThinking = opts.generatingRoomIds.has(room.id)
    const div = document.createElement('div')
    div.className = `px-3 py-1 cursor-pointer text-xs flex items-center gap-1.5 group relative ${isSelected ? 'bg-blue-50 font-semibold text-blue-700' : 'text-gray-600 hover:bg-gray-50'}`

    const dot = document.createElement('span')
    const dotColor = isPaused ? 'bg-gray-300' : isThinking ? 'bg-yellow-400 typing-indicator' : 'bg-green-400'
    dot.className = `inline-block w-2 h-2 rounded-full shrink-0 ${dotColor}`
    div.appendChild(dot)

    const name = document.createElement('span')
    name.className = 'truncate flex-1'
    name.textContent = unread > 0 ? `${room.name} (${unread})` : room.name
    if (unread > 0) name.className += ' font-bold'
    div.appendChild(name)

    if (opts.onDelete) {
      const del = document.createElement('button')
      del.className = 'text-red-300 hover:text-red-500 text-xs opacity-0 group-hover:opacity-100 shrink-0'
      del.textContent = '×'
      del.title = 'Delete room'
      del.onclick = (e) => { e.stopPropagation(); opts.onDelete!(room.id, room.name) }
      div.appendChild(del)
    }

    div.onclick = () => opts.onSelect(room.id)
    container.appendChild(div)
  }
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
    else if (artifact.type === 'document') inner = renderDocumentArtifact(artifact, onAction)
    else if (artifact.type === 'mermaid') inner = renderMermaidArtifact(artifact, onAction)
    else inner = renderGenericArtifact(artifact, onAction)
    wrap.appendChild(inner)
    container.appendChild(wrap)
  }
}

// === Compact agent row (one line) ===

const renderAgentRow = (
  agent: AgentInfo,
  isInRoom: boolean,
  isMuted: boolean,
  isGenerating: boolean,
  isSelf: boolean,
  isSelected: boolean,
  onToggleMute: (agentName: string, muted: boolean) => void,
  onInspect?: (agentName: string) => void,
  roomAction?: { onAdd?: (id: string, name: string) => void; onRemove?: (id: string, name: string) => void },
): HTMLElement => {
  const div = document.createElement('div')
  div.className = `px-3 py-1 flex items-center gap-1.5 group relative ${isSelected ? 'bg-blue-50' : ''} ${isMuted ? 'opacity-40' : ''} ${!isInRoom && !isSelected ? 'opacity-40' : ''}`

  // Dot: green=idle, yellow=generating, gray=muted
  const dot = document.createElement('span')
  const dotColor = isMuted ? 'bg-gray-300' : isGenerating ? 'bg-yellow-400 typing-indicator' : 'bg-green-400'
  dot.className = `inline-block w-2 h-2 rounded-full shrink-0 ${dotColor}`
  if (agent.kind === 'ai') {
    dot.style.cursor = 'pointer'
    dot.title = isMuted ? `Unmute ${agent.name}` : `Mute ${agent.name}`
    dot.onclick = (e) => { e.stopPropagation(); onToggleMute(agent.name, !isMuted) }
  }
  div.appendChild(dot)

  // Name: clickable for AI agents → inspector
  const name = document.createElement('span')
  name.className = `text-xs truncate ${isSelf ? 'font-bold' : 'font-medium'} ${isMuted ? 'line-through' : ''} ${isSelected ? 'text-blue-700' : 'text-gray-700'}`
  name.textContent = agent.name
  if (onInspect) {
    name.style.cursor = 'pointer'
    name.onclick = (e) => { e.stopPropagation(); onInspect(agent.name) }
  }
  div.appendChild(name)

  // Action button (hover-visible): + to add, × to remove
  if (roomAction) {
    if (isInRoom && roomAction.onRemove) {
      const btn = document.createElement('button')
      btn.className = 'absolute right-1 text-orange-300 hover:text-orange-600 text-xs opacity-0 group-hover:opacity-100'
      btn.textContent = '×'
      btn.title = `Remove ${agent.name} from room`
      btn.onclick = (e) => { e.stopPropagation(); roomAction.onRemove!(agent.id, agent.name) }
      div.appendChild(btn)
    } else if (!isInRoom && roomAction.onAdd) {
      const btn = document.createElement('button')
      btn.className = 'absolute right-1 text-green-400 hover:text-green-700 text-xs opacity-0 group-hover:opacity-100'
      btn.textContent = '+'
      btn.title = `Add ${agent.name} to room`
      btn.onclick = (e) => { e.stopPropagation(); roomAction.onAdd!(agent.id, agent.name) }
      div.appendChild(btn)
    }
  }

  return div
}

export interface RenderAgentsOptions {
  agents: Record<string, AgentInfo>
  mutedAgentIds: Set<string>
  myAgentId: string | null
  selectedAgentId: string | null
  roomMemberIds: string[]
  onToggleMute: (agentId: string, muted: boolean) => void
  onInspect: (agentId: string) => void
  onAddToRoom?: (agentId: string) => void
  onRemoveFromRoom?: (agentId: string) => void
}

export const renderAgents = (
  container: HTMLElement,
  opts: RenderAgentsOptions,
): void => {
  container.innerHTML = ''

  const allAgents = Object.values(opts.agents)
  const memberSet = new Set(opts.roomMemberIds)
  const hasRoom = opts.roomMemberIds.length > 0

  // In-room agents first, then not-in-room (greyed out)
  const inRoom = hasRoom ? allAgents.filter(a => memberSet.has(a.id)) : allAgents
  const notInRoom = hasRoom ? allAgents.filter(a => !memberSet.has(a.id)) : []

  for (const agent of [...inRoom, ...notInRoom]) {
    const isIn = !hasRoom || memberSet.has(agent.id)
    const isMuted = opts.mutedAgentIds.has(agent.id)
    const isGenerating = agent.state === 'generating'
    const isSelf = agent.id === opts.myAgentId
    const isSelected = agent.id === opts.selectedAgentId
    container.appendChild(renderAgentRow(
      agent, isIn, isMuted, isGenerating, isSelf, isSelected,
      (name, muted) => opts.onToggleMute(agent.id, muted),
      () => opts.onInspect(agent.id),
      hasRoom ? { onAdd: !isIn ? (id) => opts.onAddToRoom?.(id) : undefined, onRemove: isIn ? (id) => opts.onRemoveFromRoom?.(id) : undefined } : undefined,
    ))
  }
}

// === Thinking indicator (in-message) ===

export const renderThinkingIndicator = (
  container: HTMLElement,
  agentName: string,
  onStop: (agentName: string) => void,
): { element: HTMLElement; timer: number } => {
  // Matches the shape of a completed message card (rounded, padded, msg-agent bg)
  const div = document.createElement('div')
  div.className = 'rounded px-3 py-2 text-sm msg-agent'
  div.setAttribute('data-thinking-agent', agentName)

  // Header row — same layout as renderMessage header
  const header = document.createElement('div')
  header.className = 'flex items-center gap-2 mb-1'

  const dot = document.createElement('span')
  dot.className = 'inline-block w-2 h-2 rounded-full bg-yellow-400 typing-indicator shrink-0'
  header.appendChild(dot)

  const label = document.createElement('span')
  label.className = 'font-medium text-gray-800 text-xs'
  label.setAttribute('data-thinking-label', agentName)
  let seconds = 0
  label.textContent = `${agentName}: Building context...`
  header.appendChild(label)

  const timerEl = document.createElement('span')
  timerEl.className = 'text-xs text-gray-400'
  header.appendChild(timerEl)

  const spacer = document.createElement('span')
  spacer.className = 'ml-auto'
  header.appendChild(spacer)

  const stopBtn = document.createElement('button')
  stopBtn.className = 'text-red-400 hover:text-red-600 text-xs font-medium'
  stopBtn.textContent = '■ stop'
  stopBtn.onclick = (e) => { e.stopPropagation(); onStop(agentName) }
  header.appendChild(stopBtn)

  div.appendChild(header)

  // Tool status line (shown during tool execution)
  const toolStatus = document.createElement('div')
  toolStatus.className = 'text-xs text-gray-400'
  toolStatus.setAttribute('data-thinking-tools', agentName)
  div.appendChild(toolStatus)

  // Streaming preview — same styling as message content body.
  // Wraps naturally, grows vertically as text arrives.
  const preview = document.createElement('div')
  preview.className = 'text-gray-700 whitespace-pre-wrap break-words'
  preview.setAttribute('data-thinking-preview', agentName)
  div.appendChild(preview)

  const timer = window.setInterval(() => {
    seconds++
    timerEl.textContent = `${seconds}s`
  }, 1000)

  container.appendChild(div)
  container.scrollTop = container.scrollHeight
  return { element: div, timer }
}

export const removeThinkingIndicator = (container: HTMLElement, agentName: string): void => {
  const el = container.querySelector(`[data-thinking-agent="${agentName}"]`)
  el?.remove()
}

export const updateThinkingLabel = (container: HTMLElement, agentName: string, text: string): void => {
  const el = container.querySelector(`[data-thinking-label="${agentName}"]`)
  if (el) el.textContent = text
}

export const showContextIcon = (container: HTMLElement, agentName: string, onClick: () => void): void => {
  const indicator = container.querySelector(`[data-thinking-agent="${agentName}"]`)
  if (!indicator || indicator.querySelector('[data-context-btn]')) return
  const btn = document.createElement('button')
  btn.className = 'text-gray-400 hover:text-blue-500 text-xs'
  btn.textContent = '\ud83d\udccb'
  btn.title = 'View prompt context'
  btn.setAttribute('data-context-btn', '')
  btn.onclick = (e) => { e.stopPropagation(); onClick() }
  // Insert into the header row, before the stop button
  const header = indicator.querySelector('div')
  const stopBtn = header?.querySelector('button')
  if (stopBtn) header!.insertBefore(btn, stopBtn)
  else header?.appendChild(btn)
}

/**
 * Patch the thinking preview text. Called with the FULL accumulated text
 * (accumulation is handled by the $thinkingPreviews store).
 * Text wraps naturally and the container auto-scrolls to keep the latest visible.
 */
export const updateThinkingPreview = (container: HTMLElement, agentName: string, fullText: string): void => {
  const el = container.querySelector(`[data-thinking-preview="${agentName}"]`)
  if (!el) return
  el.textContent = fullText
  // Auto-scroll if user is near the bottom (within 150px)
  if (container.scrollHeight - container.scrollTop - container.clientHeight < 150) {
    container.scrollTop = container.scrollHeight
  }
}

export const updateThinkingTool = (container: HTMLElement, agentName: string, text: string): void => {
  const el = container.querySelector(`[data-thinking-tools="${agentName}"]`)
  if (el) el.textContent = text
}

// === Mermaid rendering ===
// Lazy-loads mermaid.js on first encounter. Replaces ```mermaid code blocks with rendered SVG.

let mermaidReady: Promise<void> | null = null
let mermaidRenderCount = 0

const ensureMermaid = (): Promise<void> => {
  if (mermaidReady) return mermaidReady
  mermaidReady = import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs')
    .then((m: { default: { initialize: (config: Record<string, unknown>) => void } }) => {
      m.default.initialize({ startOnLoad: false, theme: 'neutral' })
    })
  return mermaidReady
}

const renderMermaidBlocks = async (container: HTMLElement): Promise<void> => {
  const blocks = container.querySelectorAll('code.language-mermaid')
  if (blocks.length === 0) return

  await ensureMermaid()
  const mermaidApi = (globalThis as Record<string, unknown>).mermaid as {
    render: (id: string, source: string) => Promise<{ svg: string }>
  }

  for (const block of blocks) {
    const pre = block.parentElement
    if (!pre) continue
    try {
      const id = `mermaid-${++mermaidRenderCount}`
      const { svg } = await mermaidApi.render(id, block.textContent ?? '')
      const wrapper = document.createElement('div')
      wrapper.className = 'my-2 overflow-x-auto'
      wrapper.innerHTML = svg
      pre.replaceWith(wrapper)
    } catch {
      // Leave as code block if mermaid can't parse it
    }
  }
}

// Render mermaid source into a container element (for artifact rendering)
export const renderMermaidSource = async (container: HTMLElement, source: string): Promise<void> => {
  await ensureMermaid()
  const mermaidApi = (globalThis as Record<string, unknown>).mermaid as {
    render: (id: string, source: string) => Promise<{ svg: string }>
  }
  try {
    const id = `mermaid-${++mermaidRenderCount}`
    const { svg } = await mermaidApi.render(id, source)
    container.innerHTML = svg
  } catch {
    container.textContent = `Mermaid error:\n${source}`
    container.className = 'text-xs text-red-500 font-mono whitespace-pre'
  }
}

// Render Markdown content safely. Falls back to textContent if libraries not loaded.
// Post-processes mermaid code blocks into rendered diagrams.
const renderMarkdownContent = (el: HTMLElement, text: string): void => {
  const w = globalThis as unknown as Record<string, unknown>
  const markedLib = w.marked as { parse?: (src: string) => string } | undefined
  const purifyLib = w.DOMPurify as { sanitize?: (html: string) => string } | undefined

  if (markedLib?.parse && purifyLib?.sanitize) {
    el.className += ' msg-prose'
    el.innerHTML = purifyLib.sanitize(markedLib.parse(text))
    // Post-process: render mermaid code blocks as diagrams
    void renderMermaidBlocks(el)
  } else {
    el.textContent = text
  }
}

export const renderMessage = (
  container: HTMLElement,
  msg: UIMessage,
  myAgentId: string,
  agents: Record<string, AgentInfo> | Map<string, AgentInfo>,
  onPin?: (msgId: string, senderName: string, content: string) => void,
  onDelete?: (msgId: string) => void,
  onViewContext?: (msgId: string) => void,
): void => {
  // Support both Record and Map for backwards compatibility during migration
  const getAgent = (id: string): AgentInfo | undefined =>
    agents instanceof Map ? agents.get(id) : agents[id]

  const div = document.createElement('div')
  div.setAttribute('data-msg-id', msg.id)
  const isSystem = msg.type === 'system' || msg.type === 'join' || msg.type === 'leave' || msg.senderId === 'system'
  const isPass = msg.type === 'pass'
  const isMute = msg.type === 'mute'
  const isSelf = msg.senderId === myAgentId
  const isRoomSummary = msg.type === 'room_summary'

  if (isPass) {
    const senderInfo = getAgent(msg.senderId)
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
    const sender = getAgent(msg.senderId)
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

    if (onPin || onDelete || onViewContext) {
      const spacer = document.createElement('span')
      spacer.className = 'ml-auto'
      header.appendChild(spacer)
      div.className += ' group'

      if (onViewContext && msg.generationMs) {
        const ctxBtn = document.createElement('button')
        ctxBtn.className = 'text-gray-300 hover:text-blue-500 text-xs opacity-0 group-hover:opacity-100'
        ctxBtn.textContent = '\ud83d\udccb'
        ctxBtn.title = 'View prompt context'
        ctxBtn.onclick = (e) => { e.stopPropagation(); onViewContext(msg.id) }
        header.appendChild(ctxBtn)
      }

      if (onPin) {
        const pinBtn = document.createElement('button')
        pinBtn.className = 'text-gray-300 hover:text-amber-500 text-xs opacity-0 group-hover:opacity-100'
        pinBtn.textContent = '📌'
        pinBtn.title = 'Pin message'
        pinBtn.onclick = (e) => { e.stopPropagation(); onPin(msg.id, sender?.name ?? msg.senderId, msg.content) }
        header.appendChild(pinBtn)
      }

      if (onDelete) {
        const delBtn = document.createElement('button')
        delBtn.className = 'text-gray-300 hover:text-red-500 text-xs opacity-0 group-hover:opacity-100'
        delBtn.textContent = '×'
        delBtn.title = 'Delete message'
        delBtn.onclick = (e) => { e.stopPropagation(); onDelete(msg.id) }
        header.appendChild(delBtn)
      }
    }

    const content = document.createElement('div')
    content.className = 'text-gray-700'
    renderMarkdownContent(content, msg.content)

    div.appendChild(header)
    div.appendChild(content)
  }

  container.appendChild(div)
}





