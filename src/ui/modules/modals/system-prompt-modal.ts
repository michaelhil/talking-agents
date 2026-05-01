// Shell for the top-left "System Prompt" button: fetches the house-level
// system prompt + response-format template, shows them in a modal with
// dirty-state tracking and a single Update button that PUTs back to the
// house endpoint.

import { createModal, createTextarea, createButton, setButtonPending } from '../modals/detail-modal.ts'
import { showToast } from '../toast.ts'

export const openSystemPromptModal = async (): Promise<void> => {
  const res = await fetch('/api/house/prompts').catch(() => null)
  if (!res || !res.ok) return
  const data = await res.json() as { housePrompt?: string; responseFormat?: string } | null
  if (!data) return

  const modal = createModal({ title: 'System Prompt', width: 'max-w-2xl' })

  const houseLabel = document.createElement('div')
  houseLabel.className = 'text-xs font-semibold uppercase tracking-wide mb-1 text-text-muted'
  houseLabel.textContent = 'House Prompt'
  modal.scrollBody.appendChild(houseLabel)
  const houseArea = createTextarea(data.housePrompt ?? '', 6)
  modal.scrollBody.appendChild(houseArea)

  const formatLabel = document.createElement('div')
  formatLabel.className = 'text-xs font-semibold uppercase tracking-wide mb-1 mt-3 text-text-muted'
  formatLabel.textContent = 'Response Format'
  modal.scrollBody.appendChild(formatLabel)
  const formatArea = createTextarea(data.responseFormat ?? '', 6)
  modal.scrollBody.appendChild(formatArea)

  const btnRow = document.createElement('div')
  btnRow.className = 'flex justify-end relative w-full'
  const updateBtn = createButton({ variant: 'primary-pending', label: 'Update' })
  btnRow.appendChild(updateBtn)
  modal.footer.appendChild(btnRow)

  let savedHouse = houseArea.value
  let savedFormat = formatArea.value
  const isDirty = (): boolean =>
    houseArea.value !== savedHouse || formatArea.value !== savedFormat

  const updateStyle = (): void => {
    setButtonPending(updateBtn, !isDirty())
  }

  houseArea.oninput = updateStyle
  formatArea.oninput = updateStyle

  updateBtn.onclick = async () => {
    if (!isDirty()) return
    await fetch('/api/house/prompts', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ housePrompt: houseArea.value, responseFormat: formatArea.value }),
    }).catch(() => {})
    savedHouse = houseArea.value
    savedFormat = formatArea.value
    updateStyle()
    showToast(btnRow, 'Prompts updated')
  }

  document.body.appendChild(modal.overlay)
}
