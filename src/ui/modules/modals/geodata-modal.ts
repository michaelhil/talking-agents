// Settings → Geodata modal — wraps the geodata-panel.
// Read-only first pass: list categories, search via cascade, delete
// unverified-local entries. Import / export / promote come later.

import { createModal } from '../modals/detail-modal.ts'
import { renderGeodataPanel } from '../panels/geodata-panel.ts'

export const openGeodataModal = async (): Promise<void> => {
  const modal = createModal({ title: 'Geodata', width: 'max-w-3xl' })
  document.body.appendChild(modal.overlay)

  const listEl = document.createElement('div')
  listEl.className = '-mx-6 -my-4'
  modal.scrollBody.appendChild(listEl)

  await renderGeodataPanel(listEl)
}
