// ============================================================================
// Skill Editor Modal — Create, edit, and delete skills.
// ============================================================================

import { createModal, createTextarea } from './modal.ts'

const safeFetch = async (url: string, init?: RequestInit): Promise<boolean> => {
  try {
    const res = await fetch(url, init)
    return res.ok
  } catch { return false }
}

export const openSkillEditor = (skillName?: string, onDone?: () => void): void => {
  const isNew = !skillName

  const modal = createModal({ title: isNew ? 'Create Skill' : skillName, width: 'max-w-2xl' })

  const nameLabel = document.createElement('div')
  nameLabel.className = 'text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1'
  nameLabel.textContent = 'Name'
  const nameInput = document.createElement('input')
  nameInput.className = 'w-full border rounded p-2 text-xs font-mono mb-2 focus:outline-none focus:ring-2 focus:ring-blue-300'
  nameInput.placeholder = 'skill-name'
  nameInput.disabled = !isNew

  const descLabel = document.createElement('div')
  descLabel.className = 'text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1'
  descLabel.textContent = 'Description'
  const descInput = document.createElement('input')
  descInput.className = 'w-full border rounded p-2 text-xs mb-2 focus:outline-none focus:ring-2 focus:ring-blue-300'
  descInput.placeholder = 'When to use this skill'

  const scopeLabel = document.createElement('div')
  scopeLabel.className = 'text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1'
  scopeLabel.textContent = 'Scope (room names, comma-separated, blank = global)'
  const scopeInput = document.createElement('input')
  scopeInput.className = 'w-full border rounded p-2 text-xs mb-2 focus:outline-none focus:ring-2 focus:ring-blue-300'
  scopeInput.placeholder = 'room1, room2'

  const bodyLabel = document.createElement('div')
  bodyLabel.className = 'text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1'
  bodyLabel.textContent = 'Prompt'
  const bodyArea = createTextarea('', 8)

  if (isNew) {
    modal.body.appendChild(nameLabel)
    modal.body.appendChild(nameInput)
  }
  modal.body.appendChild(descLabel)
  modal.body.appendChild(descInput)
  modal.body.appendChild(scopeLabel)
  modal.body.appendChild(scopeInput)
  modal.body.appendChild(bodyLabel)
  modal.body.appendChild(bodyArea)

  const btnRow = document.createElement('div')
  btnRow.className = 'flex items-center justify-between mt-3 relative'

  // Delete button (existing skills only)
  if (!isNew) {
    const delBtn = document.createElement('button')
    delBtn.className = 'text-xs px-3 py-1 text-red-500 hover:text-red-700'
    delBtn.textContent = 'Delete'
    delBtn.onclick = async () => {
      if (!confirm(`Delete skill "${skillName}"? This removes the skill directory.`)) return
      await safeFetch(`/api/skills/${encodeURIComponent(skillName)}`, { method: 'DELETE' })
      modal.close()
      onDone?.()
    }
    btnRow.appendChild(delBtn)
  } else {
    btnRow.appendChild(document.createElement('span')) // spacer
  }

  const saveBtn = document.createElement('button')
  saveBtn.className = 'text-xs px-3 py-1 bg-gray-300 text-white rounded cursor-not-allowed'
  saveBtn.textContent = isNew ? 'Create' : 'Update'

  let savedDesc = '', savedBody = '', savedScope = ''

  const isDirty = () => {
    if (isNew) return !!(nameInput.value.trim() && descInput.value.trim() && bodyArea.value.trim())
    return descInput.value !== savedDesc || bodyArea.value !== savedBody || scopeInput.value !== savedScope
  }
  const updateStyle = () => {
    saveBtn.className = isDirty()
      ? 'text-xs px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 cursor-pointer'
      : 'text-xs px-3 py-1 bg-gray-300 text-white rounded cursor-not-allowed'
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
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nameInput.value.trim(), description: descInput.value, body: bodyArea.value, scope }),
      })
      if (!ok) return
    } else {
      await safeFetch(`/api/skills/${encodeURIComponent(skillName)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: descInput.value, body: bodyArea.value, scope }),
      })
    }
    savedDesc = descInput.value
    savedBody = bodyArea.value
    savedScope = scopeInput.value
    updateStyle()
    const toast = document.createElement('div')
    toast.className = 'absolute left-1/2 -translate-x-1/2 bg-green-600 text-white text-xs px-3 py-1 rounded shadow transition-opacity duration-700'
    toast.style.bottom = '4px'
    toast.textContent = isNew ? 'Skill created' : 'Skill updated'
    btnRow.appendChild(toast)
    setTimeout(() => { toast.style.opacity = '0' }, 2000)
    setTimeout(() => { toast.remove(); if (isNew) { modal.close(); onDone?.() } else { onDone?.() } }, 3000)
  }

  btnRow.appendChild(saveBtn)
  modal.body.appendChild(btnRow)
  document.body.appendChild(modal.overlay)

  // Load existing skill data
  if (!isNew) {
    fetch(`/api/skills/${encodeURIComponent(skillName)}`).then(r => r.ok ? r.json() : null).then((data: { description?: string; body?: string; scope?: string[] } | null) => {
      if (!data) return
      descInput.value = data.description ?? ''
      bodyArea.value = data.body ?? ''
      scopeInput.value = (data.scope ?? []).join(', ')
      savedDesc = descInput.value
      savedBody = bodyArea.value
      savedScope = scopeInput.value
    }).catch(() => {})
  }
}
