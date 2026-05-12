// ============================================================================
// Shared "confirm + run scenario" helper.
//
// Used by all three entry points (share-link, settings panel, empty-state
// strip). Centralises:
//   - Pack-install consent gating (when meta.opKinds includes 'install-pack',
//     surface a checkbox; otherwise short-circuit straight to run).
//   - The POST /api/scenarios/:pack/:name/run round-trip.
//   - Run-ownership claim (so this tab's overlay renders, not other tabs').
//   - Failure toasts.
//
// Returns the runId on success, null otherwise. Caller decides what to do
// next (the share-link strips the URL param, the panel re-renders the
// catalog with a Stop button, the strip just disappears).
// ============================================================================

import { showToast } from './toast.ts'
import { claimRunOwnership } from './scenario-overlay.ts'

export interface ScenarioConsentMeta {
  readonly id: string
  readonly pack: string
  readonly name: string
  readonly title: string
  readonly description: string
  readonly opKinds: ReadonlyArray<string>
  // Optional — only the share-link entry point provides narration (it pre-
  // fetches the full source). The panel + strip pass undefined and the
  // helper renders without it.
  readonly narration?: string
  // For "this scenario will install a pack" the helper surfaces a confirm
  // dialog. Defaults true; false skips even the install-consent dialog
  // (used by the boot welcome path which auto-runs).
  readonly requireConsent?: boolean
}

const containsInstallOp = (meta: ScenarioConsentMeta): boolean =>
  meta.opKinds.includes('install-pack')

interface ModelEntry {
  readonly id: string
  readonly label?: string
  readonly recommended?: boolean
}

interface ModelCatalog {
  readonly defaultModel: string
  readonly options: ReadonlyArray<{ provider: string; model: ModelEntry }>
}

// Fetch /api/models and flatten into a "provider — model" option list,
// recommended/curated entries first. Returns an empty catalog on fetch
// failure; the dialog handles the empty case by hiding the dropdown.
const fetchModelCatalog = async (): Promise<ModelCatalog> => {
  try {
    const res = await fetch('/api/models')
    if (!res.ok) return { defaultModel: '', options: [] }
    const data = await res.json() as {
      defaultModel: string
      providers: ReadonlyArray<{
        name: string
        status: string
        models: ReadonlyArray<ModelEntry>
      }>
    }
    const options: { provider: string; model: ModelEntry }[] = []
    // Recommended/curated models from every ok provider first.
    for (const p of data.providers) {
      if (p.status !== 'ok') continue
      for (const m of p.models) {
        if (!m.recommended) continue
        options.push({ provider: p.name, model: m })
      }
    }
    // Then everything else (non-recommended). Lets the user pick obscure
    // models without sifting through full provider lists for the common
    // case.
    for (const p of data.providers) {
      if (p.status !== 'ok') continue
      for (const m of p.models) {
        if (m.recommended) continue
        options.push({ provider: p.name, model: m })
      }
    }
    return { defaultModel: data.defaultModel ?? '', options }
  } catch {
    return { defaultModel: '', options: [] }
  }
}

const startRun = async (
  meta: ScenarioConsentMeta,
  allowInstall: boolean,
  currentRoom: string | undefined,
  model: string | undefined,
): Promise<string | null> => {
  try {
    const body: Record<string, unknown> = { allowInstall }
    if (currentRoom) body.currentRoom = currentRoom
    if (model) body.model = model
    const res = await fetch(
      `/api/scenarios/${encodeURIComponent(meta.pack)}/${encodeURIComponent(meta.name)}/run`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    )
    if (!res.ok) {
      const reason = await res.text().catch(() => '')
      showToast(document.body, `Could not start scenario: ${reason || res.statusText}`, {
        type: 'error', position: 'fixed', durationMs: 10000,
      })
      return null
    }
    const data = await res.json() as { runId?: string }
    if (typeof data.runId === 'string') {
      claimRunOwnership(data.runId)
      return data.runId
    }
    return null
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    showToast(document.body, `Network error starting scenario: ${reason}`, {
      type: 'error', position: 'fixed', durationMs: 10000,
    })
    return null
  }
}

