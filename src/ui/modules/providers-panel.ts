// ============================================================================
// Providers panel — unified list of all providers (cloud + ollama) with
// per-provider key management, reorder arrows, and Ollama settings expander.
//
// The server returns providers in current router order. Arrows let the user
// promote/demote each provider; new order is sent via PUT /api/providers/order
// and takes effect live (no restart). Ollama settings (connection, models,
// gateway config) live inside the Ollama row's expandable details.
//
// Poll-driven: refreshes /api/providers every 10s while the dashboard is open.
// Also re-renders immediately on the `providers-changed` custom event
// (fired by ws-dispatch on providers_changed broadcasts).
// ============================================================================

import { showToast } from './ui-utils.ts'

type Status = 'ok' | 'no_key' | 'cooldown' | 'down'

interface ProviderStatusEntry {
  name: string
  kind: 'cloud' | 'ollama'
  keyMask: string
  source: 'env' | 'stored' | 'none'
  enabled: boolean
  maxConcurrent: number | null
  cooldown: { coldUntilMs: number; reason: string } | null
  status: Status
}

interface ProvidersResponse {
  providers: ProviderStatusEntry[]
  activeOrder: string[]
  orderLockedByEnv: boolean
  droppedFromOrder: string[]
  forceFailProvider: string | null
  storeWarnings: string[]
}

const sourceBadge = (source: ProviderStatusEntry['source']): string => {
  if (source === 'env') return `<span class="text-[10px] px-1 bg-gray-200 text-gray-700 rounded font-mono">ENV</span>`
  if (source === 'stored') return `<span class="text-[10px] px-1 bg-blue-100 text-blue-700 rounded font-mono">STORED</span>`
  return `<span class="text-[10px] px-1 bg-gray-100 text-gray-400 rounded font-mono">—</span>`
}

const statusDot = (status: Status): string => {
  const cls =
    status === 'ok'       ? 'bg-green-500' :
    status === 'cooldown' ? 'bg-amber-400' :
    status === 'down'     ? 'bg-red-500'   :
                            'bg-gray-300'
  const title =
    status === 'ok'       ? 'ok'        :
    status === 'cooldown' ? 'cooldown'  :
    status === 'down'     ? 'down'      :
                            'no key'
  return `<span class="inline-block w-2 h-2 rounded-full ${cls}" title="${title}"></span>`
}

const statusText = (status: Status): string => {
  const cls =
    status === 'ok'       ? 'text-green-700' :
    status === 'cooldown' ? 'text-amber-700' :
    status === 'down'     ? 'text-red-700'   :
                            'text-gray-400'
  const text =
    status === 'ok'       ? 'ok'      :
    status === 'cooldown' ? 'cooldown':
    status === 'down'     ? 'down'    :
                            'no key'
  return `<span class="text-[10px] ${cls}">${text}</span>`
}

// --- Row factory ---

interface RowContext {
  readonly entry: ProviderStatusEntry
  readonly position: { readonly isFirst: boolean; readonly isLast: boolean }
  readonly orderLocked: boolean
  readonly send: {
    readonly moveUp: (name: string) => void
    readonly moveDown: (name: string) => void
  }
}

const renderRow = (ctx: RowContext): HTMLElement => {
  const { entry, position, orderLocked } = ctx
  const row = document.createElement('div')
  row.className = 'border rounded px-2 py-1 bg-gray-50 flex items-center gap-1 flex-wrap'
  row.dataset.provider = entry.name

  const locked = entry.source === 'env'
  const keyFieldId = `prov-key-${entry.name}`
  const mcFieldId = `prov-mc-${entry.name}`

  const isCloud = entry.kind === 'cloud'

  const inputs = isCloud ? `
    <input id="${keyFieldId}" type="password" placeholder="${entry.keyMask || 'paste key'}"
           class="flex-1 min-w-[120px] px-2 py-0.5 border rounded font-mono"
           ${locked ? 'disabled title="Key comes from environment variable"' : ''}>
    <label class="text-gray-500 flex items-center gap-1">max
      <input id="${mcFieldId}" type="number" min="1" max="100"
             value="${entry.maxConcurrent ?? ''}"
             class="w-12 px-1 py-0.5 border rounded">
    </label>
  ` : `
    <span class="text-gray-500 flex-1">local · max <input id="${mcFieldId}" type="number" min="1" max="100" value="${entry.maxConcurrent ?? ''}" class="w-12 px-1 py-0.5 border rounded"></span>
  `

  const actionButtons = isCloud ? `
    <button class="prov-save text-[11px] px-2 py-0.5 bg-blue-500 hover:bg-blue-600 text-white rounded" ${locked ? 'disabled' : ''}>Save</button>
    <button class="prov-clear text-[11px] px-2 py-0.5 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded" ${locked || entry.source === 'none' ? 'disabled' : ''} title="Clear stored key">Clear</button>
    <button class="prov-test text-[11px] px-2 py-0.5 bg-green-600 hover:bg-green-700 text-white rounded">Test</button>
  ` : `
    <button class="prov-save text-[11px] px-2 py-0.5 bg-blue-500 hover:bg-blue-600 text-white rounded">Save</button>
    <button class="ollama-settings-btn text-[11px] px-2 py-0.5 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded">⚙ Settings</button>
  `

  row.innerHTML = `
    <div class="flex items-center gap-1.5 mr-1">
      <button class="prov-up text-gray-400 hover:text-gray-700 disabled:opacity-20 disabled:cursor-not-allowed"
              ${position.isFirst || orderLocked ? 'disabled' : ''} title="Move up">▲</button>
      <button class="prov-down text-gray-400 hover:text-gray-700 disabled:opacity-20 disabled:cursor-not-allowed"
              ${position.isLast || orderLocked ? 'disabled' : ''} title="Move down">▼</button>
    </div>
    ${statusDot(entry.status)}
    <span class="font-medium text-gray-800">${entry.name}</span>
    ${sourceBadge(entry.source)}
    ${inputs}
    ${actionButtons}
    ${statusText(entry.status)}
    <span class="prov-feedback text-[10px] text-gray-500 ml-1"></span>
  `
  return row
}

