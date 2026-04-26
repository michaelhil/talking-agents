// Settings > Scripts modal — master/detail.
// Left: list of scripts + a "New" button.
// Right: JSON textarea editor (raw JSON; live parse-error indicator;
// server validates on save).

import { createMasterDetailModal, createButton, createInput } from './detail-modal.ts'
import { icon } from './icon.ts'

interface ScriptListItem {
  readonly id: string
  readonly name: string
  readonly title: string
  readonly prompt?: string
  readonly cast: ReadonlyArray<{ name: string; model: string; starts: boolean }>
  readonly steps: number
}

const fetchCatalog = async (): Promise<ScriptListItem[]> => {
  try {
    const res = await fetch('/api/scripts')
    if (!res.ok) return []
    const data = await res.json() as { scripts: ScriptListItem[] }
    return data.scripts
  } catch { return [] }
}

const fetchScript = async (name: string): Promise<unknown | null> => {
  try {
    const res = await fetch(`/api/scripts/${encodeURIComponent(name)}`)
    if (!res.ok) return null
    return await res.json()
  } catch { return null }
}

const TEMPLATE = {
  name: 'my-script',
  title: 'My Script',
  prompt: 'Optional starter hint shown to the user.',
  cast: [
    { name: 'Alex', persona: 'A senior PM, decisive.', model: 'gemini:gemini-2.5-flash', starts: true },
    { name: 'Sam',  persona: 'An eng lead, asks hard questions.', model: 'gemini:gemini-2.5-flash' },
  ],
  steps: [
    { title: 'Scan',   roles: { Alex: 'facilitator', Sam: 'challenger' } },
    { title: 'Narrow', roles: { Alex: 'decision-maker', Sam: 'reality-checker' } },
    { title: 'Commit', roles: { Alex: 'set owners', Sam: 'name a deadline' } },
  ],
}

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

  const renderEditor = (initialJson: string, mode: 'edit' | 'new'): void => {
    detailInner.innerHTML = ''
    const status = document.createElement('div')
    status.className = 'text-xs text-text-muted mb-2'
    status.textContent = mode === 'new' ? 'New script' : `Editing — server validates on save`
    detailInner.appendChild(status)

    const ta = document.createElement('textarea')
    ta.spellcheck = false
    ta.className = 'w-full font-mono text-xs p-2 border border-border rounded bg-surface'
    ta.style.flex = '1 1 0'
    ta.style.minHeight = '300px'
    ta.value = initialJson
    detailInner.appendChild(ta)

    const parseStatus = document.createElement('div')
    parseStatus.className = 'text-xs mt-1'
    detailInner.appendChild(parseStatus)
    const updateParseStatus = (): void => {
      try {
        JSON.parse(ta.value)
        parseStatus.textContent = '✓ valid JSON'
        parseStatus.className = 'text-xs mt-1 text-success'
      } catch (err) {
        parseStatus.textContent = `✗ ${err instanceof Error ? err.message : 'invalid JSON'}`
        parseStatus.className = 'text-xs mt-1 text-danger'
      }
    }
    ta.oninput = updateParseStatus
    updateParseStatus()

    const errBox = document.createElement('div')
    errBox.className = 'text-xs mt-2 text-danger hidden'
    detailInner.appendChild(errBox)

    const buttons = document.createElement('div')
    buttons.className = 'flex justify-end gap-2 mt-3'
    const cancelBtn = createButton({ label: 'Cancel', variant: 'ghost' })
    cancelBtn.onclick = () => { selectedName = null; renderEmpty(); renderList() }
    const saveBtn = createButton({ label: 'Save', variant: 'primary' })
    saveBtn.onclick = async () => {
      let parsed: unknown
      try {
        parsed = JSON.parse(ta.value)
      } catch (err) {
        errBox.classList.remove('hidden')
        errBox.textContent = `Invalid JSON: ${err instanceof Error ? err.message : err}`
        return
      }
      errBox.classList.add('hidden')
      saveBtn.disabled = true
      try {
        const res = await fetch('/api/scripts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(parsed),
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({ error: 'unknown error' }))
          errBox.classList.remove('hidden')
          errBox.textContent = `Save failed: ${(data as { error?: string }).error ?? `HTTP ${res.status}`}`
          return
        }
        const result = await res.json() as { script: { name: string; title: string } }
        selectedName = result.script.name
        await loadCatalog()
        await selectScript(result.script.name)
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
    // Strip server-assigned id from the editor view (it's regenerated on reload).
    const { id: _id, ...editable } = script as Record<string, unknown>
    void _id
    renderEditor(JSON.stringify(editable, null, 2), 'edit')
  }

  const createNew = (): void => {
    selectedName = null
    setTitle('Create Script')
    renderList()
    renderEditor(JSON.stringify(TEMPLATE, null, 2), 'new')
  }

  searchInput.oninput = renderList
  newBtn.onclick = createNew
  reloadBtn.onclick = async () => {
    await fetch('/api/scripts/reload', { method: 'POST' })
    await loadCatalog()
  }

  await loadCatalog()
}
