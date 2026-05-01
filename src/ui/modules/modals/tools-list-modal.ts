// Settings > Tools modal — master/detail.
// Left: list of registered tools (with search filter + rescan button).
// Right: detail of the selected tool, rendered by tool-detail-modal's shared
// body renderer.

import { createMasterDetailModal, createButton, createInput } from '../modals/detail-modal.ts'
import { renderToolDetailInto } from '../modals/tool-detail-modal.ts'
import { icon } from '../icon.ts'
import { showToast } from '../toast.ts'

interface ToolListItem {
  readonly name: string
  readonly description: string
}

const fetchTools = async (): Promise<ToolListItem[]> => {
  try {
    const res = await fetch('/api/tools')
    if (!res.ok) return []
    return await res.json() as ToolListItem[]
  } catch { return [] }
}

const rescanTools = async (): Promise<void> => {
  const res = await fetch('/api/tools/rescan', { method: 'POST' })
  if (!res.ok) {
    showToast(document.body, 'Rescan failed', { type: 'error', position: 'fixed' })
    return
  }
  const diff = await res.json() as { added: string[]; updated: string[]; removed: string[]; errors: string[] }
  const parts = [
    diff.added.length > 0 ? `${diff.added.length} added` : null,
    diff.updated.length > 0 ? `${diff.updated.length} updated` : null,
    diff.removed.length > 0 ? `${diff.removed.length} removed` : null,
    diff.errors.length > 0 ? `${diff.errors.length} errors` : null,
  ].filter(Boolean).join(' · ')
  showToast(
    document.body,
    parts || 'No changes',
    { type: diff.errors.length > 0 ? 'error' : 'success', position: 'fixed' },
  )
}

export const openToolsListModal = async (): Promise<void> => {
  const modal = createMasterDetailModal({ title: 'Tools' })
  document.body.appendChild(modal.overlay)

  // --- Master (left) — search + rescan + scrollable list ---
  const searchWrap = document.createElement('div')
  searchWrap.className = 'p-2 border-b border-border flex gap-1 flex-shrink-0'
  const searchInput = createInput({ placeholder: 'Filter…' })
  const rescanBtn = createButton({
    variant: 'ghost',
    icon: icon('refresh-cw', { size: 14 }),
    title: 'Rescan external tool directories',
    ariaLabel: 'Rescan',
    className: 'icon-btn',
  })
  searchWrap.appendChild(searchInput)
  searchWrap.appendChild(rescanBtn)
  modal.master.appendChild(searchWrap)

  const listEl = document.createElement('div')
  listEl.style.flex = '1 1 0'
  listEl.style.minHeight = '0'
  listEl.style.overflowY = 'auto'
  modal.master.appendChild(listEl)

  // --- Detail (right) — pad and render tool body here ---
  const detailInner = document.createElement('div')
  detailInner.className = 'px-6 py-4'
  detailInner.innerHTML = '<div class="text-xs text-text-muted">Select a tool to inspect.</div>'
  modal.detail.appendChild(detailInner)

  // --- Behaviour ---
  let tools: ToolListItem[] = []
  let selectedName: string | null = null

  const renderList = (): void => {
    const q = searchInput.value.trim().toLowerCase()
    const filtered = q
      ? tools.filter(t => t.name.toLowerCase().includes(q) || (t.description ?? '').toLowerCase().includes(q))
      : tools
    listEl.innerHTML = ''
    if (filtered.length === 0) {
      listEl.innerHTML = '<div class="text-xs text-text-muted px-3 py-2">No tools</div>'
      return
    }
    for (const t of filtered) {
      const row = document.createElement('button')
      const isActive = t.name === selectedName
      row.className = `w-full text-left text-xs py-1 px-3 cursor-pointer truncate ${isActive ? 'bg-surface-muted text-text-strong' : 'text-text hover:bg-surface-muted'}`
      row.title = t.description
      row.textContent = t.name
      row.onclick = async () => {
        selectedName = t.name
        modal.header.querySelector('h3')!.textContent = t.name
        renderList()
        await renderToolDetailInto(detailInner, t.name, { onPillClick: modal.close })
      }
      listEl.appendChild(row)
    }
  }

  const loadTools = async (): Promise<void> => {
    tools = await fetchTools()
    renderList()
  }

  searchInput.oninput = renderList
  rescanBtn.onclick = async () => {
    rescanBtn.disabled = true
    rescanBtn.classList.add('opacity-50')
    try {
      await rescanTools()
      await loadTools()
    } finally {
      rescanBtn.disabled = false
      rescanBtn.classList.remove('opacity-50')
    }
  }

  await loadTools()
}