// --- API ---

const save = async (name: string, body: Record<string, unknown>): Promise<boolean> => {
  const res = await fetch(`/api/providers/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.ok
}

const saveOrder = async (order: string[]): Promise<boolean> => {
  const res = await fetch(`/api/providers/order`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order }),
  })
  return res.ok
}

const testKey = async (name: string, apiKey?: string): Promise<{ ok: boolean; error?: string; elapsedMs: number; modelCount?: number }> => {
  const res = await fetch(`/api/providers/${encodeURIComponent(name)}/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(apiKey ? { apiKey } : {}),
  })
  try { return await res.json() as { ok: boolean; error?: string; elapsedMs: number; modelCount?: number } }
  catch { return { ok: false, error: 'invalid response', elapsedMs: 0 } }
}

// --- Render ---

let lastList: ProvidersResponse | null = null

// The Ollama settings element is reparented into the Ollama row's <details>
// on each render. Before destroying rows, return it to the dialog body so
// the next render can find it again.
const detachOllamaSettings = (): void => {
  const settings = document.getElementById('ollama-settings')
  const dialogBody = document.querySelector('#ollama-dashboard > div')
  if (settings && dialogBody && settings.parentElement !== dialogBody) {
    settings.classList.add('hidden')
    dialogBody.appendChild(settings)
  }
}

