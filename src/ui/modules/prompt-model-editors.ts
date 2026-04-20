// ============================================================================
// Persona & Model Editor Modals — Edit agent persona and model.
// ============================================================================

import { createModal, createButtonRow, createTextarea } from './modal.ts'
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
      const buttons = createButtonRow(
        modal.close,
        () => { send({ type: 'update_agent', name: agentName, persona: textarea.value }); modal.close() },
      )
      modal.body.appendChild(textarea)
      modal.body.appendChild(buttons)
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
  select.className = 'w-full px-3 py-2 border rounded text-sm focus:outline-none focus:ring-2 focus:ring-purple-300'
  select.innerHTML = '<option value="">Loading models…</option>'
  modal.body.appendChild(select)

  const buttons = createButtonRow(
    modal.close,
    () => {
      if (select.value) {
        send({ type: 'update_agent', name: agentName, model: select.value })
      }
      modal.close()
    },
    'Change Model',
  )
  modal.body.appendChild(buttons)
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
