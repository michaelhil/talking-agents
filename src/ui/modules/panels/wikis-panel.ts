// ============================================================================
// Wikis panel — renderers used by the Settings > Wikis modal.
//
// `renderWikisInto(container)` populates the given element with the current
// wiki list (rows + refresh/delete + per-row room-binding toggles).
// `promptAddWiki()` is the add-new-wiki flow triggered by the modal's "+" button.
//
// Re-renders on `wikis-changed` DOM event (fired by ws-dispatch on WS
// wiki_changed). Listener is registered by the modal once it mounts.
// ============================================================================

import { showToast } from '../toast.ts'
import { createModal, createInput, createButtonRow, setButtonPending } from '../modals/detail-modal.ts'
import { icon } from '../icon.ts'

// Mirrors `ID_PATTERN` in src/wiki/store.ts — keep in sync if the server
// regex changes. Exported for the unit test.
export const validateWikiId = (id: string): string | null => {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) {
    return 'Lowercase letters, digits, and dashes. Must start with a letter or digit. Max 63 chars.'
  }
  return null
}

interface WikiEntry {
  id: string
  owner: string
  repo: string
  ref: string
  displayName: string
  keyMask: string
  hasKey: boolean
  enabled: boolean
  source: 'stored' | 'discovered'
  pageCount: number
  lastWarmAt: number | null
  lastError: string | null
}

interface RoomEntry { id: string; name: string }

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c))

const fetchWikis = async (): Promise<WikiEntry[]> => {
  try {
    const res = await fetch('/api/wikis')
    if (!res.ok) return []
    const data = await res.json() as { wikis?: WikiEntry[] }
    return data.wikis ?? []
  } catch { return [] }
}

const fetchRooms = async (): Promise<RoomEntry[]> => {
  try {
    const res = await fetch('/api/rooms')
    if (!res.ok) return []
    return await res.json() as RoomEntry[]
  } catch { return [] }
}

