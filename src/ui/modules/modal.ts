// ============================================================================
// Modal Factory — reusable overlay + modal dialog pattern.
//
// All modals share: dark overlay (click-to-close), white card, title,
// content area, and Cancel/Save button row.
// ============================================================================

export interface ModalConfig {
  readonly title: string
  readonly width?: string  // Tailwind max-w class, default 'max-w-lg'
}

export interface ModalElements {
  readonly overlay: HTMLDivElement
  readonly body: HTMLDivElement
  readonly close: () => void
}

// Creates a modal overlay + card with title. Caller appends content to body,
// then calls show(). Returns overlay, body div, and close function.
export const createModal = (config: ModalConfig): ModalElements => {
  const overlay = document.createElement('div')
  overlay.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50'

  const card = document.createElement('div')
  card.className = `bg-white rounded-lg shadow-xl p-6 w-full ${config.width ?? 'max-w-lg'} mx-4`

  const title = document.createElement('h3')
  title.className = 'text-lg font-semibold mb-3'
  title.textContent = config.title

  card.appendChild(title)
  overlay.appendChild(card)

  const close = (): void => { overlay.remove() }
  overlay.onclick = (e) => { if (e.target === overlay) close() }

  return { overlay, body: card, close }
}

// Standard button row: Cancel + primary action button
export const createButtonRow = (
  onCancel: () => void,
  onSave: () => void,
  saveLabel = 'Save',
  saveColor = 'bg-blue-500 hover:bg-blue-600',
): HTMLDivElement => {
  const row = document.createElement('div')
  row.className = 'flex justify-end gap-2 mt-3'

  const cancelBtn = document.createElement('button')
  cancelBtn.className = 'px-4 py-2 text-sm text-gray-600 hover:text-gray-800'
  cancelBtn.textContent = 'Cancel'
  cancelBtn.onclick = onCancel

  const saveBtn = document.createElement('button')
  saveBtn.className = `px-4 py-2 text-sm text-white rounded ${saveColor}`
  saveBtn.textContent = saveLabel
  saveBtn.onclick = onSave

  row.appendChild(cancelBtn)
  row.appendChild(saveBtn)
  return row
}

// Standard textarea for prompt editing
export const createTextarea = (value: string, rows = 12): HTMLTextAreaElement => {
  const textarea = document.createElement('textarea')
  textarea.className = 'w-full border rounded p-3 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-blue-300'
  textarea.style.height = `${rows * 1.5}rem`
  textarea.value = value
  return textarea
}

// Convenience: open a text editor modal (fetch current value, edit, save)
export const openTextEditorModal = (
  title: string,
  fetchUrl: string,
  fieldName: string,
  saveUrl: string,
  method = 'PUT',
  extractValue?: (data: Record<string, unknown>) => string,
): void => {
  fetch(fetchUrl)
    .then(res => res.ok ? res.json() : null)
    .then(data => {
      if (!data) return
      const currentValue = extractValue
        ? extractValue(data as Record<string, unknown>)
        : ((data[fieldName] ?? '') as string)

      const modal = createModal({ title })
      const textarea = createTextarea(currentValue)
      const buttons = createButtonRow(
        modal.close,
        () => {
          fetch(saveUrl, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [fieldName]: textarea.value }),
          }).catch(() => {})
          modal.close()
        },
      )

      modal.body.appendChild(textarea)
      modal.body.appendChild(buttons)
      document.body.appendChild(modal.overlay)
      textarea.focus()
    })
    .catch(() => {})
}
