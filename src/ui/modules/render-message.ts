// Message rendering — a single chat/system/pass/mute/room-summary message card.
// Handles markdown rendering via marked+DOMPurify (globals) with graceful fallback.

import type { UIMessage, AgentInfo } from './render-types.ts'
import { renderMermaidBlocks } from './render-mermaid.ts'

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

export const renderMessage = (
  container: HTMLElement,
  msg: UIMessage,
  myAgentId: string,
  agents: Record<string, AgentInfo> | Map<string, AgentInfo>,
  onPin?: (msgId: string, senderName: string, content: string) => void,
  onDelete?: (msgId: string) => void,
  onViewContext?: (msgId: string) => void,
): void => {
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
    // 24-hour HH:MM:SS — locale-invariant, no AM/PM.
    timeEl.textContent = new Date(msg.timestamp).toLocaleTimeString('en-GB', { hour12: false })

    header.appendChild(nameEl)
    header.appendChild(timeEl)

    if (msg.model) {
      const modelEl = document.createElement('span')
      modelEl.className = 'text-xs text-gray-400 font-mono'
      modelEl.textContent = msg.model
      modelEl.title = msg.provider ? `Model (via ${msg.provider})` : 'Model used for this message'
      header.appendChild(modelEl)
    }

    if (msg.generationMs) {
      const genEl = document.createElement('span')
      genEl.className = 'text-xs text-blue-400'
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
      let tone = 'text-gray-400'
      if (ctx > 0) {
        if (pct >= 90) tone = 'text-red-500'
        else if (pct >= 75) tone = 'text-amber-500'
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
