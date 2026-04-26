// Whisper badge — appended after a cast member's message bubble when a
// script is active. Reactive: a single subscriber updates ALL badges in
// the DOM keyed by cast name when readiness changes (whispers arrive
// ~1s after the message lands, so static rendering misses them).

import { $activeScriptByRoom, type UIWhisperRecord } from './stores.ts'

const ATTR = 'data-cast-whisper'                        // value = castName
const ATTR_ROOM = 'data-cast-whisper-room'              // value = roomId

let subscribed = false

export const appendWhisperBadge = (
  parent: HTMLElement,
  senderName: string | undefined,
  roomId: string,
  _msgTurn: number | undefined,
): void => {
  if (!senderName) return
  // Only attach a placeholder if a script is active in this room AND the
  // sender is a cast member. Else no-op.
  const active = $activeScriptByRoom.get()[roomId]
  if (!active) return

  const badge = document.createElement('div')
  badge.className = 'mt-1 text-xs flex items-start gap-2'
  badge.setAttribute(ATTR, senderName)
  badge.setAttribute(ATTR_ROOM, roomId)
  parent.appendChild(badge)

  // Initial paint (in case the whisper has already been recorded).
  paint(badge, senderName, roomId)

  // One global subscription, lazily armed.
  ensureSubscribed()
}

const paint = (el: HTMLElement, castName: string, roomId: string): void => {
  const active = $activeScriptByRoom.get()[roomId]
  const record: UIWhisperRecord | undefined = active?.lastWhisper[castName]
  if (!record) {
    // No whisper recorded for this cast yet, or the step just advanced and
    // readiness was reset. Leave whatever was previously painted in place
    // (stale-but-something is better than blanking the badge).
    if (el.childNodes.length === 0) el.classList.add('hidden')
    return
  }
  el.innerHTML = ''
  el.classList.remove('hidden')

  const dot = document.createElement('span')
  const cls = record.usedFallback
    ? 'inline-block w-2 h-2 rounded-full bg-warning mt-0.5 flex-shrink-0'
    : record.whisper.ready_to_advance
      ? 'inline-block w-2 h-2 rounded-full bg-success mt-0.5 flex-shrink-0'
      : 'inline-block w-2 h-2 rounded-full bg-border-strong mt-0.5 flex-shrink-0'
  dot.className = cls
  el.appendChild(dot)

  const summary = document.createElement('div')
  summary.className = 'flex-1 text-text-muted'
  const w = record.whisper
  const fields: string[] = []
  fields.push(`💭 ${w.ready_to_advance ? 'ready' : 'not ready'}`)
  if (w.notes) fields.push(`"${w.notes}"`)
  if (w.addressing) fields.push(`→ ${w.addressing}`)
  if (w.role_update) fields.push(`role: ${w.role_update}`)
  if (record.usedFallback) fields.push(`(fallback — ${record.errorReason ?? 'unknown'})`)
  summary.textContent = fields.join('  ·  ')
  if (record.usedFallback && record.rawResponse !== undefined) {
    summary.title = `Raw response (${record.rawResponse.length} chars): ${record.rawResponse.slice(0, 800) || '(empty)'}`
    summary.style.cursor = 'help'
  }
  el.appendChild(summary)
}

const ensureSubscribed = (): void => {
  if (subscribed) return
  subscribed = true
  $activeScriptByRoom.listen(() => {
    // Repaint every visible badge.
    document.querySelectorAll<HTMLElement>(`[${ATTR}]`).forEach(el => {
      const castName = el.getAttribute(ATTR)
      const roomId = el.getAttribute(ATTR_ROOM)
      if (castName && roomId) paint(el, castName, roomId)
    })
  })
}
