// ============================================================================
// Row factory + status-dot helpers for the providers panel. Pure DOM — no
// event wiring; callers attach listeners after render.
// ============================================================================

export type Status = 'ok' | 'no_key' | 'cooldown' | 'down' | 'disabled'

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

const dotColourClass = (status: Status): string => {
  if (status === 'ok') return 'bg-success'
  if (status === 'cooldown') return 'bg-warning'
  if (status === 'down') return 'bg-danger'
  // disabled + no_key both render as gray; disabled gets the slash overlay.
  return 'bg-border-strong'
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
         <span class="block h-[2px] w-3.5 bg-danger rounded"></span>
       </span>`
    : ''
  return `<button class="prov-dot-btn relative w-4 h-4 flex items-center justify-center shrink-0 cursor-pointer" title="${statusTooltip(status)}">
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
    ${statusButton(entry.status)}
    ${nameCol}
    ${keyField}
    ${maxField}
    ${actionButtons}
    ${arrows}
  `
  return row
}
