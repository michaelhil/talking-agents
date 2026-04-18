// ============================================================================
// Cloud providers panel — rendered inside the Providers dashboard dialog.
// Lists cerebras / groq / openrouter / mistral / sambanova with per-provider
// key management (masked), enabled toggle, maxConcurrent, and Test button.
//
// Poll-driven: refreshes /api/providers every 10s while the dashboard is open.
// ============================================================================

import { showToast } from './ui-utils.ts'

interface ProviderStatusEntry {
  name: string
  kind: 'cloud' | 'ollama'
  keyMask: string
  source: 'env' | 'stored' | 'none'
  enabled: boolean
  maxConcurrent: number | null
  cooldown: { coldUntilMs: number; reason: string } | null
  inRouter: boolean
}

interface ProvidersResponse {
  providers: ProviderStatusEntry[]
  activeOrder: string[]
  droppedFromOrder: string[]
  forceFailProvider: string | null
  storeWarnings: string[]
}

const sourceBadge = (source: ProviderStatusEntry['source']): string => {
  if (source === 'env') return `<span class="text-[10px] px-1 py-0.5 bg-gray-200 text-gray-700 rounded font-mono">ENV</span>`
  if (source === 'stored') return `<span class="text-[10px] px-1 py-0.5 bg-blue-100 text-blue-700 rounded font-mono">STORED</span>`
  return `<span class="text-[10px] px-1 py-0.5 bg-gray-100 text-gray-400 rounded font-mono">—</span>`
}

const statusDot = (entry: ProviderStatusEntry): string => {
  if (!entry.inRouter) return `<span class="inline-block w-2 h-2 rounded-full bg-gray-300" title="not in active router order"></span>`
  if (entry.cooldown) return `<span class="inline-block w-2 h-2 rounded-full bg-amber-400" title="${entry.cooldown.reason}"></span>`
  return `<span class="inline-block w-2 h-2 rounded-full bg-green-500"></span>`
}

const renderCloudRow = (entry: ProviderStatusEntry): HTMLElement => {
  const row = document.createElement('div')
  row.className = 'border rounded p-2 space-y-1.5 bg-gray-50'
  row.dataset.provider = entry.name

  const enabledBoxId = `prov-enabled-${entry.name}`
  const keyFieldId = `prov-key-${entry.name}`
  const mcFieldId = `prov-mc-${entry.name}`
  const locked = entry.source === 'env'

  row.innerHTML = `
    <div class="flex items-center gap-2">
      ${statusDot(entry)}
      <span class="font-medium text-gray-800">${entry.name}</span>
      ${sourceBadge(entry.source)}
      ${entry.inRouter ? '<span class="text-[10px] text-green-700">· active</span>' : ''}
      <label class="ml-auto flex items-center gap-1 text-xs text-gray-600">
        <input id="${enabledBoxId}" type="checkbox" ${entry.enabled ? 'checked' : ''} ${locked ? 'disabled' : ''}>
        enabled
      </label>
    </div>
    <div class="flex items-center gap-1">
      <input id="${keyFieldId}" type="password" placeholder="${entry.keyMask || 'no key — paste to set'}"
             class="flex-1 px-2 py-1 text-xs border rounded font-mono"
             ${locked ? 'disabled title="Key comes from environment variable; unset the env var to edit here"' : ''}>
      <label class="text-xs text-gray-500 flex items-center gap-1">max
        <input id="${mcFieldId}" type="number" min="1" max="100"
               value="${entry.maxConcurrent ?? ''}"
               class="w-14 px-1 py-0.5 text-xs border rounded">
      </label>
      <button class="prov-save text-xs px-2 py-1 bg-blue-500 hover:bg-blue-600 text-white rounded" ${locked ? 'disabled' : ''}>Save</button>
      <button class="prov-clear text-xs px-2 py-1 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded" ${locked || entry.source === 'none' ? 'disabled' : ''} title="Clear stored key">Clear</button>
      <button class="prov-test text-xs px-2 py-1 bg-green-600 hover:bg-green-700 text-white rounded">Test</button>
    </div>
    <div class="prov-feedback text-[11px] text-gray-500 min-h-[14px]"></div>
  `
  return row
}

const renderOllamaSummary = (entry: ProviderStatusEntry): HTMLElement => {
  // Ollama has its own existing UI section (connection, models, metrics).
  // This compact row just shows overall enabled/maxConcurrent controls.
  const row = document.createElement('div')
  row.className = 'border rounded p-2 space-y-1.5 bg-gray-50'
  row.dataset.provider = 'ollama'
  const enabledBoxId = `prov-enabled-ollama`
  const mcFieldId = `prov-mc-ollama`
  row.innerHTML = `
    <div class="flex items-center gap-2">
      ${statusDot(entry)}
      <span class="font-medium text-gray-800">ollama</span>
      <span class="text-[10px] text-gray-500">· local</span>
      ${entry.inRouter ? '<span class="text-[10px] text-green-700">· active</span>' : ''}
      <label class="ml-auto flex items-center gap-1 text-xs text-gray-600">
        <input id="${enabledBoxId}" type="checkbox" ${entry.enabled ? 'checked' : ''}>
        enabled
      </label>
    </div>
    <div class="flex items-center gap-1 text-xs text-gray-500">
      <span>Connection + models managed below.</span>
      <label class="ml-auto flex items-center gap-1">max
        <input id="${mcFieldId}" type="number" min="1" max="100"
               value="${entry.maxConcurrent ?? ''}"
               class="w-14 px-1 py-0.5 text-xs border rounded">
      </label>
      <button class="prov-save text-xs px-2 py-1 bg-blue-500 hover:bg-blue-600 text-white rounded">Save</button>
    </div>
  `
  return row
}