// Show the consent dialog (or short-circuit) and return the runId on success.
// `currentRoom`: the name of the room the user has open at run-start. Sent
// to the server so scenarios that target __CURRENT_ROOM__ inject into the
// active room rather than spawning a fresh one. Undefined for share-link
// visitors and other entry points without an active room — the server
// falls back to the first existing room (see ops.ts).
export const confirmRunWithConsent = async (
  meta: ScenarioConsentMeta,
  currentRoom?: string,
): Promise<string | null> => {
  // Short-circuit: requireConsent: false bypasses the dialog entirely.
  if (meta.requireConsent === false) {
    return startRun(meta, containsInstallOp(meta), currentRoom, undefined)
  }

  // Fetch model catalog up-front so the dialog can render a populated
  // dropdown. If /api/models fails, fall back to "use default" — the
  // server-side resolver will pick the curated default at run-time.
  const modelCatalog = await fetchModelCatalog()

  return new Promise<string | null>((resolve) => {
    const backdrop = document.createElement('div')
    // Use the same --shadow-overlay token the project's other modals use
    // (light: 40% black, dark: 60% black). bg-black/40 was a fixed value
    // that didn't theme-flip and looked thin against the dark theme.
    backdrop.className = 'fixed inset-0 z-[1100] flex items-center justify-center'
    backdrop.style.background = 'var(--shadow-overlay)'
    backdrop.setAttribute('data-scenario-consent', '')

    const card = document.createElement('div')
    card.className = 'bg-surface-strong border border-border rounded shadow-lg p-4 max-w-lg w-full text-sm'

    const eyebrow = document.createElement('div')
    eyebrow.className = 'text-xs text-text-subtle mb-1'
    eyebrow.textContent = `Scenario from pack: ${meta.pack}`
    card.appendChild(eyebrow)

    const h = document.createElement('h2')
    h.className = 'text-base font-semibold mb-1'
    h.textContent = meta.title
    card.appendChild(h)

    if (meta.description) {
      const d = document.createElement('div')
      d.className = 'text-text-subtle mb-3'
      d.textContent = meta.description
      card.appendChild(d)
    }

    if (meta.narration) {
      const narr = document.createElement('div')
      narr.className = 'text-text whitespace-pre-wrap mb-3 max-h-64 overflow-y-auto border border-border rounded p-2 bg-surface-muted'
      narr.textContent = meta.narration
      card.appendChild(narr)
    }

    // Model picker — only rendered when the catalog has options. Empty
    // catalog (network failure, no providers configured) means the dialog
    // skips the picker and the server resolves the default at run-time.
    let chosenModel: string | undefined = modelCatalog.defaultModel || undefined
    if (modelCatalog.options.length > 0) {
      const wrap = document.createElement('label')
      wrap.className = 'flex flex-col gap-1 mb-3 text-xs text-text'
      const lab = document.createElement('span')
      lab.className = 'text-text-subtle'
      lab.textContent = 'Model'
      const sel = document.createElement('select')
      sel.className = 'rounded border border-border bg-surface px-2 py-1 text-text'
      for (const { provider, model } of modelCatalog.options) {
        const opt = document.createElement('option')
        opt.value = model.id
        opt.textContent = `${provider} · ${model.label ?? model.id}`
        if (model.id === modelCatalog.defaultModel) opt.selected = true
        sel.appendChild(opt)
      }
      sel.addEventListener('change', () => { chosenModel = sel.value })
      wrap.appendChild(lab)
      wrap.appendChild(sel)
      card.appendChild(wrap)
    }

    let allowInstall = false
    const hasInstall = containsInstallOp(meta)
    if (hasInstall) {
      const wrap = document.createElement('label')
      wrap.className = 'flex items-start gap-2 mb-3 text-xs text-text'
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.className = 'mt-0.5'
      cb.addEventListener('change', () => { allowInstall = cb.checked })
      const label = document.createElement('span')
      label.textContent = 'This scenario contains install-pack operations. Check to allow it to install packs from remote git sources.'
      wrap.appendChild(cb)
      wrap.appendChild(label)
      card.appendChild(wrap)
    }

    const btnRow = document.createElement('div')
    btnRow.className = 'flex gap-2 justify-end'

    const cancel = document.createElement('button')
    cancel.textContent = 'Cancel'
    cancel.className = 'px-3 py-1 text-xs rounded bg-surface-muted text-text-subtle hover:bg-surface'
    cancel.addEventListener('click', () => {
      backdrop.remove()
      resolve(null)
    })

    const run = document.createElement('button')
    run.textContent = 'Run scenario'
    run.className = 'px-3 py-1 text-xs rounded bg-accent text-white hover:bg-accent-hover'
    run.addEventListener('click', async () => {
      if (hasInstall && !allowInstall) {
        showToast(document.body, 'Tick the install-pack consent box first, or cancel.', { type: 'error', position: 'fixed' })
        return
      }
      backdrop.remove()
      const runId = await startRun(meta, allowInstall, currentRoom, chosenModel)
      resolve(runId)
    })

    btnRow.appendChild(cancel)
    btnRow.appendChild(run)
    card.appendChild(btnRow)
    backdrop.appendChild(card)
    document.body.appendChild(backdrop)
  })
}
