// ============================================================================
// Settings → Scenarios modal — list bundled and pack-installed scenarios,
// one-click run, copy share-link, stop active run.
//
// Card-grid layout grouped by pack. Each card: title, description, op count,
// [Run] + [Copy share link] buttons. The active-run banner sits at the top
// when a scenario is mid-flight in this instance.
// ============================================================================

import { createModal } from './detail-modal.ts'
import { showToast } from '../toast.ts'
import { confirmRunWithConsent, type ScenarioConsentMeta } from '../scenario-consent.ts'
import { safeFetch } from '../fetch-helpers.ts'

type ScenarioCategory = 'demo' | 'tutorial' | 'onboarding'

interface CatalogScenario {
  readonly id: string
  readonly pack: string
  readonly name: string
  readonly title: string
  readonly description: string
  readonly category: ScenarioCategory
  readonly opCount: number
  readonly opKinds: ReadonlyArray<string>
}

interface ActiveRun {
  readonly runId: string
  readonly title: string
  readonly status: 'running' | 'awaiting' | 'completed' | 'failed' | 'stopped'
  readonly currentOpIndex: number
  readonly totalOps: number
}

const fetchCatalog = async (): Promise<CatalogScenario[]> => {
  try {
    const res = await fetch('/api/scenarios')
    if (!res.ok) return []
    const data = await res.json() as { scenarios: CatalogScenario[] }
    return data.scenarios
  } catch { return [] }
}

// Find an active (running or awaiting) run by walking the in-tab ownership
// list and asking the server for each runId. There's no server-side "list
// all active runs" endpoint in v1 (deferred); this fallback works because
// the panel only cares about runs the user actually started here.
const fetchActiveRun = async (): Promise<ActiveRun | null> => {
  let owned: string[] = []
  try {
    const raw = sessionStorage.getItem('samsinn:owned-scenario-runs') ?? ''
    owned = raw.split(',').filter(Boolean)
  } catch { return null }
  for (const runId of owned.reverse()) {   // newest first
    try {
      const res = await fetch(`/api/scenarios/runs/${encodeURIComponent(runId)}`)
      if (!res.ok) continue
      const r = await res.json() as ActiveRun
      if (r.status === 'running' || r.status === 'awaiting') return r
    } catch { /* try next */ }
  }
  return null
}

// Ordered display sections. Demos lead — they're the showcase. Tutorials
// next (guided, user-driven). Onboarding stays at the bottom because it
// reappears on first boot rather than being a thing users browse to.
const CATEGORY_ORDER: ReadonlyArray<{ key: ScenarioCategory; label: string }> = [
  { key: 'demo',       label: 'Demos' },
  { key: 'tutorial',   label: 'Tutorials' },
  { key: 'onboarding', label: 'Onboarding' },
]

const groupByCategory = (items: CatalogScenario[]): Map<ScenarioCategory, CatalogScenario[]> => {
  const out = new Map<ScenarioCategory, CatalogScenario[]>()
  for (const s of items) {
    const arr = out.get(s.category) ?? []
    arr.push(s)
    out.set(s.category, arr)
  }
  return out
}

const renderActiveRunBanner = (run: ActiveRun, onStopped: () => void): HTMLElement => {
  const wrap = document.createElement('div')
  wrap.className = 'mb-4 p-3 rounded border border-border bg-surface-muted flex items-center justify-between gap-3'
  const info = document.createElement('div')
  info.className = 'text-sm text-text'
  info.textContent = `Running: ${run.title} (${run.currentOpIndex + 1}/${run.totalOps})`
  const stop = document.createElement('button')
  stop.textContent = 'Stop'
  stop.className = 'px-3 py-1 text-xs rounded bg-danger text-white hover:bg-danger-hover disabled:opacity-50'
  stop.addEventListener('click', async () => {
    stop.disabled = true
    const res = await safeFetch(`/api/scenarios/runs/${encodeURIComponent(run.runId)}/stop`, { method: 'POST' })
    if (!res || !res.ok) {
      showToast(document.body, 'Could not stop scenario', { type: 'error', position: 'fixed' })
      stop.disabled = false
      return
    }
    onStopped()
  })
  wrap.appendChild(info)
  wrap.appendChild(stop)
  return wrap
}

