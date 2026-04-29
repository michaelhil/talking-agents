// ============================================================================
// Instances modal — list / switch / create / delete sandboxes.
//
// Surface for the multi-instance registry. Reads /api/instances and renders
// a row per on-disk instance. Has two header modes:
//
//   browse mode (default)
//     header buttons: [+ create]  [Delete]  [×]
//     each row: meta + Switch / Delete (or Reset for current)
//     single delete: click → row fades 1s → DOM removed (no confirm dialog)
//
//   bulk mode (toggled by header "Delete")
//     header buttons: [+ create]  [Delete selected (N)]  [Cancel]  [×]
//     each non-current row gets a checkbox prepended, pre-checked
//     current row keeps Reset; Switch / Delete hidden on others
//     "Delete selected" → sequential DELETE with per-row fade + final toast
//
// Single-user happy path. Page reload after Switch / + create to rebind cookie.
// ============================================================================

import { showToast } from './toast.ts'
import { triggerReset } from './reset-button.ts'

interface InstanceRow {
  readonly id: string
  readonly snapshotMtimeMs: number
  readonly snapshotSizeBytes: number
  readonly isLive: boolean
  readonly isCurrent: boolean
}

const FADE_MS = 1000

const fmtMtime = (ms: number): string => {
  if (!ms) return 'never saved'
  const d = new Date(ms)
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

const fmtSize = (bytes: number): string => {
  if (!bytes) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const fetchList = async (): Promise<{ instances: InstanceRow[]; currentId: string | null }> => {
  const res = await fetch('/api/instances')
  if (!res.ok) throw new Error(`list failed (${res.status})`)
  return res.json() as Promise<{ instances: InstanceRow[]; currentId: string | null }>
}

const fadeAndRemove = (row: HTMLElement): Promise<void> =>
  new Promise(resolve => {
    row.style.transition = `opacity ${FADE_MS}ms`
    row.style.opacity = '0'
    setTimeout(() => { row.remove(); resolve() }, FADE_MS)
  })

// --- Modal state ---
// Reset on every openInstancesModal() call so a previous bulk-mode session
// can't leak into a new opening.

type Mode = 'browse' | 'bulk'

interface ModalState {
  mode: Mode
  // Set of non-current instance ids that are checked in bulk mode.
  checked: Set<string>
  // Cached list (for header counter + bulk action). Refilled on every render.
  rows: InstanceRow[]
}

const newState = (): ModalState => ({ mode: 'browse', checked: new Set(), rows: [] })

// --- Header action group ---

const renderHeaderActions = (state: ModalState, listEl: HTMLElement, headerEl: HTMLElement): void => {
  headerEl.innerHTML = ''

  // Always-present: + create
  const createBtn = document.createElement('button')
  createBtn.type = 'button'
  createBtn.className = 'px-2 py-1 text-sm bg-success text-white rounded leading-none'
  createBtn.title = 'Create a new instance and switch to it'
  createBtn.textContent = '+'
  createBtn.onclick = () => { void handleCreate(createBtn, listEl) }
  headerEl.appendChild(createBtn)

  if (state.mode === 'browse') {
    const delBtn = document.createElement('button')
    delBtn.type = 'button'
    delBtn.className = 'px-3 py-1 text-sm border border-danger text-danger rounded hover:bg-danger hover:text-white'
    delBtn.textContent = 'Delete'
    delBtn.onclick = () => {
      state.mode = 'bulk'
      state.checked = new Set(state.rows.filter(r => !r.isCurrent).map(r => r.id))
      renderRows(state, listEl, headerEl)
      renderHeaderActions(state, listEl, headerEl)
    }
    headerEl.appendChild(delBtn)

    const purgeBtn = document.createElement('button')
    purgeBtn.type = 'button'
    purgeBtn.className = 'px-3 py-1 text-sm border border-border-strong text-text rounded hover:bg-surface-muted'
    purgeBtn.title = 'Permanently delete all trashed instances'
    purgeBtn.textContent = 'Purge trash'
    purgeBtn.onclick = () => { void handlePurgeTrash(purgeBtn) }
    headerEl.appendChild(purgeBtn)
    return
  }

  // bulk mode
  const count = state.checked.size
  const delSelBtn = document.createElement('button')
  delSelBtn.type = 'button'
  delSelBtn.disabled = count === 0
  const baseCls = 'px-3 py-1 text-sm rounded'
  delSelBtn.className = count === 0
    ? `${baseCls} border border-border-strong text-text-subtle cursor-not-allowed`
    : `${baseCls} bg-danger text-white hover:opacity-90`
  delSelBtn.textContent = `Delete selected${count > 0 ? ` (${count})` : ''}`
  delSelBtn.onclick = () => { void handleBulkDelete(state, listEl, headerEl) }
  headerEl.appendChild(delSelBtn)

  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'px-3 py-1 text-sm border border-border-strong text-text rounded hover:bg-surface-muted'
  cancelBtn.textContent = 'Cancel'
  cancelBtn.onclick = () => {
    state.mode = 'browse'
    state.checked.clear()
    renderRows(state, listEl, headerEl)
    renderHeaderActions(state, listEl, headerEl)
  }
  headerEl.appendChild(cancelBtn)
}

// --- Per-row build ---

const buildRow = (state: ModalState, inst: InstanceRow, listEl: HTMLElement, headerEl: HTMLElement): HTMLElement => {
  const row = document.createElement('div')
  row.dataset.instanceId = inst.id
  const bgCls = inst.isCurrent ? 'bg-success-soft-bg' : 'hover:bg-surface-muted'
  row.className = `flex items-center gap-3 px-3 py-2 rounded ${bgCls}`

  // Bulk-mode checkbox (skipped for current row).
  if (state.mode === 'bulk' && !inst.isCurrent) {
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.className = 'shrink-0'
    cb.checked = state.checked.has(inst.id)
    cb.onchange = () => {
      if (cb.checked) state.checked.add(inst.id)
      else state.checked.delete(inst.id)
      renderHeaderActions(state, listEl, headerEl)
    }
    row.appendChild(cb)
  }

  const main = document.createElement('div')
  main.className = 'flex-1 min-w-0'
  const idLine = document.createElement('div')
  idLine.className = 'font-mono text-xs text-text-strong truncate'
  idLine.textContent = inst.id
  if (inst.isCurrent) {
    const tag = document.createElement('span')
    tag.className = 'ml-2 text-[10px] font-semibold uppercase text-success'
    tag.textContent = 'current'
    idLine.appendChild(tag)
  } else if (inst.isLive) {
    const tag = document.createElement('span')
    tag.className = 'ml-2 text-[10px] font-semibold uppercase text-text-subtle'
    tag.textContent = 'in memory'
    idLine.appendChild(tag)
  }
  const meta = document.createElement('div')
  meta.className = 'text-[11px] text-text-subtle'
  meta.textContent = `last saved ${fmtMtime(inst.snapshotMtimeMs)} · ${fmtSize(inst.snapshotSizeBytes)}`
  main.appendChild(idLine)
  main.appendChild(meta)
  row.appendChild(main)

  // Per-row action buttons. Hidden in bulk mode for non-current rows;
  // current row keeps Reset in both modes.
  const actions = document.createElement('div')
  actions.className = 'flex items-center gap-1.5 shrink-0'
  if (inst.isCurrent) {
    const reset = document.createElement('button')
    reset.className = 'px-2 py-1 text-xs border border-danger text-danger rounded hover:bg-danger hover:text-white'
    reset.textContent = 'Reset'
    reset.title = 'Wipe this sandbox (10-second cancellable countdown)'
    reset.onclick = () => {
      const dlg = document.getElementById('instances-modal') as HTMLDialogElement | null
      dlg?.close()
      void triggerReset()
    }
    actions.appendChild(reset)
  } else if (state.mode === 'browse') {
    const share = document.createElement('button')
    share.className = 'px-2 py-1 text-xs border border-border-strong rounded hover:bg-surface-muted'
    share.title = 'Copy share link — recipients land in this instance via /?join='
    share.textContent = 'Share'
    share.onclick = () => { void handleShare(inst.id) }
    actions.appendChild(share)

    const sw = document.createElement('button')
    sw.className = 'px-2 py-1 text-xs border border-border-strong rounded hover:bg-surface-muted'
    sw.textContent = 'Switch'
    sw.onclick = () => { void handleSwitch(inst.id) }
    actions.appendChild(sw)

    const del = document.createElement('button')
    del.className = 'px-2 py-1 text-xs border border-danger text-danger rounded hover:bg-danger hover:text-white'
    del.textContent = 'Delete'
    del.onclick = () => { void handleSingleDelete(inst.id, row) }
    actions.appendChild(del)
  }
  // Current row also gets a Share button — most useful case for collab.
  if (inst.isCurrent && state.mode === 'browse') {
    const share = document.createElement('button')
    share.className = 'px-2 py-1 text-xs border border-border-strong rounded hover:bg-surface-muted'
    share.title = 'Copy share link — recipients land in this instance via /?join='
    share.textContent = 'Share'
    share.onclick = () => { void handleShare(inst.id) }
    actions.insertBefore(share, actions.firstChild)
  }
  row.appendChild(actions)

  return row
}

// --- Renderers ---

const renderRows = (state: ModalState, listEl: HTMLElement, headerEl: HTMLElement): void => {
  listEl.innerHTML = ''
  if (state.rows.length === 0) {
    listEl.innerHTML = '<div class="text-text-subtle italic p-3">No instances on disk.</div>'
    return
  }
  for (const inst of state.rows) {
    listEl.appendChild(buildRow(state, inst, listEl, headerEl))
  }
}

const fullRender = async (state: ModalState, listEl: HTMLElement, headerEl: HTMLElement): Promise<void> => {
  listEl.innerHTML = '<div class="text-text-subtle italic p-3">Loading…</div>'
  let data: Awaited<ReturnType<typeof fetchList>>
  try {
    data = await fetchList()
  } catch (err) {
    listEl.innerHTML = `<div class="text-danger p-3">Failed to load: ${err instanceof Error ? err.message : String(err)}</div>`
    return
  }
  state.rows = [...data.instances]
  // Fresh fetch invalidates any prior selection.
  state.checked = state.mode === 'bulk'
    ? new Set(state.rows.filter(r => !r.isCurrent).map(r => r.id))
    : new Set()
  renderRows(state, listEl, headerEl)
  renderHeaderActions(state, listEl, headerEl)
}

// --- Action handlers ---

const handleShare = async (id: string): Promise<void> => {
  const url = `${window.location.origin}/?join=${encodeURIComponent(id)}`
  try {
    await navigator.clipboard.writeText(url)
    showToast(document.body, `Copied: ${url}`, { type: 'success', position: 'fixed' })
  } catch {
    // Clipboard API blocked (e.g. non-secure context). Fall back to prompt
    // so the user can copy manually.
    window.prompt('Copy this share link:', url)
  }
}

const handlePurgeTrash = async (btn: HTMLButtonElement): Promise<void> => {
  if (!confirm('Permanently purge all trashed instances? This cannot be undone.')) return
  btn.disabled = true
  try {
    const res = await fetch('/api/instances/purge-trash', { method: 'POST' })
    if (!res.ok) {
      showToast(document.body, `Purge failed (${res.status})`, { type: 'error', position: 'fixed' })
      return
    }
    const data = await res.json() as { purged: number; errors: ReadonlyArray<string> }
    const errSuffix = data.errors.length > 0 ? ` (${data.errors.length} errors)` : ''
    showToast(document.body, `Purged ${data.purged} trashed instance${data.purged === 1 ? '' : 's'}${errSuffix}`, {
      type: data.errors.length > 0 ? 'error' : 'success', position: 'fixed',
    })
  } catch {
    showToast(document.body, 'Purge failed', { type: 'error', position: 'fixed' })
  } finally {
    btn.disabled = false
  }
}

const handleSwitch = async (id: string): Promise<void> => {
  try {
    const res = await fetch(`/api/instances/${id}/switch`, { method: 'POST' })
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string }
      showToast(document.body, body.error ?? `Switch failed (${res.status})`, { type: 'error', position: 'fixed' })
      return
    }
    window.location.reload()
  } catch {
    showToast(document.body, 'Switch failed', { type: 'error', position: 'fixed' })
  }
}

