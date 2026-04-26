// Message rendering — a single chat/system/pass/mute/room-summary message card.
// Handles markdown rendering via marked+DOMPurify (globals) with graceful fallback.

import type { UIMessage, AgentInfo } from './render-types.ts'
import { renderMermaidBlocks } from './mermaid/index.ts'
import { icon } from './icon.ts'
import { appendWhisperBadge } from './whisper-badge.ts'

// Render Markdown content safely. Falls back to textContent if libraries not loaded.
// Post-processes mermaid code blocks into rendered diagrams.
const renderMarkdownContent = (el: HTMLElement, text: string): void => {
  const w = globalThis as unknown as Record<string, unknown>
  const markedLib = w.marked as { parse?: (src: string) => string } | undefined
  const purifyLib = w.DOMPurify as { sanitize?: (html: string) => string } | undefined

  if (markedLib?.parse && purifyLib?.sanitize) {
    el.className += ' msg-prose'
    el.innerHTML = purifyLib.sanitize(markedLib.parse(text))
    void renderMermaidBlocks(el)
  } else {
    el.textContent = text
  }
}

export interface RenderMessageOptions {
  readonly container: HTMLElement
  readonly msg: UIMessage
  readonly myAgentId: string
  readonly agents: Record<string, AgentInfo> | Map<string, AgentInfo>
  readonly onDelete?: (msgId: string) => void
  readonly onViewContext?: (msgId: string) => void
  readonly onBookmark?: (content: string) => void
}

