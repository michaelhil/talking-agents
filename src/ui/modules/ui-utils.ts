// ============================================================================
// UI Utilities — shared helpers extracted from across the UI layer.
//
// Toast notifications, safe fetch, dirty-check tracking, ID lookups.
// ============================================================================

import { $agentIdByName, $roomIdByName, $agents, $rooms } from './stores.ts'
import type { RoomProfile } from './stores.ts'

// === Toast notifications ===

/**
 * Show a brief toast message anchored to a DOM element.
 * `position` controls whether the toast appears relative to the anchor
 * ('relative' — positioned inside anchor) or fixed to viewport ('fixed').
 */
export const showToast = (
  anchor: HTMLElement,
  message: string,
  options?: { type?: 'success' | 'error'; position?: 'relative' | 'fixed'; durationMs?: number },
): void => {
  const type = options?.type ?? 'success'
  const position = options?.position ?? 'relative'
  // Errors stay up longer — they typically carry detail the user needs to
  // read. Success toasts are short acknowledgements.
  const defaultMs = type === 'error' ? 8000 : 3000
  const durationMs = options?.durationMs ?? defaultMs
  const toast = document.createElement('div')

  if (position === 'fixed') {
    toast.className = `fixed top-4 right-4 ${type === 'success' ? 'bg-green-600' : 'bg-red-600'} text-white text-xs px-4 py-2 rounded shadow-lg z-50 transition-opacity duration-700 max-w-md cursor-pointer`
    document.body.appendChild(toast)
  } else {
    toast.className = `absolute left-1/2 -translate-x-1/2 ${type === 'success' ? 'bg-green-600' : 'bg-red-600'} text-white text-xs px-3 py-1 rounded shadow transition-opacity duration-700 cursor-pointer`
    toast.style.bottom = '4px'
    anchor.appendChild(toast)
  }

  toast.textContent = message
  toast.title = 'click to dismiss'
  // Click-to-dismiss — useful for error toasts the user has already read.
  toast.addEventListener('click', () => toast.remove(), { once: true })
  const fadeAt = Math.max(500, durationMs - 700)
  setTimeout(() => { toast.style.opacity = '0' }, fadeAt)
  setTimeout(() => { toast.remove() }, durationMs)
}

// === Safe fetch with error handling ===

/**
 * Fetch with try/catch. Returns null on network error.
 * Logs errors to console.
 */
export const safeFetch = async (url: string, init?: RequestInit): Promise<Response | null> => {
  try {
    const res = await fetch(url, init)
    if (!res.ok) {
      console.error(`Fetch ${init?.method ?? 'GET'} ${url} failed: ${res.status}`)
      return null
    }
    return res
  } catch (err) {
    console.error(`Fetch ${url} error:`, err)
    return null
  }
}

/**
 * Fetch JSON with try/catch. Returns null on error.
 */
export const safeFetchJson = async <T>(url: string, init?: RequestInit): Promise<T | null> => {
  const res = await safeFetch(url, init)
  if (!res) return null
  try {
    return await res.json() as T
  } catch {
    return null
  }
}

// === Dirty-check tracker for editable fields ===

export interface DirtyTracker {
  readonly update: (current: string) => void
  readonly reset: (newBaseline: string) => void
  readonly isDirty: () => boolean
}

/**
 * Tracks whether a string value has changed from its baseline.
 * Calls onDirtyChange whenever the dirty state transitions.
 */
export const createDirtyTracker = (
  initial: string,
  onDirtyChange: (dirty: boolean) => void,
): DirtyTracker => {
  let baseline = initial
  let dirty = false

  return {
    update(current: string): void {
      const nowDirty = current !== baseline
      if (nowDirty !== dirty) {
        dirty = nowDirty
        onDirtyChange(dirty)
      }
    },
    reset(newBaseline: string): void {
      baseline = newBaseline
      if (dirty) {
        dirty = false
        onDirtyChange(false)
      }
    },
    isDirty: () => dirty,
  }
}

// === Identity lookups (use stores) ===

/** Agent name → agent ID (via computed store). */
export const agentNameToId = (name: string): string | undefined =>
  $agentIdByName.get()[name]

/** Room name → room ID (via computed store). */
export const roomNameToId = (name: string): string | undefined =>
  $roomIdByName.get()[name]

/** Agent ID → agent name. */
export const agentIdToName = (id: string): string | undefined =>
  $agents.get()[id]?.name

/** Room ID → room name. */
export const roomIdToName = (id: string): string | undefined =>
  $rooms.get()[id]?.name