const fetchRoomBindings = async (roomName: string): Promise<string[]> => {
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(roomName)}/wikis`)
    if (!res.ok) return []
    const data = await res.json() as { wikiIds?: string[] }
    return data.wikiIds ?? []
  } catch { return [] }
}

const setRoomBindings = async (roomName: string, wikiIds: string[]): Promise<boolean> => {
  const res = await fetch(`/api/rooms/${encodeURIComponent(roomName)}/wikis`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wikiIds }),
  })
  return res.ok
}

const formatLastWarm = (ts: number | null): string => {
  if (!ts) return 'never'
  const ageMs = Date.now() - ts
  const min = Math.floor(ageMs / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

// === Edit modal (replaces the cog double-prompt) ===
// Available for BOTH discovered and stored wikis. discovered → POST creates
// the stored override; stored → PUT updates. Native prompt() calls are
// banished from this surface — PAT input is masked, no plaintext history.
export const openEditWikiModal = async (w: WikiEntry, onSaved: () => void | Promise<void>): Promise<void> => {
  const modal = createModal({ title: `Edit wiki — ${w.id}`, width: 'max-w-md' })
  document.body.appendChild(modal.overlay)

  const body = modal.scrollBody
  body.className = 'px-6 py-4 overflow-y-auto min-h-0 flex-1 space-y-3'

  // --- Display name ---
  const nameLabel = document.createElement('label')
  nameLabel.className = 'block text-xs text-text-muted'
  nameLabel.textContent = 'Display name'
  const nameInput = createInput({ value: w.displayName, placeholder: w.id })
  body.appendChild(nameLabel)
  body.appendChild(nameInput)

  // --- PAT ---
  const patLabel = document.createElement('label')
  patLabel.className = 'block text-xs text-text-muted mt-3'
  patLabel.textContent = 'GitHub PAT'
  const patPlaceholder = w.hasKey ? `set (${w.keyMask})` : 'anonymous'
  const patInput = createInput({ type: 'password', placeholder: patPlaceholder })
  // Track explicit-clear separately from "left blank" — a user clicking
  // Clear means "remove the stored PAT" (sends apiKey: ''); leaving blank
  // means "no change" (sends nothing). Without this distinction we'd have
  // no way to remove a stored PAT through the UI.
  let patCleared = false
  const patHint = document.createElement('div')
  patHint.className = 'text-[11px] text-text-muted'
  patHint.textContent = w.hasKey
    ? 'Leave blank to keep current. Type to change. Click Clear to remove.'
    : 'Type to add a token. Per-wiki token used for fetching pages.'
  body.appendChild(patLabel)
  body.appendChild(patInput)
  body.appendChild(patHint)
  if (w.hasKey) {
    const clearBtn = document.createElement('button')
    clearBtn.type = 'button'
    clearBtn.className = 'text-[11px] text-text-subtle hover:text-text underline interactive mt-1'
    clearBtn.textContent = 'Clear stored PAT'
    clearBtn.onclick = () => {
      patInput.value = ''
      patCleared = true
      patHint.textContent = 'PAT will be removed on Save.'
      patHint.className = 'text-[11px] text-amber-500'
    }
    body.appendChild(clearBtn)
  }

  // --- Footer (Save / Cancel) ---
  const errLine = document.createElement('div')
  errLine.className = 'text-xs text-red-500 mb-2'
  errLine.style.display = 'none'
  modal.footer.appendChild(errLine)

  const buttons = createButtonRow(
    () => modal.close(),
    async () => {
      const newName = nameInput.value.trim()
      const newPat = patInput.value
      const nameChanged = newName !== '' && newName !== w.displayName
      const patChanged = newPat !== '' || patCleared
      if (!nameChanged && !patChanged) {
        showToast(document.body, 'No changes', { position: 'fixed' })
        modal.close()
        return
      }
      const saveBtn = buttons.querySelector<HTMLButtonElement>('button:last-child')!
      setButtonPending(saveBtn, true)
      errLine.style.display = 'none'

      // discovered → POST creates the stored override (full body required).
      // stored    → PUT updates only the changed fields.
      const isDiscovered = w.source === 'discovered'
      const url = isDiscovered ? '/api/wikis' : `/api/wikis/${encodeURIComponent(w.id)}`
      const method = isDiscovered ? 'POST' : 'PUT'
      const reqBody: Record<string, unknown> = isDiscovered
        ? { id: w.id, owner: w.owner, repo: w.repo, ref: w.ref }
        : {}
      if (nameChanged) reqBody.displayName = newName
      if (patChanged) reqBody.apiKey = patCleared ? '' : newPat

      try {
        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reqBody),
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string }
          errLine.textContent = `Save failed: ${data.error ?? `HTTP ${res.status}`}`
          errLine.style.display = 'block'
          setButtonPending(saveBtn, false)
          return
        }
        showToast(document.body, `Saved ${w.id}`, { type: 'success', position: 'fixed' })
        modal.close()
        await onSaved()
      } catch (err) {
        errLine.textContent = `Save failed: ${err instanceof Error ? err.message : String(err)}`
        errLine.style.display = 'block'
        setButtonPending(saveBtn, false)
      }
    },
  )
  modal.footer.appendChild(buttons)
  // Mark the Save button so setButtonPending finds the right class.
  const saveBtn = buttons.querySelector<HTMLButtonElement>('button:last-child')!
  saveBtn.className = 'btn btn-primary'

  setTimeout(() => nameInput.focus(), 0)
}

// === Manual-add modal (replaces the 5-prompt chain) ===
const openManualAddWiki = async (onSaved: () => void | Promise<void>): Promise<void> => {
  const modal = createModal({ title: 'Add wiki by GitHub owner/repo', width: 'max-w-md' })
  document.body.appendChild(modal.overlay)

  const body = modal.scrollBody
  body.className = 'px-6 py-4 overflow-y-auto min-h-0 flex-1 space-y-3'

  const mkField = (label: string, opts: { type?: 'text' | 'password'; placeholder?: string; hint?: string } = {}): HTMLInputElement => {
    const lab = document.createElement('label')
    lab.className = 'block text-xs text-text-muted'
    lab.textContent = label
    const input = createInput({ type: opts.type ?? 'text', placeholder: opts.placeholder })
    body.appendChild(lab)
    body.appendChild(input)
    if (opts.hint) {
      const h = document.createElement('div')
      h.className = 'text-[11px] text-text-muted'
      h.textContent = opts.hint
      body.appendChild(h)
    }
    return input
  }

  const idInput = mkField('Wiki id', { placeholder: 'my-wiki', hint: 'Lowercase letters/digits/dashes. Starts with a letter or digit. Max 63 chars.' })
  const ownerInput = mkField('GitHub owner', { placeholder: 'michaelhil' })
  const repoInput = mkField('GitHub repo', { placeholder: 'my-wiki-repo' })
  const refInput = mkField('Branch or commit', { placeholder: 'main (default)' })
  const apiInput = mkField('GitHub PAT', { type: 'password', hint: 'Optional. Leave blank for anonymous (60 req/hr GitHub limit).' })

  const idErr = document.createElement('div')
  idErr.className = 'text-[11px] text-red-500'
  idErr.style.display = 'none'
  // Insert under the id input's hint line.
  body.insertBefore(idErr, idInput.nextSibling?.nextSibling ?? null)

  const errLine = document.createElement('div')
  errLine.className = 'text-xs text-red-500 mb-2'
  errLine.style.display = 'none'
  modal.footer.appendChild(errLine)

  const buttons = createButtonRow(
    () => modal.close(),
    async () => {
      const id = idInput.value.trim()
      const owner = ownerInput.value.trim()
      const repo = repoInput.value.trim()
      const ref = refInput.value.trim()
      const apiKey = apiInput.value
      if (!id || !owner || !repo) {
        errLine.textContent = 'id, owner, repo are required.'
        errLine.style.display = 'block'
        return
      }
      const idMsg = validateWikiId(id)
      if (idMsg) {
        idErr.textContent = idMsg
        idErr.style.display = 'block'
        return
      }
      idErr.style.display = 'none'
      errLine.style.display = 'none'

      const saveBtn = buttons.querySelector<HTMLButtonElement>('button:last-child')!
      setButtonPending(saveBtn, true)

      const reqBody: Record<string, unknown> = { id, owner, repo }
      if (ref) reqBody.ref = ref
      if (apiKey) reqBody.apiKey = apiKey

      try {
        const res = await fetch('/api/wikis', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reqBody),
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string }
          errLine.textContent = `Add failed: ${data.error ?? `HTTP ${res.status}`}`
          errLine.style.display = 'block'
          setButtonPending(saveBtn, false)
          return
        }
        showToast(document.body, `Added ${id} — warming in background`, { type: 'success', position: 'fixed' })
        modal.close()
        await onSaved()
      } catch (err) {
        errLine.textContent = `Add failed: ${err instanceof Error ? err.message : String(err)}`
        errLine.style.display = 'block'
        setButtonPending(saveBtn, false)
      }
    },
    'Add',
  )
  modal.footer.appendChild(buttons)
  const saveBtn = buttons.querySelector<HTMLButtonElement>('button:last-child')!
  saveBtn.className = 'btn btn-primary'

  // Live id-validation on blur.
  idInput.onblur = () => {
    const id = idInput.value.trim()
    if (!id) { idErr.style.display = 'none'; return }
    const msg = validateWikiId(id)
    if (msg) { idErr.textContent = msg; idErr.style.display = 'block' }
    else idErr.style.display = 'none'
  }

  setTimeout(() => idInput.focus(), 0)
}

export const renderWikisInto = async (container: HTMLElement): Promise<void> => {
  container.innerHTML = '<div class="text-xs text-text-muted px-3 py-2 italic">Loading…</div>'
  const [wikis, rooms] = await Promise.all([fetchWikis(), fetchRooms()])
  container.innerHTML = ''

  if (wikis.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'text-xs text-text-muted px-3 py-3 italic'
    empty.textContent = 'No wikis configured. Use + to add one (e.g. owner=michaelhil repo=nuclear-wiki).'
    container.appendChild(empty)
    return
  }

  for (const w of wikis) {
    const row = document.createElement('div')
    row.className = 'px-3 py-2 text-xs border-b border-border'
    const status = w.lastError
      ? `<span class="text-red-500" title="${escapeHtml(w.lastError)}">error</span>`
      : `<span class="text-text-muted">${w.pageCount} pages · warmed ${formatLastWarm(w.lastWarmAt)}</span>`
    const keyBadge = w.hasKey
      ? `<span class="text-text-muted ml-2" title="Authenticated with PAT">🔑 ${escapeHtml(w.keyMask)}</span>`
      : `<span class="text-text-muted ml-2" title="Anonymous (60 req/hr GitHub limit)">no PAT</span>`
    const sourceBadge = w.source === 'discovered'
      ? `<span class="ml-2 text-[10px] uppercase tracking-wide text-text-subtle" title="Auto-discovered via SAMSINN_WIKI_SOURCES">discovered</span>`
      : ''
    const isDiscovered = w.source === 'discovered'
    // Build the row body via innerHTML for the descriptive text (uses
    // escapeHtml for safety) but keep the action buttons as DOM nodes with
    // SVG icons inside — see the icon-density rationale in the wikis-panel
    // comment block. createButton/btn-ghost would inflate the row height.
    row.innerHTML = `
      <div class="flex items-center gap-2" data-rowmain>
        <div class="flex-1 min-w-0">
          <div class="font-medium truncate">${escapeHtml(w.displayName)} <span class="text-text-muted">(${escapeHtml(w.id)})</span>${sourceBadge}</div>
          <div class="text-text-muted truncate">${escapeHtml(w.owner)}/${escapeHtml(w.repo)}@${escapeHtml(w.ref)} ${keyBadge}</div>
          <div>${status}</div>
        </div>
      </div>
      <div data-bindings class="mt-2 pl-2 text-text-muted">Loading bindings…</div>
    `

    const rowMain = row.querySelector<HTMLElement>('[data-rowmain]')!
    const mkIconBtn = (iconName: 'refresh-cw' | 'settings' | 'x', title: string, danger = false): HTMLButtonElement => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = `px-2 py-1 ${danger ? 'text-red-500' : 'text-text'} hover:bg-surface-muted rounded interactive`
      btn.title = title
      btn.setAttribute('aria-label', title)
      btn.appendChild(icon(iconName, { size: 14 }))
      return btn
    }

    const refreshBtn = mkIconBtn('refresh-cw', 'Re-fetch this wiki’s pages from GitHub')
    refreshBtn.onclick = async () => {
      showToast(document.body, `Refreshing ${w.id}…`, { position: 'fixed' })
      const res = await fetch(`/api/wikis/${encodeURIComponent(w.id)}/refresh`, { method: 'POST' })
      if (res.ok) {
        const data = await res.json() as { pageCount?: number; warnings?: string[] }
        showToast(document.body, `${w.id}: ${data.pageCount ?? 0} pages`, { type: 'success', position: 'fixed' })
      } else {
        showToast(document.body, `Refresh failed: ${(await res.json().catch(() => ({ error: '?' })) as { error?: string }).error}`, { type: 'error', position: 'fixed' })
      }
    }
    rowMain.appendChild(refreshBtn)

    const editBtn = mkIconBtn('settings', 'Edit (display name, PAT)')
    editBtn.onclick = () => openEditWikiModal(w, () => renderWikisInto(container))
    rowMain.appendChild(editBtn)

    if (!isDiscovered) {
      const deleteBtn = mkIconBtn('x', 'Remove this wiki', true)
      deleteBtn.onclick = async () => {
        if (!confirm(`Delete wiki "${w.id}"? This also removes all room bindings.`)) return
        const res = await fetch(`/api/wikis/${encodeURIComponent(w.id)}`, { method: 'DELETE' })
        if (res.ok) {
          showToast(document.body, `Deleted ${w.id}`, { type: 'success', position: 'fixed' })
          await renderWikisInto(container)
        } else {
          showToast(document.body, `Delete failed`, { type: 'error', position: 'fixed' })
        }
      }
      rowMain.appendChild(deleteBtn)
    }

    container.appendChild(row)
    void renderBindingsCell(row.querySelector<HTMLElement>('[data-bindings]')!, w.id, rooms)
  }
}

const renderBindingsCell = async (cell: HTMLElement, wikiId: string, rooms: RoomEntry[]): Promise<void> => {
  // For each room, fetch its bindings, then render checkboxes.
  const allBindings = await Promise.all(rooms.map(async (r) => ({ room: r, ids: await fetchRoomBindings(r.name) })))
  cell.innerHTML = '<div class="text-[11px] mb-1">Bound to rooms:</div>'
  if (rooms.length === 0) {
    cell.innerHTML += '<div class="italic">no rooms yet</div>'
    return
  }
  const wrap = document.createElement('div')
  wrap.className = 'flex flex-wrap gap-2'
  for (const { room, ids } of allBindings) {
    const checked = ids.includes(wikiId)
    const label = document.createElement('label')
    label.className = 'inline-flex items-center gap-1 cursor-pointer'
    label.innerHTML = `<input type="checkbox" ${checked ? 'checked' : ''} class="cursor-pointer"/> <span>${escapeHtml(room.name)}</span>`
    label.querySelector<HTMLInputElement>('input')!.onchange = async (e) => {
      const want = (e.target as HTMLInputElement).checked
      const next = want ? [...new Set([...ids, wikiId])] : ids.filter((x) => x !== wikiId)
      const ok = await setRoomBindings(room.name, next)
      if (!ok) { showToast(document.body, `Bind failed`, { type: 'error', position: 'fixed' }); (e.target as HTMLInputElement).checked = !want }
    }
    wrap.appendChild(label)
  }
  cell.appendChild(wrap)
}

interface AvailableWiki {
  id: string
  owner: string
  repo: string
  displayName: string
  description: string
  repoUrl: string
  installed: boolean
}

const fetchAvailable = async (): Promise<{ wikis: AvailableWiki[]; sources: string[] }> => {
  try {
    const res = await fetch('/api/wikis/available')
    if (!res.ok) return { wikis: [], sources: [] }
    return await res.json() as { wikis: AvailableWiki[]; sources: string[] }
  } catch { return { wikis: [], sources: [] } }
}

// Synthesize a WikiEntry-shaped object for openEditWikiModal from a row in
// the discovered "Add wiki" picker. Discovered-not-yet-installed wikis use
// the merged entry from /api/wikis if present, otherwise minimal defaults.
const editFromAvailable = async (w: AvailableWiki, onSaved: () => Promise<void>): Promise<void> => {
  const wikis = await fetchWikis()
  const merged = wikis.find(x => x.id === w.id)
  const entry: WikiEntry = merged ?? {
    id: w.id, owner: w.owner, repo: w.repo, ref: 'main',
    displayName: w.displayName, keyMask: '', hasKey: false,
    enabled: true, source: 'discovered', pageCount: 0,
    lastWarmAt: null, lastError: null,
  }
  await openEditWikiModal(entry, onSaved)
}

export const promptAddWiki = async (onAdded: () => Promise<void> = async () => {}): Promise<void> => {
  const modal = createModal({ title: 'Add wiki', width: 'max-w-xl' })
  document.body.appendChild(modal.overlay)

  const body = modal.scrollBody
  body.innerHTML = '<div class="text-xs text-text-muted italic">Loading available wikis…</div>'

  const { wikis: available, sources } = await fetchAvailable()
  body.innerHTML = ''

  // === Discovered section ===
  const sourceLabel = sources.length > 0 ? sources.join(', ') : 'samsinn-wikis'
  const header = document.createElement('div')
  header.className = 'text-[11px] uppercase tracking-wide text-text-subtle pb-1 mb-2 border-b border-border'
  header.innerHTML = `Discovered (${available.length}) <span class="text-[10px] normal-case tracking-normal text-text-muted">via ${escapeHtml(sourceLabel)}</span>`
  body.appendChild(header)

  if (available.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'text-xs text-text-muted italic mb-3'
    empty.textContent = `No wikis discovered. Set SAMSINN_WIKI_SOURCES env var to a GitHub org (default: samsinn-wikis) and restart.`
    body.appendChild(empty)
  }

  for (const w of available) {
    const row = document.createElement('div')
    row.className = 'py-2 text-xs border-b border-border flex items-center gap-2'
    const desc = w.description || 'no description'
    const status = w.installed
      ? `<span class="text-[10px] uppercase tracking-wide text-text-subtle">customized</span>`
      : `<span class="text-[10px] uppercase tracking-wide text-text-subtle">auto-active</span>`
    row.innerHTML = `
      <div class="flex-1 min-w-0">
        <div class="font-medium truncate">${escapeHtml(w.displayName)} <span class="text-text-muted">(${escapeHtml(w.id)})</span> ${status}</div>
        <div class="text-text-muted truncate" title="${escapeHtml(desc)}">${escapeHtml(desc)}</div>
        <div class="text-text-subtle text-[10px]"><a href="${escapeHtml(w.repoUrl)}" target="_blank" rel="noopener" class="hover:underline">${escapeHtml(w.owner)}/${escapeHtml(w.repo)}</a></div>
      </div>
      <button data-act="pick" class="px-2 py-1 text-xs bg-accent text-white rounded hover:opacity-90">${w.installed ? 'Edit' : 'Add PAT'}</button>
    `
    row.querySelector<HTMLButtonElement>('[data-act="pick"]')!.onclick = async () => {
      modal.close()
      await editFromAvailable(w, async () => { await onAdded() })
    }
    body.appendChild(row)
  }

  // === Manual section ===
  const manualHeader = document.createElement('div')
  manualHeader.className = 'text-[11px] uppercase tracking-wide text-text-subtle pt-3 pb-1 mt-3 mb-2 border-t border-border'
  manualHeader.textContent = 'Manual'
  body.appendChild(manualHeader)

  const manualBtn = document.createElement('button')
  manualBtn.className = 'text-xs px-3 py-2 bg-surface-muted hover:bg-surface-muted/80 rounded interactive w-full text-left'
  manualBtn.innerHTML = `<span class="font-medium">Add by GitHub owner/repo</span><div class="text-text-muted text-[11px]">For wikis not in the configured discovery sources.</div>`
  manualBtn.onclick = async () => {
    modal.close()
    await openManualAddWiki(async () => { await onAdded() })
  }
  body.appendChild(manualBtn)
}
