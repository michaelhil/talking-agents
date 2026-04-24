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

const statusLabel = (status: ModelCatalogProvider['status']): string => {
  if (status === 'ok') return ''
  if (status === 'no_key') return ' (no key)'
  if (status === 'cooldown') return ' (cooldown)'
  return ' (down)'
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
      if (prov.status === 'cooldown' || prov.status === 'down') opt.classList.add('text-text-muted')
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
