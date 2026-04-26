// Right-rail living-script document panel.
//
// Visible only when a script is active in the selected room. Renders the
// "director" view (all whispers shown). Re-fetches the rendered document
// from /api/rooms/:room/script/document on every relevant WS event:
// dialogue appended, readiness changed, step advanced, started, completed.
//
// Width persists in localStorage. Hidden by default; user can dismiss via
// the close button (the chip in the room header still flags an active run).

import { $activeScriptByRoom, $selectedRoomId, $rooms } from './stores.ts'
import { domRefs } from './app-dom.ts'

const STORAGE_WIDTH_KEY = 'samsinn:script-doc-width'
const STORAGE_HIDDEN_KEY = 'samsinn:script-doc-hidden'
const DEFAULT_WIDTH = 360
const MIN_WIDTH = 240
const MAX_WIDTH = 720

let dismissed = false

const readWidth = (): number => {
  const raw = localStorage.getItem(STORAGE_WIDTH_KEY)
  const n = raw ? parseInt(raw, 10) : NaN
  if (!Number.isFinite(n)) return DEFAULT_WIDTH
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n))
}

const writeWidth = (px: number): void => {
  localStorage.setItem(STORAGE_WIDTH_KEY, String(Math.round(px)))
}

const readDismissed = (): boolean => localStorage.getItem(STORAGE_HIDDEN_KEY) === '1'
const writeDismissed = (v: boolean): void => {
  if (v) localStorage.setItem(STORAGE_HIDDEN_KEY, '1')
  else localStorage.removeItem(STORAGE_HIDDEN_KEY)
}

const setVisible = (visible: boolean): void => {
  const { scriptDocRail, scriptDocResize } = domRefs
  if (visible) {
    scriptDocRail.classList.remove('hidden')
    scriptDocRail.classList.add('flex')
    scriptDocResize.classList.remove('hidden')
  } else {
    scriptDocRail.classList.add('hidden')
    scriptDocRail.classList.remove('flex')
    scriptDocResize.classList.add('hidden')
  }
}

const fetchAndPaint = async (): Promise<void> => {
  const roomId = $selectedRoomId.get()
  if (!roomId) return
  const active = $activeScriptByRoom.get()[roomId]
  if (!active) return

  // For active runs, the server-rendered document is authoritative (it
  // includes Pressure-block state from the live runner). For ended runs,
  // the runner state is gone — render from the store-cached stepLogs.
  if (!active.ended) {
    const roomName = $rooms.get()[roomId]?.name
    if (!roomName) return
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(roomName)}/script/document?viewer=director`)
      if (!res.ok) return
      const data = await res.json() as { active: boolean; document?: string }
      if (data.active && typeof data.document === 'string') {
        domRefs.scriptDocBody.textContent = data.document
        return
      }
    } catch { /* fall through to client render */ }
  }

  // Fallback: render from the store. Used for ended runs (server has
  // discarded state) and as a safety net when the fetch fails.
  domRefs.scriptDocBody.textContent = renderFromStore(active)
}

// Client-side renderer — used when the run has ended (server has discarded
// state) and as a safety net when the live fetch fails. Produces the full
// living document: header + cast + steps with goals/roles/pressure + dialogue.
const renderFromStore = (active: import('./stores.ts').ActiveScript): string => {
  const lines: string[] = []
  lines.push(`# SCRIPT: ${active.title}`)
  if (active.premise) lines.push(`Premise: ${active.premise}`)
  lines.push('')
  lines.push('## Cast')
  for (const c of active.cast) {
    const startsTag = c.starts ? '  (starts)' : ''
    lines.push('')
    lines.push(`### ${c.name}${startsTag}`)
    lines.push(`- model: ${c.model}`)
    const personaShort = c.persona.length > 200 ? c.persona.slice(0, 197).trim() + '…' : c.persona
    lines.push(`- persona: ${personaShort}`)
  }
  lines.push('')
  lines.push('---')

  for (let i = 0; i < active.totalSteps; i++) {
    const step = active.steps[i]
    const isComplete = active.ended ? i <= active.stepIndex : i < active.stepIndex
    const isCurrent = !active.ended && i === active.stepIndex
    const status = isComplete ? '  [COMPLETE]' : isCurrent ? '  [CURRENT]' : ''
    lines.push('')
    lines.push(`## Step ${i + 1} — ${step?.title ?? `(step ${i + 1})`}${status}`)
    if (step?.goal) lines.push(`Goal: ${step.goal}`)
    if (step) {
      lines.push('Roles:')
      for (const c of active.cast) {
        const role = step.roles[c.name] ?? ''
        lines.push(`  ${c.name} — ${role || '—'}`)
      }
    }
    const entries = active.stepLogs[i] ?? []
    if (entries.length > 0) {
      lines.push('')
      for (const e of entries) {
        lines.push(`  ${e.speaker}: ${e.content}`)
        for (const [castName, rec] of Object.entries(e.whispersByCast)) {
          const w = rec.whisper
          const parts: string[] = []
          if (w.notes) parts.push(`"${w.notes}"`)
          if (w.addressing) parts.push(`→ ${w.addressing}`)
          if (parts.length === 0) continue
          lines.push(`    ↳ whisper (${castName}): ${parts.join(' ')}`)
        }
      }
    }
    if (isComplete) lines.push('  → advanced')
  }

  return lines.join('\n')
}

