// Whisper badge — appended after a cast member's message bubble when a
// script is active. Each badge looks up the whisper attached to ITS OWN
// message (by messageId in stepLogs), not the most-recent whisper from
// that cast member. This avoids two prior bugs:
//
//   - "flicker": badge initially showed the previous turn's whisper, then
//     repainted to the current one when classification finished.
//   - "all whispers identical": every message from one agent showed the
//     same most-recent whisper instead of the per-message reflection.
//
// A badge stays blank until the whisper for ITS messageId arrives via
// the script_dialogue_appended WS event.

import { $activeScriptByRoom, type UIWhisperRecord } from './stores.ts'

const ATTR_MSG = 'data-cast-whisper-msg'                // value = messageId
const ATTR_CAST = 'data-cast-whisper-cast'              // value = castName
const ATTR_ROOM = 'data-cast-whisper-room'              // value = roomId

let subscribed = false

export const appendWhisperBadge = (
  parent: HTMLElement,
  senderName: string | undefined,
  roomId: string,
  messageId: string,
): void => {
  if (!senderName) return
  const active = $activeScriptByRoom.get()[roomId]
  if (!active) return

  const badge = document.createElement('div')
  badge.className = 'mt-1 text-xs flex items-start gap-2 hidden'
  badge.setAttribute(ATTR_MSG, messageId)
  badge.setAttribute(ATTR_CAST, senderName)
  badge.setAttribute(ATTR_ROOM, roomId)
  parent.appendChild(badge)

  paint(badge, senderName, roomId, messageId)
  ensureSubscribed()
}

const findWhisperForMessage = (
  roomId: string,
  castName: string,
  messageId: string,
): UIWhisperRecord | undefined => {
  const active = $activeScriptByRoom.get()[roomId]
  if (!active) return undefined
  for (const entries of Object.values(active.stepLogs)) {
    for (const entry of entries) {
      if (entry.messageId === messageId) {
        return entry.whispersByCast[castName]
      }
    }
  }
  return undefined
}

const paint = (
  el: HTMLElement,
  castName: string,
  roomId: string,
  messageId: string,
): void => {
  const record = findWhisperForMessage(roomId, castName, messageId)
  if (!record) {
    // Whisper for this message hasn't arrived yet (or never will, if the
    // cast member has been removed). Stay hidden.
    el.classList.add('hidden')
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
    document.querySelectorAll<HTMLElement>(`[${ATTR_MSG}]`).forEach(el => {
      const messageId = el.getAttribute(ATTR_MSG)
      const castName = el.getAttribute(ATTR_CAST)
      const roomId = el.getAttribute(ATTR_ROOM)
      if (messageId && castName && roomId) paint(el, castName, roomId, messageId)
    })
  })
}
