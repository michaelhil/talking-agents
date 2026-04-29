// ============================================================================
// Agent detail modal — wraps renderAgentInspector in a <dialog>.
//
// Opened by clicking an agent in the sidebar OR clicking an agent chip in
// a room. Both code paths set $selectedAgentId; the listener in app.ts
// calls openAgentDetailModal here. On close, the listener clears
// $selectedAgentId so the sidebar drops its selection highlight.
//
// v15+: no title bar, no × button. The inspector body's own header
// (dot · name · kind-icon) serves as the heading. Close affordances are
// Escape (native dialog cancel) and backdrop click.
// ============================================================================

import { renderAgentInspector } from './agent-inspector.ts'
import { $selectedAgentId } from './stores.ts'

let wired = false

const wireOnce = (): { dlg: HTMLDialogElement; body: HTMLElement } => {
  const dlg = document.getElementById('agent-detail-modal') as HTMLDialogElement
  const body = document.getElementById('agent-detail-body') as HTMLElement

  if (!wired) {
    const close = (): void => {
      if (dlg.open) dlg.close()
    }
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault()
      close()
    })
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) close()
    })
    dlg.addEventListener('close', () => {
      $selectedAgentId.set(null)
    })
    wired = true
  }

  return { dlg, body }
}

export const openAgentDetailModal = (agentName: string): void => {
  const { dlg, body } = wireOnce()
  body.innerHTML = ''
  if (!dlg.open) dlg.showModal()
  renderAgentInspector(body, agentName)
}

export const closeAgentDetailModal = (): void => {
  const dlg = document.getElementById('agent-detail-modal') as HTMLDialogElement | null
  if (dlg?.open) dlg.close()
}
