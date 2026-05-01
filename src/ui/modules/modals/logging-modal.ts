// Settings > Logging modal — full control surface (toggle, session, dir,
// kinds, stats). Polling lifecycle is owned by renderLoggingInto; we stop
// it when the modal overlay leaves the DOM.

import { createModal } from '../modals/detail-modal.ts'
import { renderLoggingInto } from '../panels/logging-panel.ts'

export const openLoggingModal = (): void => {
  const modal = createModal({ title: 'Logging', width: 'max-w-2xl' })
  document.body.appendChild(modal.overlay)

  const { stop } = renderLoggingInto(modal.scrollBody)

  const removalObserver = new MutationObserver(() => {
    if (!modal.overlay.isConnected) {
      stop()
      removalObserver.disconnect()
    }
  })
  removalObserver.observe(document.body, { childList: true })
}
