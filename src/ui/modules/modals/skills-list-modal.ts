// Settings > Skills modal — master/detail.
// Left: list of skills + a "New" button.
// Right: full skill editor (reuses skill-detail-modal's shared renderer).
// Clicking a bundled-tool pill in the right pane swaps to tool detail with
// a back-link.

import { createMasterDetailModal, createButton, createInput } from '../modals/detail-modal.ts'
import { renderSkillDetailInto } from '../modals/skill-detail-modal.ts'
import { renderToolDetailInto } from '../modals/tool-detail-modal.ts'
import { icon } from '../icon.ts'

interface SkillListItem {
  readonly name: string
  readonly description: string
  readonly tools: string[]
}

const fetchSkills = async (): Promise<SkillListItem[]> => {
  try {
    const res = await fetch('/api/skills')
    if (!res.ok) return []
    return await res.json() as SkillListItem[]
  } catch { return [] }
}

export const openSkillsListModal = async (): Promise<void> => {
  const modal = createMasterDetailModal({ title: 'Skills' })
  document.body.appendChild(modal.overlay)

  // --- Master (left) — filter + new + list ---
  const headerRow = document.createElement('div')
  headerRow.className = 'p-2 border-b border-border flex items-center justify-between gap-1 flex-shrink-0'
  const searchInput = createInput({ placeholder: 'Filter…' })
  const newBtn = createButton({
    variant: 'ghost',
    icon: icon('plus', { size: 14 }),
    title: 'Create skill',
    ariaLabel: 'Create skill',
    className: 'icon-btn',
  })
  headerRow.appendChild(searchInput)
  headerRow.appendChild(newBtn)
  modal.master.appendChild(headerRow)

  const listEl = document.createElement('div')
  listEl.style.flex = '1 1 0'
  listEl.style.minHeight = '0'
  listEl.style.overflowY = 'auto'
  modal.master.appendChild(listEl)

  // --- Detail (right) — padded body, swapped per selection ---
  const detailInner = document.createElement('div')
  detailInner.className = 'px-6 py-4'
  detailInner.innerHTML = '<div class="text-xs text-text-muted">Select a skill to edit, or click + to create.</div>'
  modal.detail.appendChild(detailInner)

  // --- State ---
  let skills: SkillListItem[] = []
  let selectedName: string | null = null

  const setTitle = (t: string): void => { modal.header.querySelector('h3')!.textContent = t }

  const renderList = (): void => {
    const q = searchInput.value.trim().toLowerCase()
    const filtered = q ? skills.filter(s => s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q)) : skills
    listEl.innerHTML = ''
    if (filtered.length === 0) {
      listEl.innerHTML = '<div class="text-xs text-text-muted px-3 py-2">No skills</div>'
      return
    }
    for (const s of filtered) {
      const row = document.createElement('button')
      const isActive = s.name === selectedName
      row.className = `w-full text-left text-xs py-1 px-3 cursor-pointer truncate ${isActive ? 'bg-surface-muted text-text-strong' : 'text-text hover:bg-surface-muted'}`
      row.title = s.description
      row.textContent = s.name
      row.onclick = () => selectSkill(s.name)
      listEl.appendChild(row)
    }
  }

  const loadSkills = async (): Promise<void> => {
    skills = await fetchSkills()
    renderList()
  }

  const showToolFromSkill = async (toolName: string, returnSkill: string): Promise<void> => {
    detailInner.innerHTML = ''
    const back = document.createElement('button')
    back.className = 'text-xs text-accent hover:underline mb-2'
    back.textContent = `← back to ${returnSkill}`
    back.onclick = () => void selectSkill(returnSkill)
    detailInner.appendChild(back)
    const body = document.createElement('div')
    detailInner.appendChild(body)
    setTitle(toolName)
    await renderToolDetailInto(body, toolName, { onPillClick: modal.close })
  }

  const selectSkill = async (name: string): Promise<void> => {
    selectedName = name
    setTitle(name)
    renderList()
    detailInner.innerHTML = ''
    modal.footer.innerHTML = ''
    renderSkillDetailInto(detailInner, modal.footer, {
      skillName: name,
      onDone: () => void loadSkills(),
      closeHost: modal.close,
      onPillClick: (toolName) => void showToolFromSkill(toolName, name),
    })
  }

  const createNew = (): void => {
    selectedName = null
    setTitle('Create Skill')
    renderList()
    detailInner.innerHTML = ''
    modal.footer.innerHTML = ''
    renderSkillDetailInto(detailInner, modal.footer, {
      onDone: () => {
        selectedName = null
        void loadSkills()
        setTitle('Skills')
        detailInner.innerHTML = '<div class="text-xs text-text-muted">Select a skill to edit, or click + to create.</div>'
        modal.footer.innerHTML = ''
      },
      closeHost: modal.close,
    })
  }

  searchInput.oninput = renderList
  newBtn.onclick = createNew

  await loadSkills()
}
