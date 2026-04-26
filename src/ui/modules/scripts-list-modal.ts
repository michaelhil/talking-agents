// Settings > Scripts modal — master/detail.
// Left: list of scripts + a "New" button.
// Right: markdown source editor; server validates on save (line-precise errors).

import { createMasterDetailModal, createButton, createInput } from './detail-modal.ts'
import { icon } from './icon.ts'

interface ScriptListItem {
  readonly id: string
  readonly name: string
  readonly title: string
  readonly premise?: string
  readonly cast: ReadonlyArray<{ name: string; model: string; starts: boolean }>
  readonly steps: number
}

interface ScriptDetail {
  readonly name: string
  readonly title: string
  readonly source: string
}

const fetchCatalog = async (): Promise<ScriptListItem[]> => {
  try {
    const res = await fetch('/api/scripts')
    if (!res.ok) return []
    const data = await res.json() as { scripts: ScriptListItem[] }
    return data.scripts
  } catch { return [] }
}

const fetchScript = async (name: string): Promise<ScriptDetail | null> => {
  try {
    const res = await fetch(`/api/scripts/${encodeURIComponent(name)}`)
    if (!res.ok) return null
    return await res.json() as ScriptDetail
  } catch { return null }
}

const TEMPLATE = `# SCRIPT: My Script
Premise: One-line premise shown to the user.

## Cast

### Alex (starts)
- model: gemini:gemini-2.5-flash
- persona: |
    You are Alex, a senior PM. Decisive, focused on impact and shipping.

### Sam
- model: gemini:gemini-2.5-flash
- persona: |
    You are Sam, the eng lead. Asks hard questions about feasibility.

---

## Step 1 — Scan
Goal: Surface candidate options.
Roles:
  Alex — facilitator
  Sam — challenger

## Step 2 — Narrow
Goal: Pick top 1-2.
Roles:
  Alex — decision-maker
  Sam — reality-checker
`

