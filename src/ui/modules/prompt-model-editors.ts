// ============================================================================
// Persona & Model Editor Modals — Edit agent persona and model.
// ============================================================================

import { createModal, createButtonRow, createTextarea } from './detail-modal.ts'
import { populateModelSelect } from './ui-utils.ts'

export const openPromptEditor = (
  agentName: string,
  send: (data: unknown) => void,
): void => {
  fetch(`/api/agents/${encodeURIComponent(agentName)}`)
    .then(res => res.ok ? res.json() : null)
    .then(data => {
      if (!data) return
      const modal = createModal({ title: `Persona — ${agentName}` })
      const textarea = createTextarea(data.persona ?? '')
      modal.scrollBody.appendChild(textarea)
      modal.footer.appendChild(createButtonRow(
        modal.close,
        () => { send({ type: 'update_agent', name: agentName, persona: textarea.value }); modal.close() },
      ))
      document.body.appendChild(modal.overlay)
      textarea.focus()
    })
}

export const openModelEditor = (
  agentName: string,
  send: (data: unknown) => void,
): void => {
  const modal = createModal({ title: `Model — ${agentName}` })

  const select = document.createElement('select')
  select.className = 'w-full px-3 py-2 border rounded text-sm focus:outline-none focus:ring-2 bg-surface border-border text-text'
  select.innerHTML = '<option value="">Loading models…</option>'
  modal.scrollBody.appendChild(select)

  modal.footer.appendChild(createButtonRow(
    modal.close,
    () => {
      if (select.value) {
        send({ type: 'update_agent', name: agentName, model: select.value })
      }
      modal.close()
    },
    'Change Model',
  ))
  document.body.appendChild(modal.overlay)

  fetch(`/api/agents/${encodeURIComponent(agentName)}`)
    .then(r => r.ok ? r.json() as Promise<{ model?: string }> : null)
    .then(async (agentData) => {
      await populateModelSelect(select, { preferredModel: agentData?.model })
    })
    .catch(() => {
      select.innerHTML = '<option value="">Failed to load models</option>'
    })
}
