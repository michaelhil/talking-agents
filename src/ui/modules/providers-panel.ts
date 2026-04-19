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
import { openModelsPopover } from './models-popover.ts'

type Status = 'ok' | 'no_key' | 'cooldown' | 'down' | 'disabled'

interface ProviderStatusEntry {
  name: string
  kind: 'cloud' | 'ollama'
  keyMask: string
  source: 'env' | 'stored' | 'none'
  enabled: boolean
  userEnabled: boolean
  hasKey: boolean
  maxConcurrent: number | null
  cooldown: { coldUntilMs: number; reason: string } | null
  status: Status
}

// Where to send users to get an API key. Top-level consoles are more stable
// than deep-link API-keys pages. Maintained inline here — edit when dashboards
// move.
const PROVIDER_URLS: Record<string, string> = {
  anthropic:  'https://console.anthropic.com',
  gemini:     'https://aistudio.google.com',
  cerebras:   'https://cloud.cerebras.ai',
  groq:       'https://console.groq.com',
  openrouter: 'https://openrouter.ai',
  mistral:    'https://console.mistral.ai',
  sambanova:  'https://cloud.sambanova.ai',
  ollama:     'https://ollama.com',
}

interface ProvidersResponse {
  providers: ProviderStatusEntry[]
  activeOrder: string[]
  orderLockedByEnv: boolean
  droppedFromOrder: string[]
  forceFailProvider: string | null
  storeWarnings: string[]
}

const dotColourClass = (status: Status): string => {
  if (status === 'ok') return 'bg-green-500'
  if (status === 'cooldown') return 'bg-amber-400'
  if (status === 'down') return 'bg-red-500'
  // disabled + no_key both render as gray; disabled gets the slash overlay.
  return 'bg-gray-300'
}

const statusTooltip = (status: Status): string => {
  if (status === 'ok') return 'ok — click to disable'
  if (status === 'cooldown') return 'cooldown — click to disable'
  if (status === 'down') return 'down — click to disable'
  if (status === 'disabled') return 'disabled — click to enable'
  return 'no key'
}