export const renderProvidersPanel = (list: ProvidersResponse): void => {
  lastList = list
  const container = document.getElementById('providers-list')
  if (!container) return

  detachOllamaSettings()
  container.innerHTML = ''

  const notice = document.getElementById('order-locked-notice')
  if (notice) notice.classList.toggle('hidden', !list.orderLockedByEnv)

  if (list.providers.length === 0) {
    container.innerHTML = '<div class="text-gray-400 italic">No providers configured.</div>'
    return
  }

  const orderNames = list.activeOrder
  const moveUp = (name: string) => {
    const idx = orderNames.indexOf(name)
    if (idx <= 0) return
    const next = [...orderNames]
    ;[next[idx - 1], next[idx]] = [next[idx]!, next[idx - 1]!]
    void saveOrder(next).then(ok => {
      if (!ok) showToast(document.body, `Failed to reorder`, { type: 'error', position: 'fixed' })
    })
  }
  const moveDown = (name: string) => {
    const idx = orderNames.indexOf(name)
    if (idx < 0 || idx >= orderNames.length - 1) return
    const next = [...orderNames]
    ;[next[idx], next[idx + 1]] = [next[idx + 1]!, next[idx]!]
    void saveOrder(next).then(ok => {
      if (!ok) showToast(document.body, `Failed to reorder`, { type: 'error', position: 'fixed' })
    })
  }

  list.providers.forEach((entry, i) => {
    const row = renderRow({
      entry,
      position: { isFirst: i === 0, isLast: i === list.providers.length - 1 },
      orderLocked: list.orderLockedByEnv,
      send: { moveUp, moveDown },
    })
    container.appendChild(row)

    // For the Ollama row, append the settings block inside an expander.
    if (entry.kind === 'ollama') {
      const details = document.createElement('details')
      details.className = 'w-full mt-1'
      const summary = document.createElement('summary')
      summary.className = 'text-[11px] text-gray-500 cursor-pointer select-none'
      summary.textContent = '⚙ settings'
      details.appendChild(summary)

      const settings = document.getElementById('ollama-settings')
      if (settings) {
        settings.classList.remove('hidden')
        details.appendChild(settings)
      }
      row.appendChild(details)

      // Wire Ollama-specific Save (maxConcurrent).
      const mcField = row.querySelector<HTMLInputElement>(`#prov-mc-${entry.name}`)
      row.querySelector<HTMLButtonElement>('.prov-save')?.addEventListener('click', async () => {
        const body: Record<string, unknown> = {}
        if (mcField?.value) {
          const n = parseInt(mcField.value, 10)
          if (Number.isFinite(n) && n > 0) body.maxConcurrent = n
        }
        const ok = await save('ollama', body)
        const feedback = row.querySelector<HTMLElement>('.prov-feedback')
        if (feedback) feedback.textContent = ok ? '✓ saved' : '✗ save failed'
        setTimeout(() => { if (feedback) feedback.textContent = '' }, 2500)
      })
      row.querySelector<HTMLButtonElement>('.ollama-settings-btn')?.addEventListener('click', () => {
        details.open = !details.open
      })
    }

    // Arrows
    row.querySelector<HTMLButtonElement>('.prov-up')?.addEventListener('click', () => moveUp(entry.name))
    row.querySelector<HTMLButtonElement>('.prov-down')?.addEventListener('click', () => moveDown(entry.name))

    // Cloud-provider Save/Clear/Test wiring
    if (entry.kind === 'cloud') {
      const keyField = row.querySelector<HTMLInputElement>(`#prov-key-${entry.name}`)
      const mcField = row.querySelector<HTMLInputElement>(`#prov-mc-${entry.name}`)
      const feedback = row.querySelector<HTMLElement>('.prov-feedback')

      row.querySelector<HTMLButtonElement>('.prov-save')?.addEventListener('click', async () => {
        const body: Record<string, unknown> = {}
        if (keyField?.value.trim()) body.apiKey = keyField.value.trim()
        if (mcField?.value) {
          const n = parseInt(mcField.value, 10)
          if (Number.isFinite(n) && n > 0) body.maxConcurrent = n
        }
        const ok = await save(entry.name, body)
        if (feedback) feedback.textContent = ok ? '✓ applied' : '✗ failed'
        if (ok && keyField) keyField.value = ''
        setTimeout(() => { if (feedback) feedback.textContent = '' }, 2500)
      })

      row.querySelector<HTMLButtonElement>('.prov-clear')?.addEventListener('click', async () => {
        const ok = await save(entry.name, { apiKey: null })
        if (feedback) feedback.textContent = ok ? '✓ cleared' : '✗ failed'
        if (ok && keyField) keyField.value = ''
        setTimeout(() => { if (feedback) feedback.textContent = '' }, 2500)
      })

      row.querySelector<HTMLButtonElement>('.prov-test')?.addEventListener('click', async () => {
        if (feedback) feedback.textContent = 'testing…'
        const pending = keyField?.value.trim()
        const result = await testKey(entry.name, pending && pending.length > 0 ? pending : undefined)
        if (result.ok) {
          if (feedback) feedback.textContent = `✓ ${result.modelCount ?? 0} models · ${result.elapsedMs}ms`
        } else {
          if (feedback) feedback.textContent = `✗ ${result.error ?? 'failed'}`
        }
      })
    }
  })

  // Store warnings
  if (list.storeWarnings.length > 0) {
    const warn = document.createElement('div')
    warn.className = 'text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mt-1'
    warn.textContent = list.storeWarnings.join(' · ')
    container.appendChild(warn)
  }
}

// --- Poll loop + lifecycle ---

let pollTimer: number | undefined
let changeListener: ((ev: Event) => void) | null = null

const refresh = async (): Promise<void> => {
  try {
    const res = await fetch('/api/providers')
    if (!res.ok) return
    const data = await res.json() as ProvidersResponse
    renderProvidersPanel(data)
  } catch { /* ignore transient fetch errors */ }
}

export const startProvidersPanel = async (): Promise<void> => {
  await refresh()
  if (pollTimer !== undefined) window.clearInterval(pollTimer)
  pollTimer = window.setInterval(() => { void refresh() }, 10_000)

  // React to live provider changes (key add/remove, reorder) without waiting
  // for the next poll tick. ws-dispatch dispatches this from providers_changed
  // broadcasts.
  if (!changeListener) {
    changeListener = () => { void refresh() }
    window.addEventListener('providers-changed', changeListener)
  }
}

export const stopProvidersPanel = (): void => {
  if (pollTimer !== undefined) {
    window.clearInterval(pollTimer)
    pollTimer = undefined
  }
  if (changeListener) {
    window.removeEventListener('providers-changed', changeListener)
    changeListener = null
  }

  void lastList
  detachOllamaSettings()
}