const renderCard = (
  scenario: CatalogScenario,
  hasActive: boolean,
  onStarted: () => void,
): HTMLElement => {
  const card = document.createElement('div')
  card.className = 'p-3 rounded border border-border bg-surface-strong flex flex-col gap-2'

  const title = document.createElement('div')
  title.className = 'text-sm font-semibold text-text'
  title.textContent = scenario.title
  card.appendChild(title)

  if (scenario.description) {
    const desc = document.createElement('div')
    desc.className = 'text-xs text-text-subtle'
    desc.textContent = scenario.description
    card.appendChild(desc)
  }

  const meta = document.createElement('div')
  meta.className = 'text-xs text-text-subtle'
  meta.textContent = `${scenario.opCount} ops · ${scenario.id}`
  card.appendChild(meta)

  const btnRow = document.createElement('div')
  btnRow.className = 'flex gap-2 mt-1'

  const runBtn = document.createElement('button')
  runBtn.textContent = hasActive ? 'Stop the running scenario first' : 'Run'
  runBtn.disabled = hasActive
  runBtn.className = 'px-3 py-1 text-xs rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed'
  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true
    const meta: ScenarioConsentMeta = {
      id: scenario.id,
      pack: scenario.pack,
      name: scenario.name,
      title: scenario.title,
      description: scenario.description,
      opKinds: scenario.opKinds,
    }
    const runId = await confirmRunWithConsent(meta)
    if (runId) onStarted()
    else runBtn.disabled = hasActive   // restore if user cancelled
  })

  const copyBtn = document.createElement('button')
  copyBtn.textContent = 'Copy share link'
  copyBtn.className = 'px-3 py-1 text-xs rounded bg-surface-muted text-text-subtle hover:bg-surface'
  copyBtn.addEventListener('click', async () => {
    const url = `${window.location.origin}/?scenario=${encodeURIComponent(scenario.id)}`
    try {
      await navigator.clipboard.writeText(url)
      showToast(document.body, 'Share link copied', { type: 'success', position: 'fixed' })
    } catch {
      showToast(document.body, `Copy failed. Link: ${url}`, { type: 'error', position: 'fixed', durationMs: 10000 })
    }
  })

  btnRow.appendChild(runBtn)
  btnRow.appendChild(copyBtn)
  card.appendChild(btnRow)
  return card
}

export const openScenariosListModal = async (): Promise<void> => {
  const modal = createModal({ title: 'Scenarios', width: 'max-w-3xl' })
  document.body.appendChild(modal.overlay)

  // The body is re-rendered on demand whenever the catalog or active-run
  // state changes. Re-render is cheap (~20 cards max in v1), and reusing the
  // same root element keeps the modal scrolling position stable across
  // re-renders triggered by start/stop actions.
  const root = document.createElement('div')
  root.className = 'p-4 overflow-y-auto'
  modal.scrollBody.appendChild(root)

  const render = async (): Promise<void> => {
    const [catalog, active] = await Promise.all([fetchCatalog(), fetchActiveRun()])
    root.innerHTML = ''

    if (active) {
      root.appendChild(renderActiveRunBanner(active, () => { void render() }))
    }

    if (catalog.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'text-sm text-text-subtle p-4'
      empty.textContent = 'No scenarios installed. Bundled demos should appear here — if they don\'t, check the server logs.'
      root.appendChild(empty)
      return
    }

    const groups = groupByCategory(catalog)
    for (const { key, label } of CATEGORY_ORDER) {
      const entries = groups.get(key)
      if (!entries || entries.length === 0) continue

      const header = document.createElement('div')
      header.className = 'text-xs uppercase tracking-wide text-text-subtle mt-3 mb-2 first:mt-0'
      header.textContent = label
      root.appendChild(header)

      const grid = document.createElement('div')
      grid.className = 'grid grid-cols-1 md:grid-cols-2 gap-2'
      // Stable ordering within a category: by title.
      const sorted = [...entries].sort((a, b) => a.title.localeCompare(b.title))
      for (const scenario of sorted) {
        grid.appendChild(renderCard(scenario, !!active, () => { void render() }))
      }
      root.appendChild(grid)
    }
  }

  await render()
}