const save = async (name: string, body: Record<string, unknown>): Promise<boolean> => {
  const res = await fetch(`/api/providers/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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

const markRestartPending = (): void => {
  const banner = document.getElementById('providers-restart-banner')
  if (banner) banner.classList.remove('hidden')
}

export const renderProvidersPanel = (list: ProvidersResponse): void => {
  const container = document.getElementById('cloud-providers-list')
  if (!container) return

  container.innerHTML = ''

  const cloud = list.providers.filter(p => p.kind === 'cloud')
  const ollama = list.providers.find(p => p.kind === 'ollama')

  if (cloud.length === 0) {
    const note = document.createElement('div')
    note.className = 'text-xs text-gray-400'
    note.textContent = 'No cloud providers configured. Paste an API key below to enable one.'
    container.appendChild(note)
  }
  for (const entry of cloud) {
    container.appendChild(renderCloudRow(entry))
  }
  if (ollama) container.appendChild(renderOllamaSummary(ollama))

  // Wire buttons
  container.querySelectorAll<HTMLElement>('[data-provider]').forEach(row => {
    const name = row.dataset.provider!
    const feedback = row.querySelector<HTMLDivElement>('.prov-feedback')
    const keyField = row.querySelector<HTMLInputElement>(`#prov-key-${name}`)
    const mcField = row.querySelector<HTMLInputElement>(`#prov-mc-${name}`)
    const enabledBox = row.querySelector<HTMLInputElement>(`#prov-enabled-${name}`)

    row.querySelector<HTMLButtonElement>('.prov-save')?.addEventListener('click', async () => {
      const body: Record<string, unknown> = {}
      if (keyField && keyField.value.trim().length > 0) body.apiKey = keyField.value.trim()
      if (enabledBox) body.enabled = enabledBox.checked
      if (mcField && mcField.value.trim().length > 0) {
        const n = parseInt(mcField.value, 10)
        if (Number.isFinite(n) && n > 0) body.maxConcurrent = n
      }
      const ok = await save(name, body)
      if (ok) {
        if (feedback) feedback.textContent = 'Saved — restart to apply.'
        markRestartPending()
        if (keyField) keyField.value = ''
      } else {
        if (feedback) feedback.textContent = 'Save failed.'
      }
    })

    row.querySelector<HTMLButtonElement>('.prov-clear')?.addEventListener('click', async () => {
      const ok = await save(name, { apiKey: null })
      if (ok) {
        if (feedback) feedback.textContent = 'Key cleared — restart to apply.'
        markRestartPending()
        if (keyField) keyField.value = ''
      }
    })

    row.querySelector<HTMLButtonElement>('.prov-test')?.addEventListener('click', async () => {
      if (feedback) feedback.textContent = 'Testing…'
      const pending = keyField?.value.trim()
      const result = await testKey(name, pending && pending.length > 0 ? pending : undefined)
      if (result.ok) {
        if (feedback) feedback.textContent = `✓ OK (${result.modelCount ?? 0} models, ${result.elapsedMs}ms)`
      } else {
        if (feedback) feedback.textContent = `✗ ${result.error ?? 'failed'} (${result.elapsedMs}ms)`
      }
    })
  })

  // Store warnings (permissive mode, schema version, etc.)
  if (list.storeWarnings.length > 0) {
    const warn = document.createElement('div')
    warn.className = 'text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1'
    warn.textContent = list.storeWarnings.join(' · ')
    container.appendChild(warn)
  }
}

// === Poll loop + lifecycle ===

let pollTimer: number | undefined

export const startProvidersPanel = async (): Promise<void> => {
  const refresh = async (): Promise<void> => {
    try {
      const res = await fetch('/api/providers')
      if (!res.ok) return
      const data = await res.json() as ProvidersResponse
      renderProvidersPanel(data)
    } catch { /* ignore transient fetch errors */ }
  }
  await refresh()
  if (pollTimer !== undefined) window.clearInterval(pollTimer)
  pollTimer = window.setInterval(() => { void refresh() }, 10_000)

  // Restart button wiring (idempotent — attaches only once)
  const btn = document.getElementById('providers-restart-btn')
  if (btn && !btn.dataset.wired) {
    btn.dataset.wired = '1'
    btn.addEventListener('click', async () => {
      if (!confirm('Restart samsinn? The UI will reconnect once the server is back.')) return
      try {
        await fetch('/api/system/shutdown', { method: 'POST' })
        showToast(document.body, 'Server shutting down — reconnecting…', { position: 'fixed' })
      } catch {
        showToast(document.body, 'Failed to signal shutdown', { position: 'fixed', type: 'error' })
      }
    })
  }
}

export const stopProvidersPanel = (): void => {
  if (pollTimer !== undefined) {
    window.clearInterval(pollTimer)
    pollTimer = undefined
  }
}