export const openScriptsListModal = async (): Promise<void> => {
  const modal = createMasterDetailModal({ title: 'Scripts' })
  document.body.appendChild(modal.overlay)

  const headerRow = document.createElement('div')
  headerRow.className = 'p-2 border-b border-border flex items-center justify-between gap-1 flex-shrink-0'
  const searchInput = createInput({ placeholder: 'Filter…' })
  const newBtn = createButton({
    variant: 'ghost',
    icon: icon('plus', { size: 14 }),
    title: 'Create script',
    ariaLabel: 'Create script',
    className: 'icon-btn',
  })
  const reloadBtn = createButton({
    variant: 'ghost',
    icon: icon('refresh-cw', { size: 14 }),
    title: 'Reload from filesystem',
    ariaLabel: 'Reload',
    className: 'icon-btn',
  })
  headerRow.appendChild(searchInput)
  const right = document.createElement('div')
  right.style.display = 'flex'
  right.style.gap = '4px'
  right.appendChild(reloadBtn)
  right.appendChild(newBtn)
  headerRow.appendChild(right)
  modal.master.appendChild(headerRow)

  const listEl = document.createElement('div')
  listEl.style.flex = '1 1 0'
  listEl.style.minHeight = '0'
  listEl.style.overflowY = 'auto'
  modal.master.appendChild(listEl)

  const detailInner = document.createElement('div')
  detailInner.className = 'px-4 py-3 flex flex-col h-full'
  detailInner.innerHTML = '<div class="text-xs text-text-muted">Select a script to edit, or click + to create.</div>'
  modal.detail.appendChild(detailInner)

  let catalog: ScriptListItem[] = []
  let selectedName: string | null = null

  const setTitle = (t: string): void => { modal.header.querySelector('h3')!.textContent = t }

  const renderList = (): void => {
    const q = searchInput.value.trim().toLowerCase()
    const filtered = q ? catalog.filter(s => s.name.toLowerCase().includes(q) || s.title.toLowerCase().includes(q)) : catalog
    listEl.innerHTML = ''
    if (filtered.length === 0) {
      listEl.innerHTML = '<div class="text-xs text-text-muted px-3 py-2">No scripts</div>'
      return
    }
    for (const s of filtered) {
      const row = document.createElement('div')
      const isActive = s.name === selectedName
      row.className = `text-xs py-1 px-3 flex items-center justify-between gap-2 group ${isActive ? 'bg-surface-muted text-text-strong' : 'text-text hover:bg-surface-muted'}`
      const main = document.createElement('button')
      main.className = 'flex-1 text-left truncate cursor-pointer'
      main.title = `${s.title} — ${s.cast.length} cast, ${s.steps} steps`
      main.textContent = s.title
      main.onclick = () => void selectScript(s.name)
      row.appendChild(main)
      const del = document.createElement('button')
      del.className = 'text-xs text-danger opacity-0 group-hover:opacity-100 cursor-pointer'
      del.textContent = '×'
      del.title = `Delete "${s.title}"`
      del.onclick = async () => {
        if (!confirm(`Delete script "${s.title}"? Running scripts are not affected.`)) return
        const res = await fetch(`/api/scripts/${encodeURIComponent(s.name)}`, { method: 'DELETE' })
        if (res.ok) {
          if (selectedName === s.name) { selectedName = null; renderEmpty() }
          await loadCatalog()
        } else {
          alert('Delete failed')
        }
      }
      row.appendChild(del)
      listEl.appendChild(row)
    }
  }

  const loadCatalog = async (): Promise<void> => {
    catalog = await fetchCatalog()
    renderList()
  }

  const renderEmpty = (): void => {
    setTitle('Scripts')
    detailInner.innerHTML = '<div class="text-xs text-text-muted">Select a script to edit, or click + to create.</div>'
  }

  const renderEditor = (initialName: string, initialSource: string, mode: 'edit' | 'new'): void => {
    detailInner.innerHTML = ''
    const status = document.createElement('div')
    status.className = 'text-xs text-text-muted mb-2'
    status.textContent = mode === 'new' ? 'New script — markdown format (see docs/scripts.md)' : 'Editing — server validates on save'
    detailInner.appendChild(status)

    const nameRow = document.createElement('div')
    nameRow.className = 'flex items-center gap-2 mb-2'
    const nameLabel = document.createElement('label')
    nameLabel.className = 'text-xs text-text-muted'
    nameLabel.textContent = 'Name:'
    const nameInput = document.createElement('input')
    nameInput.type = 'text'
    nameInput.className = 'input text-xs'
    nameInput.value = initialName
    nameInput.disabled = mode === 'edit'
    nameInput.placeholder = 'lowercase-with-dashes'
    nameRow.appendChild(nameLabel)
    nameRow.appendChild(nameInput)
    detailInner.appendChild(nameRow)

    const ta = document.createElement('textarea')
    ta.spellcheck = false
    ta.className = 'w-full font-mono text-xs p-2 border border-border rounded bg-surface'
    ta.style.flex = '1 1 0'
    ta.style.minHeight = '300px'
    ta.value = initialSource
    detailInner.appendChild(ta)

    const errBox = document.createElement('div')
    errBox.className = 'text-xs mt-2 text-danger hidden'
    detailInner.appendChild(errBox)

    const buttons = document.createElement('div')
    buttons.className = 'flex justify-end gap-2 mt-3'
    const cancelBtn = createButton({ label: 'Cancel', variant: 'ghost' })
    cancelBtn.onclick = () => { selectedName = null; renderEmpty(); renderList() }
    const saveBtn = createButton({ label: 'Save', variant: 'primary' })
    saveBtn.onclick = async () => {
      const name = nameInput.value.trim()
      if (!name) {
        errBox.classList.remove('hidden')
        errBox.textContent = 'Name is required'
        return
      }
      errBox.classList.add('hidden')
      saveBtn.disabled = true
      try {
        const res = await fetch('/api/scripts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, source: ta.value }),
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({ error: 'unknown error' }))
          errBox.classList.remove('hidden')
          errBox.textContent = `Save failed: ${(data as { error?: string }).error ?? `HTTP ${res.status}`}`
          return
        }
        const result = await res.json() as { name: string; title: string }
        selectedName = result.name
        await loadCatalog()
        await selectScript(result.name)
      } finally {
        saveBtn.disabled = false
      }
    }
    buttons.appendChild(cancelBtn)
    buttons.appendChild(saveBtn)
    detailInner.appendChild(buttons)
  }

  const selectScript = async (name: string): Promise<void> => {
    selectedName = name
    setTitle(name)
    renderList()
    const script = await fetchScript(name)
    if (!script) {
      detailInner.innerHTML = `<div class="text-xs text-danger">Failed to load "${name}"</div>`
      return
    }
    renderEditor(script.name, script.source, 'edit')
  }

  const createNew = (): void => {
    selectedName = null
    setTitle('Create Script')
    renderList()
    renderEditor('', TEMPLATE, 'new')
  }

  searchInput.oninput = renderList
  newBtn.onclick = createNew
  reloadBtn.onclick = async () => {
    await fetch('/api/scripts/reload', { method: 'POST' })
    await loadCatalog()
  }

  await loadCatalog()
}
