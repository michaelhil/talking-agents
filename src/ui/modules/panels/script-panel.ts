// Room-header script controls — start chip / running indicator / advance / stop.
//
// One init function wires every handler. Subscribes to $activeScriptByRoom +
// $selectedRoomId so the chip's state reflects the currently-selected room.
//
// Mirrors summary-panel.ts in shape: minimal, store-driven, no internal state.

import { $activeScriptByRoom, $scriptCatalog, $selectedRoomId } from '../stores.ts'
import { domRefs } from '../app-dom.ts'
import { showToast } from '../toast.ts'
import { showScriptDocPanel } from '../panels/script-doc-panel.ts'

const POPOVER_HIDDEN_CLASS = 'hidden'

export interface ScriptPanelDeps {
  readonly onRefreshRoomControls: () => void
}

export const initScriptPanel = (deps: ScriptPanelDeps): void => {
  const {
    btnScriptStart, btnScriptAdvance, btnScriptStop,
    scriptRunningChip, scriptStartPopover,
  } = domRefs

  // Make the chip clickable to re-open the document panel after dismissal.
  scriptRunningChip.style.cursor = 'pointer'
  scriptRunningChip.onclick = () => showScriptDocPanel()
  scriptRunningChip.setAttribute('role', 'button')
  scriptRunningChip.setAttribute('aria-label', 'Show script document')

  // --- Refresh chip state for the currently-selected room ---
  const refresh = (): void => {
    const roomId = $selectedRoomId.get()
    const active = roomId ? $activeScriptByRoom.get()[roomId] : undefined
    if (active) {
      btnScriptStart.classList.remove('hidden')   // keep "+" visible so a new script can be started
      scriptRunningChip.classList.remove('hidden')
      // Advance/Stop only make sense while running.
      if (active.ended) {
        btnScriptAdvance.classList.add('hidden')
        btnScriptStop.classList.add('hidden')
      } else {
        btnScriptStart.classList.add('hidden')
        btnScriptAdvance.classList.remove('hidden')
        btnScriptStop.classList.remove('hidden')
      }
      const total = active.totalSteps || (active.stepIndex + 1)
      const stepTitle = active.stepTitle || '…'
      const warn = active.whisperFailures >= 3 ? ' ⚠' : ''
      const completedTag = active.ended ? ' · complete' : ''
      scriptRunningChip.textContent = `${active.title} — Step ${active.stepIndex + 1}/${total}: ${stepTitle}${warn}${completedTag}`
      scriptRunningChip.title = active.ended
        ? `Completed script: ${active.title} (click to view document)`
        : warn
          ? `${active.whisperFailures} consecutive whisper failures — JSON parsing the model's reflection failed.`
          : `Active script: ${active.title} (click to view document)`
      if (active.ended) {
        scriptRunningChip.classList.add('opacity-60')
      } else {
        scriptRunningChip.classList.remove('opacity-60')
      }
    } else {
      btnScriptStart.classList.remove('hidden')
      scriptRunningChip.classList.add('hidden')
      btnScriptAdvance.classList.add('hidden')
      btnScriptStop.classList.add('hidden')
      scriptRunningChip.textContent = ''
    }
    // Re-run room controls so visibility-popover and similar pick up the change.
    deps.onRefreshRoomControls()
  }

  $activeScriptByRoom.listen(refresh)
  $selectedRoomId.listen(refresh)

  // --- Start popover ---
  const closePopover = (): void => {
    scriptStartPopover.classList.add(POPOVER_HIDDEN_CLASS)
    btnScriptStart.setAttribute('aria-expanded', 'false')
  }

  const renderPopover = async (): Promise<void> => {
    scriptStartPopover.innerHTML = ''
    let scripts = $scriptCatalog.get()
    if (scripts.length === 0) {
      // Fetch on first open if catalog is empty.
      try {
        const res = await fetch('/api/scripts')
        if (res.ok) {
          const data = await res.json() as { scripts: typeof scripts }
          $scriptCatalog.set(data.scripts)
          scripts = data.scripts
        }
      } catch { /* ignore */ }
    }
    if (scripts.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'text-xs text-text-muted px-3 py-2'
      empty.textContent = 'No scripts. Open Settings → Scripts to author one.'
      scriptStartPopover.appendChild(empty)
      return
    }
    for (const s of scripts) {
      const row = document.createElement('button')
      row.className = 'w-full text-left text-xs py-1.5 px-3 hover:bg-surface-muted cursor-pointer'
      row.title = s.prompt ?? `${s.cast.length} cast, ${s.steps} steps`
      row.textContent = s.title
      row.onclick = () => { closePopover(); void startScript(s.name) }
      scriptStartPopover.appendChild(row)
    }
  }

  btnScriptStart.onclick = () => {
    const expanded = btnScriptStart.getAttribute('aria-expanded') === 'true'
    if (expanded) {
      closePopover()
    } else {
      btnScriptStart.setAttribute('aria-expanded', 'true')
      void renderPopover().then(() => scriptStartPopover.classList.remove(POPOVER_HIDDEN_CLASS))
    }
  }

  // Click outside to close.
  document.addEventListener('click', (e) => {
    if (scriptStartPopover.classList.contains(POPOVER_HIDDEN_CLASS)) return
    const target = e.target as HTMLElement
    if (target.closest('#script-start-popover') || target.closest('#btn-script-start')) return
    closePopover()
  })

  // --- Stop / Advance ---
  const currentRoomName = (): string | undefined => {
    const roomId = $selectedRoomId.get()
    if (!roomId) return undefined
    // Cheap reverse-lookup: find the room name. We use an existing fetch via
    // /api/rooms but the dispatch already has it cached as $rooms in stores.
    // Avoid importing $rooms — round-trip via the API is fine for a click.
    return undefined   // we'll switch to using the stored room name below
  }
  void currentRoomName  // placeholder — actual name comes from stores

  btnScriptAdvance.onclick = async () => {
    const name = await getSelectedRoomName()
    if (!name) return
    const res = await fetch(`/api/rooms/${encodeURIComponent(name)}/script/advance`, { method: 'POST' })
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'unknown' }))
      showToast(document.body, `Advance failed: ${(data as { error?: string }).error ?? `HTTP ${res.status}`}`, { type: 'error', position: 'fixed' })
    }
  }

  btnScriptStop.onclick = async () => {
    const name = await getSelectedRoomName()
    if (!name) return
    if (!confirm('Stop the running script and despawn its cast?')) return
    const res = await fetch(`/api/rooms/${encodeURIComponent(name)}/script/stop`, { method: 'POST' })
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'unknown' }))
      showToast(document.body, `Stop failed: ${(data as { error?: string }).error ?? `HTTP ${res.status}`}`, { type: 'error', position: 'fixed' })
    }
  }

  refresh()
}

const getSelectedRoomName = async (): Promise<string | undefined> => {
  const roomId = $selectedRoomId.get()
  if (!roomId) return undefined
  // Local lookup via stores avoids an HTTP round-trip.
  const { $rooms } = await import('../stores.ts')
  return $rooms.get()[roomId]?.name
}

const startScript = async (scriptName: string): Promise<void> => {
  const roomName = await getSelectedRoomName()
  if (!roomName) return
  const res = await fetch(`/api/rooms/${encodeURIComponent(roomName)}/script/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scriptName }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: 'unknown' }))
    showToast(document.body, `Start failed: ${(data as { error?: string }).error ?? `HTTP ${res.status}`}`, { type: 'error', position: 'fixed' })
  }
}
