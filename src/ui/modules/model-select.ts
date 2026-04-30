// Model dropdown builder. Fetches /api/models, renders a <select> grouped
// by provider with status tags. The show-all toggle is persisted in
// localStorage so the UI remembers the user's last filter.

interface ModelCatalogModel {
  id: string
  contextMax: number
  recommended: boolean
  pinned?: boolean
  running?: boolean
  label?: string
}

interface ModelCatalogProvider {
  name: string
  status: 'ok' | 'no_key' | 'cooldown' | 'down'
  // Optional richer fields from the monitor — present on newer servers.
  reason?: string
  retryAt?: number | null
  models: ModelCatalogModel[]
}

interface ModelCatalogResponse {
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

// Brief inline tag shown next to the optgroup label. Falls back to the
// status word; uses the monitor's reason when available so a rate-limited
// provider says e.g. "rate-limited (retry in 47s)" instead of "cooldown".
const statusLabel = (provider: ModelCatalogProvider): string => {
  if (provider.status === 'ok') return ''
  if (provider.status === 'no_key') return ' (no API key)'
  if (provider.status === 'cooldown') {
    if (provider.retryAt !== null && provider.retryAt !== undefined) {
      const remaining = Math.max(0, Math.round((provider.retryAt - Date.now()) / 1000))
      return ` (cooldown — ${remaining}s)`
    }
    return ' (cooldown)'
  }
  return ' (down)'
}

// User-facing remediation hint as a per-option tooltip. Same source of
// truth as the toast remediation strings but UI-local because the dropdown
// fetches from /api/models, not /api/providers.
const remediationHint = (status: ModelCatalogProvider['status'], providerName: string): string => {
  if (status === 'no_key') return `Add an API key for ${providerName} in the Providers panel`
  if (status === 'cooldown') return `${providerName} is rate-limited — wait for the cooldown to expire or pick a model on a different provider`
  if (status === 'down') return `${providerName} is unavailable — try again or switch providers`
  return ''
}

const fetchModelCatalog = async (): Promise<ModelCatalogResponse> => {
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

  if (data.providers.length === 0) {
    select.innerHTML = '<option value="">No providers configured</option>'
    return ''
  }

  // Two-bucket render: routable providers (ok/cooldown) first, structurally
  // unavailable ones (no_key/down) at the bottom. Unavailable groups render
  // with an actionable label so the user sees *why* they can't pick a
  // particular model — and how to fix it — rather than the model just
  // being missing from the list.
  //
  // Both buckets are populated; only ok/cooldown options are routable and
  // get added to the eligible-for-selection set. no_key/down options are
  // shown but disabled, with a tooltip explaining the remediation step.
  const routable: string[] = []
  const orderedProviders = [
    ...data.providers.filter(p => p.status === 'ok' || p.status === 'cooldown'),
    ...data.providers.filter(p => p.status === 'no_key' || p.status === 'down'),
  ]
  for (const prov of orderedProviders) {
    const models = showAll ? prov.models : prov.models.filter(m => m.recommended)
    if (models.length === 0) continue
    const group = document.createElement('optgroup')
    group.label = `${prov.name}${statusLabel(prov)}`
    const tooltip = remediationHint(prov.status, prov.name)
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
      if (tooltip) opt.title = tooltip
      if (prov.status === 'cooldown' || prov.status === 'down') opt.classList.add('text-text-muted')
      if (prov.status === 'no_key' || prov.status === 'down') {
        // Disable so the user can't pick a model that has no chance of
        // routing right now. cooldown stays selectable — it'll recover.
        opt.disabled = true
        opt.classList.add('text-text-muted', 'opacity-60')
      } else {
        routable.push(full)
      }
      group.appendChild(opt)
    }
    select.appendChild(group)
  }

  if (routable.length === 0) {
    // Everything was unavailable. Keep groups visible (so user sees why)
    // but prepend a clear placeholder.
    const placeholder = document.createElement('option')
    placeholder.value = ''
    placeholder.textContent = 'No routable models — add an API key in the Providers panel'
    placeholder.disabled = true
    placeholder.selected = true
    select.insertBefore(placeholder, select.firstChild)
    return ''
  }

  const chosen = (options.preferredModel && routable.includes(options.preferredModel))
    ? options.preferredModel
    : (data.defaultModel && routable.includes(data.defaultModel) ? data.defaultModel : routable[0]!)
  select.value = chosen

  // If the preferred model wasn't in the list (e.g. a legacy Ollama model), add
  // it at the top as "(not available)" so the user can still see the current
  // value.
  if (options.preferredModel && !routable.includes(options.preferredModel)) {
    const opt = document.createElement('option')
    opt.value = options.preferredModel
    opt.textContent = `${options.preferredModel} (not available)`
    opt.selected = true
    select.insertBefore(opt, select.firstChild)
    return options.preferredModel
  }

  return chosen
}
