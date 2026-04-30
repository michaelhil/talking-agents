// ============================================================================
// Row factory + status-dot helpers for the providers panel. Pure DOM — no
// event wiring; callers attach listeners after render.
// ============================================================================

export type Status = 'ok' | 'no_key' | 'cooldown' | 'down' | 'disabled'

export interface MonitorPayload {
  sub: 'ok' | 'backoff' | 'unhealthy' | 'no_key' | 'disabled' | 'down'
  reason: string
  retryAt: number | null
  modelCount: number
  consecutiveFailures: number
  lastError: { code: string; message: string } | null
  lastErrorAt: number | null
}

export interface FailureRecord {
  when: number
  provider: string
  model: string | null
  agentId: string | null
  code: string
  reason: string
}

export interface ProviderStatusEntry {
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
  monitor: MonitorPayload | null
  recentFailures: ReadonlyArray<FailureRecord>
}

// Where to send users to get an API key. Top-level consoles are more stable
// than deep-link API-keys pages. Maintained inline here — edit when dashboards
// move.
//
// The record's key type is `CloudProviderName | 'ollama'`, so adding a new
// provider to PROVIDER_PROFILES (which narrows CloudProviderName) forces a
// matching entry here — TypeScript refuses to build otherwise. Prevents
// forgotten URL updates without crossing server-side LLM config into UI
// concerns.
import type { CloudProviderName } from '../../../llm/providers-config.ts'
const PROVIDER_URLS: Record<CloudProviderName | 'ollama', string> = {
  anthropic:  'https://console.anthropic.com',
  gemini:     'https://aistudio.google.com',
  cerebras:   'https://cloud.cerebras.ai',
  groq:       'https://console.groq.com',
  openrouter: 'https://openrouter.ai',
  mistral:    'https://console.mistral.ai',
  sambanova:  'https://cloud.sambanova.ai',
  ollama:     'https://ollama.com',
}

const dotColourClass = (status: Status): string => {
  if (status === 'ok') return 'bg-success'
  if (status === 'cooldown') return 'bg-warning'
  if (status === 'down') return 'bg-danger'
  // disabled + no_key both render as gray; disabled gets the slash overlay.
  return 'bg-border-strong'
}

const statusTooltip = (status: Status, monitor: MonitorPayload | null): string => {
  // When the monitor reports rich state, prefer it — surface the actual
  // reason and (for backoff) a live countdown to recovery. Falls back to
  // the bare status word for older payloads or unknown providers.
  if (monitor) {
    if (monitor.sub === 'backoff' && monitor.retryAt !== null) {
      const remainingS = Math.max(0, Math.round((monitor.retryAt - Date.now()) / 1000))
      const reason = monitor.reason || 'cooldown'
      return `${reason} — retries allowed in ${remainingS}s · click to disable`
    }
    if (monitor.sub === 'unhealthy') {
      const last = monitor.lastError?.message ? ` (${monitor.lastError.message.slice(0, 80)})` : ''
      return `unhealthy — ${monitor.consecutiveFailures} recent failures${last} · click to disable`
    }
    if (monitor.sub === 'down') return 'down — click to disable'
    if (monitor.sub === 'disabled') return 'disabled — click to enable'
    if (monitor.sub === 'no_key') return 'no key — paste one to enable'
    if (monitor.sub === 'ok') return `ok — ${monitor.modelCount} models · click to disable`
  }
  if (status === 'ok') return 'ok — click to disable'
  if (status === 'cooldown') return 'cooldown — click to disable'
  if (status === 'down') return 'down — click to disable'
  if (status === 'disabled') return 'disabled — click to enable'
  return 'no key'
}