export const renderMessage = (opts: RenderMessageOptions): void => {
  const { container, msg, myAgentId, agents, onDelete, onViewContext, onBookmark } = opts
  const getAgent = (id: string): AgentInfo | undefined =>
    agents instanceof Map ? agents.get(id) : agents[id]

  const isJoinLeave = msg.type === 'join' || msg.type === 'leave'
  const ageMs = Date.now() - msg.timestamp
  // Join/leave messages auto-fade 10s after posting; skip rendering if already expired.
  if (isJoinLeave && ageMs > 10_000) return

  const div = document.createElement('div')
  div.setAttribute('data-msg-id', msg.id)
  // Stage cards (script engine setup messages) are sent with senderId='system'
  // but senderName='Stage'. They are scene-boundary markers we want visible,
  // not the muted system-line treatment.
  const isStageCard = msg.senderId === 'system' && msg.senderName === 'Stage' && msg.type === 'chat'
  const isSystem = !isStageCard && (msg.type === 'system' || msg.type === 'join' || msg.type === 'leave' || msg.senderId === 'system')
  const isPass = msg.type === 'pass'
  const isMute = msg.type === 'mute'
  const isSelf = msg.senderId === myAgentId
  const isRoomSummary = msg.type === 'room_summary'

  if (isPass) {
    const senderInfo = getAgent(msg.senderId)
    const senderName = senderInfo?.name ?? msg.senderName ?? msg.senderId
    div.className = 'msg-pass text-xs py-1 px-2'
    div.textContent = `${senderName} ${msg.content}`
  } else if (isMute) {
    div.className = 'msg-system text-xs py-1 px-2 text-text-muted'
    div.textContent = msg.content
  } else if (isSystem || isRoomSummary) {
    div.className = 'msg-system text-xs py-1 px-2'
    div.textContent = msg.content
  } else {
    div.className = `rounded-md px-3 py-2 text-sm border border-border shadow-sm ${isSelf ? 'msg-self' : 'msg-agent'}`

    const header = document.createElement('div')
    header.className = 'flex items-center gap-2 mb-1'

    const nameEl = document.createElement('span')
    nameEl.className = 'font-semibold text-text-strong text-xs'
    const sender = getAgent(msg.senderId)
    nameEl.textContent = sender?.name ?? msg.senderName ?? msg.senderId

    const timeEl = document.createElement('span')
    timeEl.className = 'text-xs text-text-muted'
    // 24-hour HH:MM:SS — locale-invariant, no AM/PM.
    timeEl.textContent = new Date(msg.timestamp).toLocaleTimeString('en-GB', { hour12: false })

    header.appendChild(nameEl)
    header.appendChild(timeEl)

    if (msg.model) {
      const modelEl = document.createElement('span')
      modelEl.className = 'text-xs text-text-muted font-mono'
      modelEl.textContent = msg.model
      modelEl.title = msg.provider ? `Model (via ${msg.provider})` : 'Model used for this message'
      header.appendChild(modelEl)
    }

    if (msg.generationMs) {
      const genEl = document.createElement('span')
      genEl.className = 'text-xs text-accent'
      genEl.textContent = `${(msg.generationMs / 1000).toFixed(1)}s`
      header.appendChild(genEl)
    }

    // Context usage badge: `prompt / max (pct%)` next to generation time.
    // Shown only when we know at least prompt tokens. When contextMax is
    // known, we colour the badge amber/red at 75/90% usage; unknown → grey.
    if (msg.promptTokens !== undefined) {
      const ctxEl = document.createElement('span')
      const ctx = msg.contextMax ?? 0
      const usage = msg.promptTokens
      const pct = ctx > 0 ? (usage / ctx) * 100 : 0
      let tone = 'text-text-muted'
      if (ctx > 0) {
        if (pct >= 90) tone = 'text-danger'
        else if (pct >= 75) tone = 'text-warning'
        else tone = 'text-emerald-500'
      }
      ctxEl.className = `text-xs ${tone}`
      if (ctx > 0) {
        ctxEl.textContent = `${usage.toLocaleString()} / ${ctx.toLocaleString()} tok (${pct.toFixed(0)}%)`
        ctxEl.title = `Prompt tokens used / model context window${msg.provider ? ` · via ${msg.provider}` : ''}`
      } else {
        ctxEl.textContent = `${usage.toLocaleString()} tok`
        ctxEl.title = `Prompt tokens (context window unknown)${msg.provider ? ` · via ${msg.provider}` : ''}`
      }
      header.appendChild(ctxEl)
    }

    if (onDelete || onViewContext || onBookmark) {
      const spacer = document.createElement('span')
      spacer.className = 'ml-auto'
      header.appendChild(spacer)
      div.className += ' group'

      if (onViewContext && msg.generationMs) {
        const ctxBtn = document.createElement('button')
        ctxBtn.className = 'text-border-strong hover:text-accent text-xs opacity-0 group-hover:opacity-100'
        ctxBtn.textContent = '\ud83d\udccb'
        ctxBtn.title = 'View prompt context'
        ctxBtn.onclick = (e) => { e.stopPropagation(); onViewContext(msg.id) }
        header.appendChild(ctxBtn)
      }

      if (onBookmark) {
        const bmBtn = document.createElement('button')
        bmBtn.className = 'icon-btn opacity-0 group-hover:opacity-100'
        bmBtn.title = 'Bookmark message'
        bmBtn.setAttribute('aria-label', 'Bookmark message')
        bmBtn.appendChild(icon('bookmark', { size: 12, fill: 'var(--danger)', style: 'transform: rotate(45deg);' }))
        bmBtn.onclick = (e) => { e.stopPropagation(); onBookmark(msg.content) }
        header.appendChild(bmBtn)
      }

      if (onDelete) {
        const delBtn = document.createElement('button')
        delBtn.className = 'text-border-strong hover:text-danger text-xs opacity-0 group-hover:opacity-100'
        delBtn.textContent = '×'
        delBtn.title = 'Delete message'
        delBtn.onclick = (e) => { e.stopPropagation(); onDelete(msg.id) }
        header.appendChild(delBtn)
      }
    }

    const content = document.createElement('div')
    content.className = 'text-text'
    renderMarkdownContent(content, msg.content)

    div.appendChild(header)
    div.appendChild(content)

    // If a script is active in this room, append the most recent whisper
    // for this sender as a small badge (no-op when no active script).
    appendWhisperBadge(div, msg.senderName, msg.roomId, msg.timestamp)
  }

  container.appendChild(div)

  if (isJoinLeave) {
    const remaining = Math.max(0, 10_000 - ageMs)
    setTimeout(() => {
      if (!div.isConnected) return
      div.classList.add('msg-fading')
      setTimeout(() => { if (div.isConnected) div.remove() }, 500)
    }, remaining)
  }
}
