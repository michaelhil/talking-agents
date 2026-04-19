// ============================================================================
// Models popover — floating panel attached to a provider row that lists the
// provider's available models with metadata + pin toggles.
//
// Data source: POST /api/providers/:name/refresh-models refreshes the
// gateway cache and returns the union of (reported + curated) with
// context-window info and pin state.
// ============================================================================

import { showToast } from './ui-utils.ts'

interface PopoverModel {
  readonly id: string
  readonly contextMax: number
  readonly curated: boolean
  readonly pinned: boolean
  readonly label?: string
}

interface RefreshResponse {
  readonly ok: boolean
  readonly error?: string
  readonly elapsedMs: number
  readonly models: ReadonlyArray<PopoverModel>
}

const formatContext = (n: number): string => {
  if (!n || n <= 0) return '—'
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

let currentPopover: HTMLElement | null = null
let outsideClickHandler: ((e: MouseEvent) => void) | null = null
let escHandler: ((e: KeyboardEvent) => void) | null = null

const closePopover = (): void => {
  if (currentPopover) {
    currentPopover.remove()
    currentPopover = null
  }
  if (outsideClickHandler) {
    document.removeEventListener('click', outsideClickHandler, true)
    outsideClickHandler = null
  }
  if (escHandler) {
    document.removeEventListener('keydown', escHandler)
    escHandler = null
  }
}

const renderList = (
  popover: HTMLElement,
  providerName: string,
  data: RefreshResponse,
  pinnedSet: Set<string>,
  onTogglePin: (modelId: string) => Promise<void>,
): void => {
  popover.innerHTML = ''

  const header = document.createElement('div')
  header.className = 'px-3 py-2 border-b text-[11px] text-gray-500 flex items-center justify-between sticky top-0 bg-white'
  header.innerHTML = `
    <span><strong class="text-gray-800">${providerName}</strong> — ${data.models.length} model${data.models.length === 1 ? '' : 's'} · ${data.elapsedMs}ms</span>
    <button class="models-popover-close text-gray-400 hover:text-gray-700">✕</button>
  `
  popover.appendChild(header)
  header.querySelector<HTMLButtonElement>('.models-popover-close')?.addEventListener('click', closePopover)

  if (!data.ok && data.error) {
    const err = document.createElement('div')
    err.className = 'px-3 py-2 text-[11px] text-red-600 bg-red-50 border-b'
    err.textContent = `Could not refresh: ${data.error}`
    popover.appendChild(err)
  }

  if (data.models.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'px-3 py-4 text-[11px] text-gray-400 italic text-center'
    empty.textContent = 'No models reported — add a key or wait a moment.'
    popover.appendChild(empty)
    return
  }

  const list = document.createElement('div')
  list.className = 'max-h-80 overflow-y-auto'

  for (const m of data.models) {
    const row = document.createElement('div')
    row.className = 'flex items-center gap-2 px-3 py-1 hover:bg-gray-50 text-[11px] border-b border-gray-100'

    const isPinned = pinnedSet.has(m.id)
    const pinBtn = document.createElement('button')
    pinBtn.className = `shrink-0 w-5 text-center ${isPinned ? 'text-amber-500' : 'text-gray-300 hover:text-amber-400'}`
    pinBtn.textContent = isPinned ? '★' : '☆'
    pinBtn.title = isPinned ? 'Unpin' : 'Pin (show first in model dropdown)'
    pinBtn.onclick = (e) => {
      e.stopPropagation()
      void onTogglePin(m.id)
    }
    row.appendChild(pinBtn)

    const id = document.createElement('span')
    id.className = 'font-mono flex-1 min-w-0 truncate text-gray-800'
    id.textContent = m.id
    id.title = m.id
    row.appendChild(id)

    if (m.curated) {
      const badge = document.createElement('span')
      badge.className = 'shrink-0 text-[9px] px-1 bg-blue-100 text-blue-700 rounded'
      badge.textContent = 'curated'
      row.appendChild(badge)
    }

    const ctx = document.createElement('span')
    ctx.className = 'shrink-0 w-10 text-right text-gray-500'
    ctx.textContent = formatContext(m.contextMax)
    ctx.title = m.contextMax > 0 ? `${m.contextMax.toLocaleString()} tokens context` : 'context window unknown'
    row.appendChild(ctx)

    list.appendChild(row)
  }

  popover.appendChild(list)
}

export const openModelsPopover = async (
  anchor: HTMLElement,
  providerName: string,
): Promise<void> => {
  // Toggle: clicking the same anchor again closes the popover.
  if (currentPopover && currentPopover.dataset.anchorProvider === providerName) {
    closePopover()
    return
  }
  closePopover()

  const popover = document.createElement('div')
  popover.dataset.anchorProvider = providerName
  popover.className = 'absolute z-50 bg-white border rounded shadow-lg w-[380px] text-[11px]'
  popover.innerHTML = '<div class="px-3 py-4 text-gray-400 text-[11px] text-center italic">Loading…</div>'

  // Position under the anchor, aligned to its left edge. Clip to viewport:
  // if the popover would overflow the right edge, align to the right instead.
  const rect = anchor.getBoundingClientRect()
  popover.style.top = `${window.scrollY + rect.bottom + 4}px`
  const leftEdge = window.scrollX + rect.left
  const spaceRight = window.innerWidth - rect.left
  if (spaceRight < 380 + 16) {
    popover.style.left = `${Math.max(8, window.scrollX + rect.right - 380)}px`
  } else {
    popover.style.left = `${leftEdge}px`
  }

  document.body.appendChild(popover)
  currentPopover = popover

  // Click-outside to close.
  outsideClickHandler = (e: MouseEvent) => {
    if (!popover.contains(e.target as Node) && e.target !== anchor && !anchor.contains(e.target as Node)) {
      closePopover()
    }
  }
  setTimeout(() => { if (outsideClickHandler) document.addEventListener('click', outsideClickHandler, true) }, 0)

  escHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') closePopover() }
  document.addEventListener('keydown', escHandler)

  // Fetch + render.
  let pinnedSet = new Set<string>()
  let data: RefreshResponse
  try {
    const res = await fetch(`/api/providers/${encodeURIComponent(providerName)}/refresh-models`, { method: 'POST' })
    data = await res.json() as RefreshResponse
    pinnedSet = new Set(data.models.filter(m => m.pinned).map(m => m.id))
  } catch (err) {
    popover.innerHTML = ''
    const msg = document.createElement('div')
    msg.className = 'px-3 py-2 text-[11px] text-red-600'
    msg.textContent = `Failed to load: ${err instanceof Error ? err.message : String(err)}`
    popover.appendChild(msg)
    return
  }

  const onTogglePin = async (modelId: string): Promise<void> => {
    if (pinnedSet.has(modelId)) pinnedSet.delete(modelId)
    else pinnedSet.add(modelId)
    // Re-render optimistically.
    renderList(popover, providerName, data, pinnedSet, onTogglePin)
    // Persist.
    try {
      const res = await fetch(`/api/providers/${encodeURIComponent(providerName)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinnedModels: [...pinnedSet] }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      // The providers_changed WS broadcast (fired by PUT) will rebuild the
      // model dropdown elsewhere; we don't need to re-fetch here.
    } catch (err) {
      showToast(document.body, `Failed to save pin: ${err instanceof Error ? err.message : String(err)}`, { type: 'error', position: 'fixed' })
      // Revert local state.
      if (pinnedSet.has(modelId)) pinnedSet.delete(modelId)
      else pinnedSet.add(modelId)
      renderList(popover, providerName, data, pinnedSet, onTogglePin)
    }
  }

  renderList(popover, providerName, data, pinnedSet, onTogglePin)
}

export const closeModelsPopover = (): void => closePopover()
