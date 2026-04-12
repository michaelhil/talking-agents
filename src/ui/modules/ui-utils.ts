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
  options?: { type?: 'success' | 'error'; position?: 'relative' | 'fixed' },
): void => {
  const type = options?.type ?? 'success'
  const position = options?.position ?? 'relative'
  const toast = document.createElement('div')

  if (position === 'fixed') {
    toast.className = `fixed top-4 right-4 ${type === 'success' ? 'bg-green-600' : 'bg-red-600'} text-white text-xs px-4 py-2 rounded shadow-lg z-50 transition-opacity duration-700`
    document.body.appendChild(toast)
  } else {
    toast.className = `absolute left-1/2 -translate-x-1/2 ${type === 'success' ? 'bg-green-600' : 'bg-red-600'} text-white text-xs px-3 py-1 rounded shadow transition-opacity duration-700`
    toast.style.bottom = '4px'
    anchor.appendChild(toast)
  }

  toast.textContent = message
  setTimeout(() => { toast.style.opacity = '0' }, 2000)
  setTimeout(() => { toast.remove() }, 3000)
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

/**
 * Populate a <select> element with model options from the /api/models endpoint.
 * Groups models into "Running" and "Available" optgroups.
 * Returns the default model name (or empty string if none found).
 */
export const populateModelSelect = async (
  select: HTMLSelectElement,
  preferredDefaults?: string[],
): Promise<string> => {
  select.innerHTML = '<option value="">Loading...</option>'
  try {
    const res = await fetch('/api/models')
    const data = await res.json() as { running: string[]; available: string[] }
    select.innerHTML = ''
    const allModels = [...(data.running ?? []), ...(data.available ?? [])]
    const defaults = preferredDefaults ?? ['llama3.2:latest', 'qwen3:4b', 'llama3.2:3b']
    const defaultModel = defaults.find(p => allModels.includes(p)) ?? allModels[0] ?? ''

    if (data.running.length > 0) {
      const group = document.createElement('optgroup')
      group.label = 'Running'
      for (const m of data.running) {
        const opt = document.createElement('option')
        opt.value = m; opt.textContent = m; opt.selected = m === defaultModel
        group.appendChild(opt)
      }
      select.appendChild(group)
    }
    if (data.available.length > 0) {
      const group = document.createElement('optgroup')
      group.label = 'Available'
      for (const m of data.available) {
        const opt = document.createElement('option')
        opt.value = m; opt.textContent = m; opt.selected = m === defaultModel
        group.appendChild(opt)
      }
      select.appendChild(group)
    }
    if (allModels.length === 0) {
      select.innerHTML = '<option value="">No models found</option>'
    }
    return defaultModel
  } catch {
    select.innerHTML = '<option value="">Failed to load models</option>'
    return ''
  }
}
