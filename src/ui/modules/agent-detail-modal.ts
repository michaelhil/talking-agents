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
import { $selectedAgentId } from './stores.ts'

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

export const openAgentDetailModal = (agentName: string): void => {
  const { dlg, title, body } = wireOnce()
  title.textContent = agentName
  body.innerHTML = ''
  if (!dlg.open) dlg.showModal()
  renderAgentInspector(body, agentName)
}

export const closeAgentDetailModal = (): void => {
  const dlg = document.getElementById('agent-detail-modal') as HTMLDialogElement | null
  if (dlg?.open) dlg.close()
}