const handleSingleDelete = async (id: string, row: HTMLElement): Promise<void> => {
  // Optimistically begin the fade — but if the DELETE fails we restore.
  row.style.pointerEvents = 'none'
  try {
    const res = await fetch(`/api/instances/${id}`, { method: 'DELETE' })
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string }
      row.style.pointerEvents = ''
      showToast(document.body, body.error ?? `Delete failed (${res.status})`, { type: 'error', position: 'fixed' })
      return
    }
    await fadeAndRemove(row)
  } catch {
    row.style.pointerEvents = ''
    showToast(document.body, 'Delete failed', { type: 'error', position: 'fixed' })
  }
}

const handleBulkDelete = async (state: ModalState, listEl: HTMLElement, headerEl: HTMLElement): Promise<void> => {
  const ids = [...state.checked]
  if (ids.length === 0) return

  // Disable header during the run so the user can't re-enter Cancel /
  // Delete-selected mid-flight (and double-fire the loop).
  for (const btn of Array.from(headerEl.querySelectorAll<HTMLButtonElement>('button'))) {
    btn.disabled = true
  }

  let ok = 0
  let failed = 0
  // Sequential to keep registry pressure manageable and to fade rows in
  // a visible order. The fade itself does not block subsequent requests.
  for (const id of ids) {
    const row = listEl.querySelector<HTMLElement>(`[data-instance-id="${id}"]`)
    try {
      const res = await fetch(`/api/instances/${id}`, { method: 'DELETE' })
      if (!res.ok) { failed++; continue }
      ok++
      state.checked.delete(id)
      // Update the counter as we go (safe — the button is disabled).
      const liveBtn = headerEl.querySelector<HTMLButtonElement>('button')
      if (liveBtn && liveBtn.textContent?.startsWith('Delete selected')) {
        liveBtn.textContent = `Delete selected (${state.checked.size})`
      }
      // Fire-and-forget the fade so we don't block the next DELETE call by
      // the FADE_MS animation duration. Each row vanishes on its own clock.
      if (row) void fadeAndRemove(row)
    } catch {
      failed++
    }
  }

  // Exit bulk mode + final toast.
  state.mode = 'browse'
  state.checked.clear()
  // Wait for the last fade to finish so the row's gone before we re-render.
  await new Promise(r => setTimeout(r, FADE_MS))
  await fullRender(state, listEl, headerEl)
  if (failed === 0) {
    showToast(document.body, `Deleted ${ok} instance${ok === 1 ? '' : 's'}`, { type: 'success', position: 'fixed' })
  } else {
    showToast(document.body, `Deleted ${ok}, ${failed} failed`, { type: 'error', position: 'fixed' })
  }
}