// Returns the `<button>` that holds the status dot + optional red slash.
// The outer button is a larger click target (16×16) for comfort.
const statusButton = (status: Status, monitor: MonitorPayload | null): string => {
  const dot = `<span class="inline-block w-2.5 h-2.5 rounded-full ${dotColourClass(status)}"></span>`
  const slash = status === 'disabled'
    ? `<span class="absolute inset-0 flex items-center justify-center pointer-events-none"
             aria-hidden="true"
             style="transform: rotate(-45deg)">
         <span class="block h-[2px] w-3.5 bg-danger rounded"></span>
       </span>`
    : ''
  // Tooltip is escaped against quote-injection via the attribute encoder.
  const tip = statusTooltip(status, monitor)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<button class="prov-dot-btn relative w-4 h-4 flex items-center justify-center shrink-0 cursor-pointer" title="${tip}">
    ${dot}
    ${slash}
  </button>`
}

export interface RowContext {
  readonly entry: ProviderStatusEntry
  readonly position: { readonly isFirst: boolean; readonly isLast: boolean }
  readonly orderLocked: boolean
}

export const renderRow = (ctx: RowContext): HTMLElement => {
  const { entry, position, orderLocked } = ctx
  const row = document.createElement('div')
  row.className = 'border rounded px-2 py-1 bg-surface-muted flex items-center gap-2'
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
         class="font-medium text-text-strong hover:text-accent-hover hover:underline truncate"
         title="Open ${entry.name} dashboard in a new tab">${entry.name}</a>
      <button class="prov-models-btn text-text-muted hover:text-text shrink-0"
              title="Show available models">≡</button>
    </div>
  `

  // Key field (cloud only). type=text so the stub is selectable and
  // editable; value = current stub (empty when no key). Tab-out / blur
  // triggers save. Fixed width so columns align.
  //
  // For Ollama: no key; the same slot is used for the Settings button that
  // toggles the expanded settings panel below the row. Width matches so
  // columns across rows stay aligned.
  const keyField = isCloud ? `
    <input id="${keyFieldId}" type="text"
           value="${entry.keyMask ?? ''}"
           data-original="${entry.keyMask ?? ''}"
           placeholder="paste key"
           class="w-24 shrink-0 px-2 py-0.5 border rounded font-mono text-[11px]"
           ${locked ? 'disabled title="Key comes from environment variable"' : ''}>
  ` : `
    <button class="ollama-settings-btn w-24 shrink-0 text-[11px] px-2 py-0.5 bg-border hover:bg-border-strong text-text rounded">⚙ Settings</button>
  `

  const maxField = `
    <label class="text-text-subtle flex items-center gap-0.5 shrink-0">max
      <input id="${mcFieldId}" type="number" min="1" max="100"
             value="${entry.maxConcurrent ?? ''}"
             data-original="${entry.maxConcurrent ?? ''}"
             class="w-9 px-1 py-0.5 border rounded">
    </label>
  `

  // Test button — cloud providers test their key; Ollama pings its URL.
  const actionButtons = `
    <button class="prov-test text-[11px] px-2 py-0.5 bg-success hover:bg-success-hover text-white rounded shrink-0">Test</button>
  `

  const arrows = `
    <div class="flex items-center gap-1.5 shrink-0 ml-auto">
      <button class="prov-up text-text-muted hover:text-text disabled:opacity-20 disabled:cursor-not-allowed"
              ${position.isFirst || orderLocked ? 'disabled' : ''} title="Move up">▲</button>
      <button class="prov-down text-text-muted hover:text-text disabled:opacity-20 disabled:cursor-not-allowed"
              ${position.isLast || orderLocked ? 'disabled' : ''} title="Move down">▼</button>
    </div>
  `

  row.innerHTML = `
    ${statusButton(entry.status, entry.monitor)}
    ${nameCol}
    ${keyField}
    ${maxField}
    ${actionButtons}
    ${arrows}
  `
  return row
}

// Renders a small failures section under a provider row when the provider
// has any persisted failures. Collapsed by default; click the header to
// toggle. Shown inline with the provider so the user doesn't need to
// hunt for which provider caused which message.
export const renderFailuresSection = (entry: ProviderStatusEntry): HTMLElement | null => {
  const failures = entry.recentFailures
  if (!failures || failures.length === 0) return null
  const wrap = document.createElement('div')
  wrap.className = 'pl-6 pr-2 pb-1 text-[11px]'
  wrap.dataset.failuresFor = entry.name
  const head = document.createElement('button')
  head.className = 'text-text-muted hover:text-text underline-offset-2 hover:underline'
  head.textContent = `▸ Recent failures (${failures.length})`
  const body = document.createElement('div')
  body.className = 'hidden mt-1 border-l-2 border-border pl-2 space-y-0.5 max-h-48 overflow-y-auto'
  for (const f of failures) {
    const row = document.createElement('div')
    row.className = 'text-text-subtle'
    const when = new Date(f.when).toLocaleTimeString()
    const model = f.model ? ` · ${f.model}` : ''
    const reason = (f.reason || f.code).replace(/</g, '&lt;')
    row.innerHTML = `<span class="text-text-muted">${when}</span> <span class="text-warning">[${f.code}]</span>${model} — ${reason}`
    body.appendChild(row)
  }
  head.addEventListener('click', () => {
    const open = !body.classList.contains('hidden')
    body.classList.toggle('hidden', open)
    head.textContent = `${open ? '▸' : '▾'} Recent failures (${failures.length})`
  })
  wrap.appendChild(head)
  wrap.appendChild(body)
  return wrap
}
