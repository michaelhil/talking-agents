// Settings > Wikis modal — list of configured wikis + add/refresh/delete +
// per-room binding toggles. Mirrors packs-modal.ts.

import { createModal, createButton } from '../modals/detail-modal.ts'
import { renderWikisInto, promptAddWiki } from '../panels/wikis-panel.ts'
import { icon } from '../icon.ts'
import { showToast } from '../toast.ts'

export const openWikisModal = async (): Promise<void> => {
  const modal = createModal({ title: 'Wikis', width: 'max-w-2xl' })
  document.body.appendChild(modal.overlay)

  // Append action buttons to the header. The createModal helper no longer
  // adds an × button — backdrop click + Escape are the close affordances.
  const addBtn = createButton({
    variant: 'ghost',
    icon: icon('plus', { size: 12 }),
    label: 'Add',
    title: 'Register a new wiki',
    className: 'mr-2',
    onClick: async () => {
      await promptAddWiki(async () => { await renderWikisInto(listEl) })
    },
  })
  modal.header.appendChild(addBtn)

  // Discovery force-refresh — busts the 5-min cache so a freshly-transferred
  // repo in the SAMSINN_WIKI_SOURCES org appears immediately without a
  // server restart.
  const discRefreshBtn = createButton({
    variant: 'ghost',
    icon: icon('refresh-cw', { size: 12 }),
    label: 'Discovery',
    title: 'Re-scan SAMSINN_WIKI_SOURCES (busts the 5-min cache)',
    className: 'mr-2',
    onClick: async () => {
      const res = await fetch('/api/wikis/discovery/refresh', { method: 'POST' })
      if (res.ok) {
        const data = await res.json() as { count?: number }
        showToast(document.body, `Discovery refreshed (${data.count ?? '?'} active)`, { type: 'success', position: 'fixed' })
        await renderWikisInto(listEl)
      } else {
        showToast(document.body, `Refresh failed (${res.status})`, { type: 'error', position: 'fixed' })
      }
    },
  })
  modal.header.appendChild(discRefreshBtn)

  const listEl = document.createElement('div')
  listEl.className = '-mx-6 -my-4'
  modal.scrollBody.appendChild(listEl)

  await renderWikisInto(listEl)

  // Re-render on wiki_changed WS events.
  const listener = (): void => { if (listEl.isConnected) void renderWikisInto(listEl) }
  window.addEventListener('wikis-changed', listener)
  const removalObserver = new MutationObserver(() => {
    if (!modal.overlay.isConnected) {
      window.removeEventListener('wikis-changed', listener)
      removalObserver.disconnect()
    }
  })
  removalObserver.observe(document.body, { childList: true })
}
