// ============================================================================
// Sidebar — tools and skills lists + their lazy detail modals.
//
// Everything in the Tools and Skills sections of the sidebar is wired here:
// expand/collapse headers, count badges, row click → detail modal, and
// rescan tools. App just calls `initSidebar()` once at boot.
//
// Scope-local atoms live here, not in stores.ts, since no other module
// consumes them.
// ============================================================================

import { atom } from '../lib/nanostores.ts'
import { domRefs } from './app-dom.ts'
import { showToast } from './toast.ts'

export const $toolsLoaded = atom(false)
export const $skillsLoaded = atom(false)
export const $toolCount = atom(0)
export const $skillCount = atom(0)

const lazySkillEditor = async (name?: string): Promise<void> => {
  const { openSkillDetailModal } = await import('./skill-detail-modal.ts')
  openSkillDetailModal(name, () => { $skillsLoaded.set(false); void loadSkillsList() })
}

const lazyToolDetail = async (name: string): Promise<void> => {
  const { openToolDetailModal } = await import('./tool-detail-modal.ts')
  await openToolDetailModal(name)
}

const updateToolsLabel = (expanded: boolean): void => {
  const count = $toolCount.get()
  domRefs.toolsToggle.textContent = `${expanded ? '▾' : '▸'} Tools${count > 0 ? ` (${count})` : ''}`
}

const updateSkillsLabel = (expanded: boolean): void => {
  const count = $skillCount.get()
  domRefs.skillsToggle.textContent = `${expanded ? '▾' : '▸'} Skills${count > 0 ? ` (${count})` : ''}`
}

const loadToolsList = async (): Promise<void> => {
  $toolsLoaded.set(true)
  const tools = await fetch('/api/tools').then(r => r.ok ? r.json() : []).catch(() => []) as Array<{ name: string; description: string }>
  $toolCount.set(tools.length)
  updateToolsLabel(!domRefs.toolsList.classList.contains('hidden'))
  const { renderToolsList } = await import('./render-tools-list.ts')
  renderToolsList(domRefs.toolsList, tools, (name) => void lazyToolDetail(name))
}

const loadSkillsList = async (): Promise<void> => {
  $skillsLoaded.set(true)
  const skills = await fetch('/api/skills').then(r => r.ok ? r.json() : []).catch(() => []) as Array<{ name: string; description: string; tools: string[] }>
  $skillCount.set(skills.length)
  updateSkillsLabel(!domRefs.skillsList.classList.contains('hidden'))
  domRefs.skillsList.innerHTML = ''
  for (const s of skills) {
    const row = document.createElement('button')
    row.className = 'w-full text-left text-xs text-text py-0.5 px-3 hover:bg-surface-muted cursor-pointer truncate'
    row.title = s.description
    row.textContent = s.name
    row.onclick = () => void lazySkillEditor(s.name)
    domRefs.skillsList.appendChild(row)
  }
  if (skills.length === 0) {
    domRefs.skillsList.innerHTML = '<div class="text-xs text-text-muted px-3 py-1">No skills</div>'
  }
}

export const initSidebar = (): void => {
  const { toolsHeader, toolsList, skillsHeader, skillsList } = domRefs

  // Initial count badges (fire-and-forget; failures are non-fatal).
  void fetch('/api/tools')
    .then(r => r.ok ? r.json() : [])
    .then((t: unknown[]) => { $toolCount.set(t.length); updateToolsLabel(false) })
    .catch(() => {})
  void fetch('/api/skills')
    .then(r => r.ok ? r.json() : [])
    .then((s: unknown[]) => { $skillCount.set(s.length); updateSkillsLabel(false) })
    .catch(() => {})

  toolsHeader.onclick = async (e) => {
    // Inner buttons (rescan) handle their own clicks.
    if ((e.target as HTMLElement).closest('button[data-tools-action]')) return
    const nowHidden = toolsList.classList.toggle('hidden')
    updateToolsLabel(!nowHidden)
    if (!nowHidden && !$toolsLoaded.get()) await loadToolsList()
  }

  skillsHeader.onclick = async (e) => {
    if ((e.target as HTMLElement).closest('button')) return
    const nowHidden = skillsList.classList.toggle('hidden')
    updateSkillsLabel(!nowHidden)
    if (!nowHidden && !$skillsLoaded.get()) await loadSkillsList()
  }

  const rescanBtn = document.getElementById('btn-rescan-tools')
  if (rescanBtn) {
    rescanBtn.onclick = async (e) => {
      e.stopPropagation()
      const btn = e.currentTarget as HTMLButtonElement
      btn.disabled = true
      btn.classList.add('opacity-50')
      try {
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
        // Refresh the visible list + count badge.
        $toolsLoaded.set(false)
        if (!toolsList.classList.contains('hidden')) {
          await loadToolsList()
        } else {
          const tools = await fetch('/api/tools').then(r => r.ok ? r.json() : []).catch(() => []) as unknown[]
          $toolCount.set(tools.length)
          updateToolsLabel(false)
        }
      } finally {
        btn.disabled = false
        btn.classList.remove('opacity-50')
      }
    }
  }

  const createSkillBtn = document.getElementById('btn-create-skill')
  if (createSkillBtn) {
    createSkillBtn.onclick = (e) => { e.stopPropagation(); void lazySkillEditor() }
  }
}
