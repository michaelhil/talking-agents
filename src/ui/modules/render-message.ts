// Message rendering — a single chat/system/pass/mute/room-summary message card.
// Handles markdown rendering via marked+DOMPurify (globals) with graceful fallback.

import type { UIMessage, AgentInfo } from './render-types.ts'
import { renderMermaidBlocks } from './mermaid/index.ts'
import { renderMapBlocks } from './map/index.ts'

// Post-processors run on the rendered markdown container in order. Each
// looks for its own fenced-block class and replaces matching <pre><code>
// nodes with a rendered widget. Adding a new processor (charts, sortable
// tables, ...) is one push to this array — don't grow the call site.
const postRenderProcessors: ReadonlyArray<(c: HTMLElement) => Promise<void>> = [
  renderMermaidBlocks,
  renderMapBlocks,
]
import { icon } from './icon.ts'
import { appendWhisperBadge } from './whisper-badge.ts'
import { showToast } from './toast.ts'

// Best-effort clipboard write. Tries the modern Async Clipboard API first
// (https/localhost only; some browsers refuse on programmatic clicks), then
// falls back to a hidden textarea + document.execCommand('copy') which works
// on more contexts but is deprecated. Returns true if either path reported
// success — caller decides what to surface to the user.
const writeClipboard = async (text: string): Promise<boolean> => {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* fall through to legacy path */ }
  // Legacy path: an offscreen textarea selected and copied via execCommand.
  // Preserved here because navigator.clipboard rejects on insecure contexts
  // and on some packaged WebViews even when the document is focused.
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
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
    for (const proc of postRenderProcessors) void proc(el)
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
  const isError = msg.type === 'error'
  const isMute = msg.type === 'mute'
  const isSelf = msg.senderId === myAgentId
  const isRoomSummary = msg.type === 'room_summary'

  if (isError) {
    const senderInfo = getAgent(msg.senderId)
    const senderName = senderInfo?.name ?? msg.senderName ?? msg.senderId
    div.className = 'msg-error text-xs py-1 px-2 border-l-2 border-danger bg-danger/5 text-danger flex items-center gap-2'
    const label = document.createElement('span')
    label.textContent = `⚠ ${senderName} ${msg.content}`
    label.className = 'flex-1'
    div.appendChild(label)
    // Offer "Change model" affordance for failures the user can fix in config.
    const code = msg.errorCode
    const offersChangeModel = code === 'no_api_key' || code === 'model_unavailable' || code === 'provider_down'
    if (offersChangeModel) {
      const btn = document.createElement('button')
      btn.className = 'text-xs underline hover:text-danger-strong'
      btn.textContent = 'Change model'
      btn.onclick = (e) => {
        e.stopPropagation()
        // Open the agent inspector via a custom event the app shell listens for.
        // Falls through silently if no listener is registered.
        window.dispatchEvent(new CustomEvent('open-agent-inspector', {
          detail: { agentId: msg.senderId, focus: 'model' },
        }))
      }
      div.appendChild(btn)
    }
  } else if (isPass) {
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
    // Tint by sender kind so the room reads as a conversation between two
    // distinct populations: humans (blue) vs AI (green). Falls back to the
    // legacy msg-self/msg-agent split for unresolved senders.
    const senderInfo = getAgent(msg.senderId)
    const kindClass = senderInfo?.kind === 'human' ? 'msg-human'
      : senderInfo?.kind === 'ai' ? 'msg-agent'
      : (isSelf ? 'msg-self' : 'msg-agent')
    div.className = `rounded-md px-3 py-2 text-sm border border-border shadow-sm ${kindClass}`

    const header = document.createElement('div')
    header.className = 'flex items-center gap-2 mb-1'

    const nameEl = document.createElement('span')
    nameEl.className = 'font-semibold text-text-strong text-xs'
    const sender = getAgent(msg.senderId)
    nameEl.textContent = sender?.name ?? msg.senderName ?? msg.senderId

    header.appendChild(nameEl)

    // Header field order: time, duration, context (compact %), model.
    // Each piece carries `data-mh-piece="<name>"` so the visibility toggles
    // in the room-header eye popover can hide it via CSS without re-render.
    // See src/ui/modules/message-header-prefs.ts.

    const timeEl = document.createElement('span')
    timeEl.className = 'text-xs text-text-muted'
    timeEl.dataset.mhPiece = 'time'
    // 24-hour HH:MM:SS — locale-invariant, no AM/PM.
    timeEl.textContent = new Date(msg.timestamp).toLocaleTimeString('en-GB', { hour12: false })
    header.appendChild(timeEl)

    if (msg.generationMs) {
      const genEl = document.createElement('span')
      genEl.className = 'text-xs text-accent'
      genEl.dataset.mhPiece = 'duration'
      genEl.textContent = `${(msg.generationMs / 1000).toFixed(1)}s`
      header.appendChild(genEl)
    }

    // Context usage: shown as a compact `N%` (or `N.N%` for low values).
    // Hover tooltip carries the full `prompt / max tok (provider)` detail.
    // Tone reflects pressure: amber at 75%, red at 90%. Unknown context
    // window → grey text + the raw token count in the tooltip.
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
      ctxEl.dataset.mhPiece = 'context'
      if (ctx > 0) {
        const display = pct < 1 ? pct.toFixed(2) : pct < 10 ? pct.toFixed(1) : pct.toFixed(0)
        ctxEl.textContent = `${display}%`
        ctxEl.title = `${usage.toLocaleString()} / ${ctx.toLocaleString()} tok (${display}%)${msg.provider ? ` · via ${msg.provider}` : ''}`
      } else {
        ctxEl.textContent = '?%'
        ctxEl.title = `${usage.toLocaleString()} tok (context window unknown)${msg.provider ? ` · via ${msg.provider}` : ''}`
      }
      header.appendChild(ctxEl)
    }

    if (msg.model) {
      // Show only the part after the LAST colon — `gemini:gemini-2.5-pro`
      // becomes `gemini-2.5-pro`. Models without a provider prefix render
      // unchanged. Full `provider:model` lives in the tooltip.
      const modelEl = document.createElement('span')
      modelEl.className = 'text-xs text-text-muted font-mono'
      modelEl.dataset.mhPiece = 'model'
      const colonIdx = msg.model.lastIndexOf(':')
      modelEl.textContent = colonIdx >= 0 ? msg.model.slice(colonIdx + 1) : msg.model
      modelEl.title = msg.provider ? `${msg.model} (via ${msg.provider})` : msg.model
      header.appendChild(modelEl)
    }

    {
      const spacer = document.createElement('span')
      spacer.className = 'ml-auto'
      header.appendChild(spacer)
      div.className += ' group'

      // Copy-to-clipboard. Hover-only, available on every chat message
      // regardless of which other actions are in scope. Uses navigator
      // .clipboard when available; falls back silently on older contexts.
      const copyBtn = document.createElement('button')
      copyBtn.className = 'icon-btn text-text-subtle hover:text-text text-xs opacity-0 group-hover:opacity-100'
      copyBtn.title = 'Copy message to clipboard'
      copyBtn.setAttribute('aria-label', 'Copy message to clipboard')
      copyBtn.appendChild(icon('copy', { size: 12 }))
      copyBtn.onclick = async (e) => {
        e.stopPropagation()
        const ok = await writeClipboard(msg.content)
        if (ok) {
          copyBtn.replaceChildren(icon('check', { size: 12 }))
          setTimeout(() => {
            if (copyBtn.isConnected) copyBtn.replaceChildren(icon('copy', { size: 12 }))
          }, 1200)
          showToast(document.body, 'Copied to clipboard', { type: 'success', position: 'fixed' })
        } else {
          showToast(document.body, 'Copy failed — clipboard unavailable in this browser context', { type: 'error', position: 'fixed' })
        }
      }
      header.appendChild(copyBtn)

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

    // If a script is active in this room, append the whisper attached to
    // THIS specific message (looked up by messageId in stepLogs). No-op
    // when no script is active or no whisper has been classified yet.
    appendWhisperBadge(div, msg.senderName, msg.roomId, msg.id)
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
