// Skill inspector + editor. Same visual structure as the tool modal
// (section labels, pill rows) so the sidebar surfaces feel like one family.
// Handles create / edit / delete. Bundled tools show as clickable pills
// that open the tool detail modal.

import { createModal, createSectionLabel } from './detail-modal.ts'
import { safeFetch } from './fetch-helpers.ts'
import { showToast } from './toast.ts'

// Shared token-backed styling for single-line inputs and textareas.
// The distinction: textareas get font-mono + resize-y + no mb.
const INPUT_BASE = 'w-full border rounded p-2 text-xs focus:outline-none focus:ring-2 focus:ring-accent-ring bg-surface border-border text-text'

const createTextInput = (placeholder: string, disabled = false): HTMLInputElement => {
  const el = document.createElement('input')
  el.className = `${INPUT_BASE} mb-1`
  el.placeholder = placeholder
  el.disabled = disabled
  return el
}

const createBodyArea = (): HTMLTextAreaElement => {
  const el = document.createElement('textarea')
  el.className = `${INPUT_BASE} font-mono resize-y`
  el.style.height = '14rem'
  return el
}

export const openSkillDetailModal = (skillName?: string, onDone?: () => void): void => {
  const isNew = !skillName
  const modal = createModal({ title: isNew ? 'Create Skill' : skillName, width: 'max-w-2xl' })

  // --- Fields ---

  const nameInput = createTextInput('skill-name', !isNew)
  nameInput.classList.add('font-mono')

  const descInput = createTextInput('When to use this skill')
  const scopeInput = createTextInput('room1, room2 (blank = global)')
  const bodyArea = createBodyArea()

  if (isNew) {
    modal.scrollBody.appendChild(createSectionLabel('Name'))
    modal.scrollBody.appendChild(nameInput)
  }
  modal.scrollBody.appendChild(createSectionLabel('Description'))
  modal.scrollBody.appendChild(descInput)
  modal.scrollBody.appendChild(createSectionLabel('Scope'))
  modal.scrollBody.appendChild(scopeInput)
  modal.scrollBody.appendChild(createSectionLabel('Prompt'))
  modal.scrollBody.appendChild(bodyArea)

  // Bundled tools section — placeholder until fetch resolves (existing skills only).
  let toolsContainer: HTMLDivElement | null = null
  if (!isNew) {
    modal.scrollBody.appendChild(createSectionLabel('Bundled tools'))
    toolsContainer = document.createElement('div')
    toolsContainer.className = 'text-xs mb-1 text-text-muted'
    toolsContainer.textContent = 'Loading…'
    modal.scrollBody.appendChild(toolsContainer)
  }

  // --- Footer button row: Delete (left) + Save/Create (right) ---

  const btnRow = document.createElement('div')
  btnRow.className = 'flex items-center justify-between relative w-full'

  if (!isNew) {
    const delBtn = document.createElement('button')
    delBtn.className = 'text-xs px-3 py-1 text-danger'
    delBtn.textContent = 'Delete'
    delBtn.onclick = async () => {
      if (!confirm(`Delete skill "${skillName}"? This removes the skill directory.`)) return
      await safeFetch(`/api/skills/${encodeURIComponent(skillName)}`, { method: 'DELETE' })
      modal.close()
      onDone?.()
    }
    btnRow.appendChild(delBtn)
  } else {
    btnRow.appendChild(document.createElement('span'))
  }

  const saveBtn = document.createElement('button')
  // bg / cursor mutate with dirty state — keep those two inline below.
  saveBtn.className = 'text-xs px-3 py-1 rounded text-white bg-border-strong'
  saveBtn.style.cursor = 'not-allowed'
  saveBtn.textContent = isNew ? 'Create' : 'Update'

  let savedDesc = '', savedBody = '', savedScope = ''

  const isDirty = (): boolean => {
    if (isNew) return !!(nameInput.value.trim() && descInput.value.trim() && bodyArea.value.trim())
    return descInput.value !== savedDesc || bodyArea.value !== savedBody || scopeInput.value !== savedScope
  }

  const updateStyle = (): void => {
    const dirty = isDirty()
    saveBtn.classList.toggle('bg-accent', dirty)
    saveBtn.classList.toggle('bg-border-strong', !dirty)
    saveBtn.style.cursor = dirty ? 'pointer' : 'not-allowed'
  }

  nameInput.oninput = updateStyle
  descInput.oninput = updateStyle
  bodyArea.oninput = updateStyle
  scopeInput.oninput = updateStyle

  saveBtn.onclick = async () => {
    if (!isDirty()) return
    const scope = scopeInput.value.split(',').map(s => s.trim()).filter(Boolean)
    if (isNew) {
      const ok = await safeFetch('/api/skills', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: nameInput.value.trim(),
          description: descInput.value,
          body: bodyArea.value,
          scope,
        }),
      })
      if (!ok) return
    } else {
      await safeFetch(`/api/skills/${encodeURIComponent(skillName)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: descInput.value, body: bodyArea.value, scope }),
      })
    }
    savedDesc = descInput.value
    savedBody = bodyArea.value
    savedScope = scopeInput.value
    updateStyle()
    showToast(btnRow, isNew ? 'Skill created' : 'Skill updated')
    setTimeout(() => { if (isNew) { modal.close(); onDone?.() } else { onDone?.() } }, 1500)
  }

  btnRow.appendChild(saveBtn)
  modal.footer.appendChild(btnRow)
  document.body.appendChild(modal.overlay)

  // --- Load existing skill data + bundled tools ---
  if (!isNew && toolsContainer) {
    fetch(`/api/skills/${encodeURIComponent(skillName)}`)
      .then(r => r.ok ? r.json() : null)
      .then(async (data: { description?: string; body?: string; scope?: string[]; tools?: string[] } | null) => {
        if (!data) return
        descInput.value = data.description ?? ''
        bodyArea.value = data.body ?? ''
        scopeInput.value = (data.scope ?? []).join(', ')
        savedDesc = descInput.value
        savedBody = bodyArea.value
        savedScope = scopeInput.value

        const tools = data.tools ?? []
        if (!toolsContainer) return
        toolsContainer.innerHTML = ''
        if (tools.length === 0) {
          toolsContainer.className = 'text-xs mb-1 text-text-muted'
          toolsContainer.textContent = 'None'
          return
        }
        toolsContainer.className = 'flex flex-wrap gap-1 mb-1'
        const { openToolDetailModal } = await import('./tool-detail-modal.ts')
        for (const t of tools) {
          const pill = document.createElement('button')
          pill.className = 'text-xs px-2 py-0.5 rounded-full border cursor-pointer hover:opacity-80 bg-surface border-border text-text'
          pill.textContent = t
          pill.title = `Inspect ${t}`
          pill.onclick = () => {
            modal.close()
            void openToolDetailModal(t)
          }
          toolsContainer.appendChild(pill)
        }
      })
      .catch(() => {})
  }
}
