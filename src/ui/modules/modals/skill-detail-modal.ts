// Skill inspector + editor.
//
// Two entry points:
//   - openSkillDetailModal(name?, onDone?)  — standalone modal (create a new
//                                             skill if name is undefined)
//   - renderSkillDetailInto(body, footer, {skillName, onDone})
//                                           — populate existing containers
//                                             (used by Settings > Skills)
//
// Bundled-tool pills close the host and defer tool-detail rendering to the
// caller via onPillClick so the host can decide how to surface the tool
// (standalone modal or replace the current detail pane).

import {
  createModal, createSectionLabel,
  createButton, setButtonPending,
  createInput, createTextarea,
} from '../modals/detail-modal.ts'
import { safeFetch } from '../fetch-helpers.ts'
import { showToast } from '../toast.ts'

export interface RenderSkillDetailOptions {
  readonly skillName?: string            // undefined → create-new mode
  readonly onDone?: () => void           // called after save/delete
  readonly onPillClick?: (toolName: string) => void  // bundled-tool pill click
  readonly closeHost?: () => void        // dismiss the containing modal
}

// Render the full skill editor into `body` (scrollable content) + `footer`
// (button row). Used by both the standalone modal and the Settings > Skills
// master-detail view.
export const renderSkillDetailInto = (
  body: HTMLElement,
  footer: HTMLElement,
  opts: RenderSkillDetailOptions,
): void => {
  body.innerHTML = ''
  footer.innerHTML = ''
  const { skillName, onDone, onPillClick, closeHost } = opts
  const isNew = !skillName

  const nameInput = createInput({ placeholder: 'skill-name', disabled: !isNew, mono: true })
  const descInput = createInput({ placeholder: 'When to use this skill' })
  const scopeInput = createInput({ placeholder: 'room1, room2 (blank = global)' })
  const bodyArea = createTextarea('', 14)

  if (isNew) {
    body.appendChild(createSectionLabel('Name'))
    body.appendChild(nameInput)
  }
  body.appendChild(createSectionLabel('Description'))
  body.appendChild(descInput)
  body.appendChild(createSectionLabel('Scope'))
  body.appendChild(scopeInput)
  body.appendChild(createSectionLabel('Prompt'))
  body.appendChild(bodyArea)

  let toolsContainer: HTMLDivElement | null = null
  if (!isNew) {
    body.appendChild(createSectionLabel('Bundled tools'))
    toolsContainer = document.createElement('div')
    toolsContainer.className = 'text-xs mb-1 text-text-muted'
    toolsContainer.textContent = 'Loading…'
    body.appendChild(toolsContainer)
  }

  // Footer button row: Delete (left) + Save/Create (right)
  const btnRow = document.createElement('div')
  btnRow.className = 'flex items-center justify-between relative w-full'

  if (!isNew) {
    const delBtn = createButton({
      variant: 'danger',
      label: 'Delete',
      onClick: async () => {
        if (!confirm(`Delete skill "${skillName}"? This removes the skill directory.`)) return
        await safeFetch(`/api/skills/${encodeURIComponent(skillName)}`, { method: 'DELETE' })
        onDone?.()
      },
    })
    btnRow.appendChild(delBtn)
  } else {
    btnRow.appendChild(document.createElement('span'))
  }

  const saveBtn = createButton({ variant: 'primary-pending', label: isNew ? 'Create' : 'Update' })

  let savedDesc = '', savedBody = '', savedScope = ''

  const isDirty = (): boolean => {
    if (isNew) return !!(nameInput.value.trim() && descInput.value.trim() && bodyArea.value.trim())
    return descInput.value !== savedDesc || bodyArea.value !== savedBody || scopeInput.value !== savedScope
  }

  const updateStyle = (): void => {
    setButtonPending(saveBtn, !isDirty())
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
    setTimeout(() => { if (isNew && closeHost) closeHost(); onDone?.() }, 1500)
  }

  btnRow.appendChild(saveBtn)
  footer.appendChild(btnRow)

  if (!isNew && toolsContainer) {
    fetch(`/api/skills/${encodeURIComponent(skillName)}`)
      .then(r => r.ok ? r.json() : null)
      .then((data: { description?: string; body?: string; scope?: string[]; tools?: string[] } | null) => {
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
        for (const t of tools) {
          const pill = document.createElement('button')
          pill.className = 'text-xs px-2 py-0.5 rounded-full border cursor-pointer hover:opacity-80 bg-surface border-border text-text'
          pill.textContent = t
          pill.title = `Inspect ${t}`
          pill.onclick = () => {
            if (onPillClick) {
              onPillClick(t)
            } else {
              closeHost?.()
              void import('../modals/tool-detail-modal.ts').then(m => m.openToolDetailModal(t))
            }
          }
          toolsContainer.appendChild(pill)
        }
      })
      .catch(() => {})
  }
}

export const openSkillDetailModal = (skillName?: string, onDone?: () => void): void => {
  const isNew = !skillName
  const modal = createModal({ title: isNew ? 'Create Skill' : skillName, width: 'max-w-2xl' })
  document.body.appendChild(modal.overlay)
  renderSkillDetailInto(modal.scrollBody, modal.footer, {
    skillName,
    onDone,
    closeHost: modal.close,
  })
}