const handleCreate = async (createBtn: HTMLButtonElement, listEl: HTMLElement): Promise<void> => {
  createBtn.disabled = true
  try {
    const res = await fetch('/api/instances', { method: 'POST' })
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string }
      showToast(document.body, body.error ?? `Create failed (${res.status})`, { type: 'error', position: 'fixed' })
      return
    }
    const { id } = await res.json() as { id: string }
    const sw = await fetch(`/api/instances/${id}/switch`, { method: 'POST' })
    if (!sw.ok) {
      showToast(document.body, 'Created, but switch failed — reload manually', { type: 'error', position: 'fixed' })
      // Best-effort refresh so the new id appears in the list at least.
      void listEl   // referenced for clarity
      return
    }
    window.location.reload()
  } catch {
    showToast(document.body, 'Create failed', { type: 'error', position: 'fixed' })
  } finally {
    createBtn.disabled = false
  }
}

// --- Public entry point ---

export const openInstancesModal = async (): Promise<void> => {
  const dlg = document.getElementById('instances-modal') as HTMLDialogElement | null
  if (!dlg) return
  const listEl = document.getElementById('instances-list')!
  const headerEl = document.getElementById('instances-header-actions')!

  const state = newState()
  if (!dlg.open) dlg.showModal()
  await fullRender(state, listEl, headerEl)
}
