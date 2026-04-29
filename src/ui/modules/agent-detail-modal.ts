// ============================================================================
// Agent detail modal — wraps renderAgentInspector in a <dialog>.
//
// Opened by clicking an agent in the sidebar OR clicking an agent chip in
// a room. Both code paths set $selectedAgentId; the listener in app.ts
// calls openAgentDetailModal here. On close, the listener clears
// $selectedAgentId so the sidebar drops its selection highlight.
//
// Matches the existing modal conventions: native <dialog>.showModal(),
// header with × button, scrollable body, Escape-to-close (native), and
// backdrop-click-to-close (added below to match user expectation across
// the rest of the app).
// ============================================================================

import { renderAgentInspector } from './agent-inspector.ts'
import { $selectedAgentId, $agents } from './stores.ts'
import { showToast } from './toast.ts'
import { icon } from './icon.ts'

let wired = false

const wireOnce = (): { dlg: HTMLDialogElement; title: HTMLElement; body: HTMLElement } => {
  const dlg = document.getElementById('agent-detail-modal') as HTMLDialogElement
  const title = document.getElementById('agent-detail-title') as HTMLElement
  const body = document.getElementById('agent-detail-body') as HTMLElement
  const closeBtn = document.getElementById('agent-detail-close') as HTMLButtonElement

  if (!wired) {
    const close = (): void => {
      if (dlg.open) dlg.close()
    }
    closeBtn.onclick = close
    // Native cancel event fires on Escape; mirror to close().
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault()
      close()
    })
    // Backdrop click — clicks on the <dialog> element itself (not its
    // children) target the backdrop area. Match instances-modal pattern.
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) close()
    })
    // Drop the sidebar selection highlight when the modal closes via
    // ANY path (×, Escape, backdrop, or programmatic .close()).
    dlg.addEventListener('close', () => {
      $selectedAgentId.set(null)
    })
    wired = true
  }

  return { dlg, title, body }
}

// Inline rename: humans only (AI rename deferred). Replaces the title
// text with an input on click; Enter saves via PATCH /api/agents/:name.
// Optimistic UI; revert + toast on error. Server broadcasts agent_renamed
// → ws-dispatch updates $agents → other tabs see the change.
const fitTitleWithRename = (title: HTMLElement, agentName: string): void => {
  const ag = Object.values($agents.get()).find((a) => a.name === agentName)
  if (!ag || ag.kind !== 'human') {
    title.textContent = agentName
    return
  }
  title.innerHTML = ''
  const nameSpan = document.createElement('span')
  nameSpan.className = 'truncate'
  nameSpan.textContent = agentName
  const pencil = icon('settings', { size: 14 })   // closest to a pencil in current icon set
  pencil.classList.add('ml-2', 'inline', 'cursor-pointer', 'text-text-subtle', 'hover:text-text')
  pencil.style.verticalAlign = 'middle'
  pencil.setAttribute('aria-label', 'Rename')
  title.appendChild(nameSpan)
  title.appendChild(pencil)

  const startEdit = (): void => {
    const current = nameSpan.textContent ?? agentName
    const input = document.createElement('input')
    input.type = 'text'
    input.value = current
    input.className = 'px-2 py-0.5 text-sm border rounded bg-surface text-text'
    input.style.width = '14rem'
    title.innerHTML = ''
    title.appendChild(input)
    input.focus()
    input.select()

    const cancel = (): void => fitTitleWithRename(title, agentName)
    const save = async (): Promise<void> => {
      const next = input.value.trim()
      if (!next || next === current) { cancel(); return }
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(current)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: next }),
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({})) as { error?: string }
          showToast(document.body, data.error ?? `Rename failed (${res.status})`, { type: 'error', position: 'fixed' })
          cancel()
          return
        }
        // Optimistic: re-render the title with the new name. The
        // agent_renamed broadcast also updates $agents so other UI
        // surfaces (sidebar, chip row) refresh.
        fitTitleWithRename(title, next)
      } catch {
        showToast(document.body, 'Rename failed', { type: 'error', position: 'fixed' })
        cancel()
      }
    }
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); void save() }
      else if (e.key === 'Escape') { e.preventDefault(); cancel() }
    }
    input.onblur = () => { void save() }
  }

  pencil.addEventListener('click', (e) => { e.stopPropagation(); startEdit() })
  nameSpan.addEventListener('click', (e) => { e.stopPropagation(); startEdit() })
}

export const openAgentDetailModal = (agentName: string): void => {
  const { dlg, title, body } = wireOnce()
  fitTitleWithRename(title, agentName)
  body.innerHTML = ''
  if (!dlg.open) dlg.showModal()
  renderAgentInspector(body, agentName)
}

export const closeAgentDetailModal = (): void => {
  const dlg = document.getElementById('agent-detail-modal') as HTMLDialogElement | null
  if (dlg?.open) dlg.close()
}