/** Find a room entry by name. */
export const getRoomByName = (name: string): RoomProfile | undefined => {
  const id = roomNameToId(name)
  return id ? $rooms.get()[id] : undefined
}

// === Model dropdown builder ===

export interface ModelCatalogModel {
  id: string
  contextMax: number
  recommended: boolean
  pinned?: boolean
  running?: boolean
  label?: string
}

export interface ModelCatalogProvider {
  name: string
  status: 'ok' | 'no_key' | 'cooldown' | 'down'
  models: ModelCatalogModel[]
}

export interface ModelCatalogResponse {
  providers: ModelCatalogProvider[]
  defaultModel: string
}

const SHOW_ALL_KEY = 'samsinn-model-show-all'
export const getShowAllModels = (): boolean =>
  typeof localStorage !== 'undefined' && localStorage.getItem(SHOW_ALL_KEY) === 'true'
export const setShowAllModels = (v: boolean): void => {
  if (typeof localStorage !== 'undefined') localStorage.setItem(SHOW_ALL_KEY, String(v))
}

const formatContext = (n: number): string => {
  if (!n || n <= 0) return ''
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

const fullModelId = (providerName: string, modelId: string): string =>
  providerName === 'ollama' ? modelId : `${providerName}:${modelId}`

const statusLabel = (status: ModelCatalogProvider['status']): string => {
  if (status === 'ok') return ''
  if (status === 'no_key') return ' (no key)'
  if (status === 'cooldown') return ' (cooldown)'
  return ' (down)'
}

export const fetchModelCatalog = async (): Promise<ModelCatalogResponse> => {
  try {
    const res = await fetch('/api/models')
    if (!res.ok) return { providers: [], defaultModel: '' }
    return await res.json() as ModelCatalogResponse
  } catch {
    return { providers: [], defaultModel: '' }
  }
}

/**
 * Populate a <select> with models grouped by provider. Providers with status
 * 'no_key' are hidden. When showAll=false (default), only curated/recommended
 * models are listed; when true, all provider-reported models appear.
 *
 * `preferredModel` — when provided, it's pre-selected if present. Otherwise
 * the server-reported `defaultModel` wins.
 *
 * Returns the value that ended up selected (possibly empty).
 */
export const populateModelSelect = async (
  select: HTMLSelectElement,
  options: { preferredModel?: string; showAll?: boolean } = {},
): Promise<string> => {
  select.innerHTML = '<option value="">Loading...</option>'
  const data = await fetchModelCatalog()
  const showAll = options.showAll ?? getShowAllModels()

  select.innerHTML = ''

  const visible = data.providers.filter(p => p.status !== 'no_key')

  if (visible.length === 0) {
    select.innerHTML = '<option value="">No providers configured</option>'
    return ''
  }

  const all: string[] = []
  for (const prov of visible) {
    const models = showAll ? prov.models : prov.models.filter(m => m.recommended)
    if (models.length === 0) continue
    const group = document.createElement('optgroup')
    group.label = `${prov.name}${statusLabel(prov.status)}`
    for (const m of models) {
      const opt = document.createElement('option')
      const full = fullModelId(prov.name, m.id)
      opt.value = full
      const label = m.label ? `${m.id} — ${m.label}` : m.id
      const ctx = formatContext(m.contextMax)
      const pinTag = m.pinned ? '★ ' : ''
      const runTag = m.running ? ' (running)' : ''
      opt.textContent = ctx
        ? `${pinTag}${label} · ${ctx}${runTag}`
        : `${pinTag}${label}${runTag}`
      if (prov.status === 'cooldown' || prov.status === 'down') opt.classList.add('text-gray-400')
      group.appendChild(opt)
      all.push(full)
    }
    select.appendChild(group)
  }

  if (all.length === 0) {
    select.innerHTML = '<option value="">No models available</option>'
    return ''
  }

  const chosen = (options.preferredModel && all.includes(options.preferredModel))
    ? options.preferredModel
    : (data.defaultModel && all.includes(data.defaultModel) ? data.defaultModel : all[0]!)
  select.value = chosen

  // If the preferred model wasn't in the list (e.g. a legacy Ollama model), add
  // it at the top as "(not available)" so the user can still see the current
  // value.
  if (options.preferredModel && !all.includes(options.preferredModel)) {
    const opt = document.createElement('option')
    opt.value = options.preferredModel
    opt.textContent = `${options.preferredModel} (not available)`
    opt.selected = true
    select.insertBefore(opt, select.firstChild)
    return options.preferredModel
  }

  return chosen
}
