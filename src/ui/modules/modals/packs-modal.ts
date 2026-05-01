// Settings > Packs modal — list of installed packs + install flow.
// Reuses renderers from packs-panel.ts.

import { createModal, createButton } from '../modals/detail-modal.ts'
import { renderPacksInto, promptInstall } from '../panels/packs-panel.ts'
import { icon } from '../icon.ts'

export const openPacksModal = async (): Promise<void> => {
  const modal = createModal({ title: 'Packs', width: 'max-w-2xl' })
  document.body.appendChild(modal.overlay)

  // Install button in the modal header. createModal no longer adds an ×
  // button; close via Escape or backdrop click.
  const installBtn = createButton({
    variant: 'ghost',
    icon: icon('plus', { size: 12 }),
    label: 'Install',
    title: 'Install pack from GitHub',
    className: 'mr-2',
    onClick: async () => {
      await promptInstall()
      await renderPacksInto(listEl)
    },
  })
  modal.header.appendChild(installBtn)

  const listEl = document.createElement('div')
  listEl.className = '-mx-6 -my-4'
  modal.scrollBody.appendChild(listEl)

  await renderPacksInto(listEl)

  // Re-render on packs_changed WS event. Remove listener when the overlay is
  // detached from the DOM (via × click, overlay click-outside, or anything else).
  const listener = (): void => { if (listEl.isConnected) void renderPacksInto(listEl) }
  window.addEventListener('packs-changed', listener)
  const removalObserver = new MutationObserver(() => {
    if (!modal.overlay.isConnected) {
      window.removeEventListener('packs-changed', listener)
      removalObserver.disconnect()
    }
  })
  removalObserver.observe(document.body, { childList: true })
}
