// Settings > Providers modal. The actual modal markup is the legacy
// `<dialog id="ollama-dashboard">` element — opening it means
// showModal() + activating the cloud-providers panel subscription.
// This wrapper exists so settings-nav.ts can route to it by name.
//
// wireOllamaDashboard() is called once at boot from app.ts; we only open
// and start the providers-panel subscription here.

import { domRefs } from '../app-dom.ts'
import { openOllamaDashboard, type OllamaDashboardElements } from '../ollama-dashboard.ts'
import { startProvidersPanel } from '../panels/providers/index.ts'
import { send } from '../ws-send.ts'

const ollamaEls: OllamaDashboardElements = {
  dashboard: domRefs.ollamaDashboard,
  statusDot: domRefs.ollamaStatusDot,
  urlSelect: domRefs.ollamaUrlSelect,
  urlInput: domRefs.ollamaUrlInput,
  btnUrlAdd: domRefs.btnOllamaUrlAdd,
  btnUrlDelete: domRefs.btnOllamaUrlDelete,
}

export const openProvidersModal = async (): Promise<void> => {
  await openOllamaDashboard(ollamaEls, send)
  void startProvidersPanel()
}