// Returns the `<button>` that holds the status dot + optional red slash.
// The outer button is a larger click target (16×16) for comfort.
const statusButton = (status: Status): string => {
  const dot = `<span class="inline-block w-2.5 h-2.5 rounded-full ${dotColourClass(status)}"></span>`
  const slash = status === 'disabled'
    ? `<span class="absolute inset-0 flex items-center justify-center pointer-events-none"
             aria-hidden="true"
             style="transform: rotate(-45deg)">
         <span class="block h-[2px] w-3.5 bg-red-500 rounded"></span>
       </span>`
    : ''
  return `<button class="prov-dot-btn relative w-4 h-4 flex items-center justify-center shrink-0 cursor-pointer" title="${statusTooltip(status)}">
    ${dot}
    ${slash}
  </button>`
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
  row.className = 'border rounded px-2 py-1 bg-gray-50 flex items-center gap-2'
  row.dataset.provider = entry.name

  const locked = entry.source === 'env'
  const keyFieldId = `prov-key-${entry.name}`
  const mcFieldId = `prov-mc-${entry.name}`

  const isCloud = entry.kind === 'cloud'
  const url = PROVIDER_URLS[entry.name] ?? '#'

  // Provider name: clickable link to its dashboard (no external-link glyph).
  // A separate `[≡]` button opens the models popover.
  const nameCol = `
    <div class="w-24 shrink-0 flex items-center gap-1">
      <a href="${url}" target="_blank" rel="noopener noreferrer"
         class="font-medium text-gray-800 hover:text-blue-600 hover:underline truncate"
         title="Open ${entry.name} dashboard in a new tab">${entry.name}</a>
      <button class="prov-models-btn text-gray-400 hover:text-gray-700 shrink-0"
              title="Show available models">≡</button>
    </div>
  `

  // Key field (cloud only). type=text so the stub is selectable and
  // editable; value = current stub (empty when no key). Tab-out / blur
  // triggers save. Fixed width so columns align.
  const keyField = isCloud ? `
    <input id="${keyFieldId}" type="text"
           value="${entry.keyMask ?? ''}"
           data-original="${entry.keyMask ?? ''}"
           placeholder="paste key"
           class="w-24 shrink-0 px-2 py-0.5 border rounded font-mono text-[11px]"
           ${locked ? 'disabled title="Key comes from environment variable"' : ''}>
  ` : `
    <span class="w-24 shrink-0 text-[11px] text-gray-500 italic">local</span>
  `

  const maxField = `
    <label class="text-gray-500 flex items-center gap-0.5 shrink-0">max
      <input id="${mcFieldId}" type="number" min="1" max="100"
             value="${entry.maxConcurrent ?? ''}"
             data-original="${entry.maxConcurrent ?? ''}"
             class="w-9 px-1 py-0.5 border rounded">
    </label>
  `

  const actionButtons = isCloud ? `
    <button class="prov-test text-[11px] px-2 py-0.5 bg-green-600 hover:bg-green-700 text-white rounded shrink-0">Test</button>
  ` : `
    <button class="ollama-settings-btn text-[11px] px-2 py-0.5 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded shrink-0">⚙ Settings</button>
  `

  const arrows = `
    <div class="flex items-center gap-1.5 shrink-0 ml-auto">
      <button class="prov-up text-gray-400 hover:text-gray-700 disabled:opacity-20 disabled:cursor-not-allowed"
              ${position.isFirst || orderLocked ? 'disabled' : ''} title="Move up">▲</button>
      <button class="prov-down text-gray-400 hover:text-gray-700 disabled:opacity-20 disabled:cursor-not-allowed"
              ${position.isLast || orderLocked ? 'disabled' : ''} title="Move down">▼</button>
    </div>
  `

  row.innerHTML = `
    ${statusButton(entry.status)}
    ${nameCol}
    ${keyField}
    ${maxField}
    ${actionButtons}
    ${arrows}
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

      // Ollama: blur on max triggers save.
      const mcField = row.querySelector<HTMLInputElement>(`#prov-mc-${entry.name}`)
      mcField?.addEventListener('blur', async () => {
        if ((mcField.dataset.original ?? '') === mcField.value) return
        const n = parseInt(mcField.value, 10)
        if (!Number.isFinite(n) || n <= 0) return
        const ok = await save('ollama', { maxConcurrent: n })
        showToast(document.body, ok ? `ollama: concurrency updated` : `ollama: save failed`, { type: ok ? 'success' : 'error', position: 'fixed' })
      })
      row.querySelector<HTMLButtonElement>('.ollama-settings-btn')?.addEventListener('click', () => {
        details.open = !details.open
      })
    }

    // Arrows
    row.querySelector<HTMLButtonElement>('.prov-up')?.addEventListener('click', () => moveUp(entry.name))
    row.querySelector<HTMLButtonElement>('.prov-down')?.addEventListener('click', () => moveDown(entry.name))

    // Models popover
    const modelsBtn = row.querySelector<HTMLButtonElement>('.prov-models-btn')
    modelsBtn?.addEventListener('click', (e) => {
      e.stopPropagation()
      void openModelsPopover(modelsBtn, entry.name)
    })

    // Status dot click → toggle user-enabled (requires a key, unless Ollama)
    row.querySelector<HTMLButtonElement>('.prov-dot-btn')?.addEventListener('click', async () => {
      // No key on a cloud provider → show a nudge, don't toggle.
      if (entry.kind === 'cloud' && !entry.hasKey) {
        showToast(document.body, `Paste an ${entry.name} key first`, { type: 'error', position: 'fixed' })
        return
      }
      const nextEnabled = !entry.userEnabled
      const ok = await save(entry.name, { enabled: nextEnabled })
      if (!ok) {
        showToast(document.body, `${entry.name}: failed to ${nextEnabled ? 'enable' : 'disable'}`, { type: 'error', position: 'fixed' })
      }
      // `providers_changed` broadcast (fired by the PUT handler) will trigger
      // the panel to re-render with the new status.
    })

    // Cloud-provider blur-triggered save + test; Test button still available
    // for "validate without committing" on an unsaved typed value.
    if (entry.kind === 'cloud') {
      const keyField = row.querySelector<HTMLInputElement>(`#prov-key-${entry.name}`)
      const mcField = row.querySelector<HTMLInputElement>(`#prov-mc-${entry.name}`)

      // Blur on the key field — save if the value has changed.
      keyField?.addEventListener('blur', async () => {
        const original = keyField.dataset.original ?? ''
        const current = keyField.value
        if (current === original) return

        const trimmed = current.trim()
        if (trimmed === '') {
          // Empty / whitespace → clear the stored key.
          const ok = await save(entry.name, { apiKey: null })
          showToast(document.body, ok
            ? `${entry.name}: key cleared`
            : `${entry.name}: clear failed`,
            { type: ok ? 'success' : 'error', position: 'fixed' })
          return
        }

        // New value — save, then test the stored key end-to-end.
        const savedOk = await save(entry.name, { apiKey: trimmed })
        if (!savedOk) {
          showToast(document.body, `${entry.name}: save failed`, { type: 'error', position: 'fixed' })
          return
        }
        const result = await testKey(entry.name)
        if (result.ok) {
          showToast(document.body, `${entry.name}: saved & verified — ${result.modelCount ?? 0} models · ${result.elapsedMs}ms`, { type: 'success', position: 'fixed' })
        } else {
          showToast(document.body, `${entry.name}: saved — test failed: ${result.error ?? 'unknown'}`, { type: 'error', position: 'fixed' })
        }
      })

      // Blur on the max field — save if changed.
      mcField?.addEventListener('blur', async () => {
        const original = mcField.dataset.original ?? ''
        if (mcField.value === original) return
        const n = parseInt(mcField.value, 10)
        if (!Number.isFinite(n) || n <= 0) return
        const ok = await save(entry.name, { maxConcurrent: n })
        showToast(document.body, ok
          ? `${entry.name}: concurrency updated`
          : `${entry.name}: save failed`,
          { type: ok ? 'success' : 'error', position: 'fixed' })
      })

      // Test button: validates the typed value (or the stored key when no
      // typed change). Posts a toast with the outcome.
      row.querySelector<HTMLButtonElement>('.prov-test')?.addEventListener('click', async () => {
        const typed = keyField?.value.trim()
        const original = keyField?.dataset.original ?? ''
        const pending = typed && typed !== original ? typed : undefined
        showToast(document.body, `${entry.name}: testing…`, { position: 'fixed' })
        const result = await testKey(entry.name, pending)
        if (result.ok) {
          showToast(document.body, `${entry.name}: ${result.modelCount ?? 0} models · ${result.elapsedMs}ms`, { type: 'success', position: 'fixed' })
        } else {
          showToast(document.body, `${entry.name}: ${result.error ?? 'test failed'}`, { type: 'error', position: 'fixed' })
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