const refreshVisibility = (): void => {
  const roomId = $selectedRoomId.get()
  const active = roomId ? $activeScriptByRoom.get()[roomId] : undefined
  const shouldShow = !!active && !dismissed
  setVisible(shouldShow)
  if (shouldShow) void fetchAndPaint()
}

const initResize = (): void => {
  const { scriptDocRail, scriptDocResize } = domRefs
  scriptDocRail.style.width = readWidth() + 'px'

  let dragging = false
  let startX = 0
  let startW = 0

  const onMove = (e: MouseEvent): void => {
    if (!dragging) return
    const dx = startX - e.clientX
    const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startW + dx))
    scriptDocRail.style.width = next + 'px'
  }
  const onUp = (): void => {
    if (!dragging) return
    dragging = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    const w = parseInt(scriptDocRail.style.width, 10)
    if (Number.isFinite(w)) writeWidth(w)
  }

  scriptDocResize.addEventListener('mousedown', (e) => {
    dragging = true
    startX = e.clientX
    startW = scriptDocRail.getBoundingClientRect().width
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    e.preventDefault()
  })
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

const openSourceModal = async (): Promise<void> => {
  const roomId = $selectedRoomId.get()
  if (!roomId) return
  const active = $activeScriptByRoom.get()[roomId]
  if (!active) return
  let source = '(failed to load source)'
  try {
    const res = await fetch(`/api/scripts/${encodeURIComponent(active.scriptName)}`)
    if (res.ok) {
      const data = await res.json() as { source?: string }
      if (typeof data.source === 'string') source = data.source
    }
  } catch { /* show fallback */ }

  const overlay = document.createElement('div')
  overlay.className = 'fixed inset-0 bg-black/50 flex items-center justify-center z-50'
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })

  const dialog = document.createElement('div')
  dialog.className = 'bg-surface border border-border rounded shadow-lg flex flex-col max-w-3xl w-[90vw] max-h-[80vh]'
  const header = document.createElement('div')
  header.className = 'px-4 py-2 border-b border-border flex items-center justify-between'
  header.innerHTML = `<div class="text-sm font-semibold">${active.scriptName}.md — raw source</div>`
  const close = document.createElement('button')
  close.className = 'icon-btn'
  close.setAttribute('aria-label', 'Close')
  close.innerHTML = '<span data-icon="x"></span>'
  close.onclick = () => overlay.remove()
  header.appendChild(close)
  const body = document.createElement('pre')
  body.className = 'flex-1 overflow-auto px-4 py-3 text-xs whitespace-pre-wrap font-mono'
  body.textContent = source
  dialog.appendChild(header)
  dialog.appendChild(body)
  overlay.appendChild(dialog)
  document.body.appendChild(overlay)
}

export const initScriptDocPanel = (): void => {
  dismissed = readDismissed()
  initResize()

  domRefs.btnScriptDocClose.onclick = () => {
    dismissed = true
    writeDismissed(true)
    setVisible(false)
  }
  domRefs.btnScriptDocSource.onclick = () => { void openSourceModal() }

  $activeScriptByRoom.listen(() => {
    // A new script run resets the dismissed flag — opening the panel for
    // the new script. (Closing it dismisses for THAT run, not forever.)
    const roomId = $selectedRoomId.get()
    const active = roomId ? $activeScriptByRoom.get()[roomId] : undefined
    if (active) {
      dismissed = readDismissed()
    }
    refreshVisibility()
  })
  $selectedRoomId.listen(refreshVisibility)
  refreshVisibility()
}

// Allow the room-header chip to re-open the rail after dismissal.
export const showScriptDocPanel = (): void => {
  dismissed = false
  writeDismissed(false)
  refreshVisibility()
}
