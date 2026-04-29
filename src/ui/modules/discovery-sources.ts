// ============================================================================
// Discovery sources editor — small UI for managing the list of GitHub owners /
// repos that pack and wiki discovery scan. Stored at $SAMSINN_HOME/discovery-
// sources.json. Used inside both the Packs and Wikis panels via
// `renderSourcesEditor(container, 'packs' | 'wikis')`.
//
// Server-side validation is the source of truth (regex + length); the UI only
// strips obvious whitespace and trusts the round-trip response. Env-derived
// entries are shown read-only with a "from env" badge so users understand
// why they can't remove them here.
// ============================================================================

import { showToast } from './toast.ts'

interface DiscoverySources {
  packs: string[]
  wikis: string[]
  envPacks: string[]
  envWikis: string[]
}

type Domain = 'packs' | 'wikis'

const fetchSources = async (): Promise<DiscoverySources | null> => {
  try {
    const res = await fetch('/api/discovery-sources')
    if (!res.ok) return null
    return await res.json() as DiscoverySources
  } catch { return null }
}

const saveSources = async (
  domain: Domain,
  list: ReadonlyArray<string>,
): Promise<{ ok: true; data: DiscoverySources } | { ok: false; error: string }> => {
  try {
    const res = await fetch('/api/discovery-sources', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [domain]: list }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: 'save failed' })) as { error?: string }
      return { ok: false, error: body.error ?? `HTTP ${res.status}` }
    }
    return { ok: true, data: await res.json() as DiscoverySources }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

const placeholderFor = (domain: Domain): string =>
  domain === 'packs'
    ? 'e.g. samsinn-packs or my-org/samsinn-pack-foo'
    : 'e.g. samsinn-wikis or my-org/samsinn-wiki-foo'

const helpFor = (domain: Domain): string =>
  domain === 'packs'
    ? 'GitHub owners or owner/repo pairs to scan for installable packs.'
    : 'GitHub owners or owner/repo pairs to scan for available wikis.'

// Render the editor into `container`. Caller is responsible for (re-)rendering
// when `discovery_sources_changed` fires — the editor itself doesn't subscribe
// because it's mounted inside larger panels that already reload on mount.
export const renderSourcesEditor = async (
  container: HTMLElement,
  domain: Domain,
): Promise<void> => {
  const sources = await fetchSources()
  container.innerHTML = ''

  const wrap = document.createElement('div')
  wrap.className = 'border-t border-border'
  container.appendChild(wrap)

  const header = document.createElement('div')
  header.className = 'px-3 py-2 text-[11px] uppercase tracking-wide text-text-subtle bg-surface-muted flex items-center justify-between'
  header.innerHTML = `<span>Discovery sources</span><span class="text-[10px] normal-case tracking-normal text-text-muted">${escapeHtml(helpFor(domain))}</span>`
  wrap.appendChild(header)

  if (!sources) {
    const err = document.createElement('div')
    err.className = 'px-3 py-2 text-xs text-danger italic'
    err.textContent = 'Could not load discovery sources.'
    wrap.appendChild(err)
    return
  }

  const stored = domain === 'packs' ? sources.packs : sources.wikis
  const fromEnv = domain === 'packs' ? sources.envPacks : sources.envWikis

  // Env-derived entries first, read-only.
  for (const entry of fromEnv) {
    const row = document.createElement('div')
    row.className = 'px-3 py-2 text-xs flex items-center gap-2 border-b border-border bg-surface-muted/40'
    row.innerHTML = `
      <span class="font-mono text-text">${escapeHtml(entry)}</span>
      <span class="ml-auto text-[10px] uppercase tracking-wide text-text-subtle" title="From SAMSINN_${domain === 'packs' ? 'PACK' : 'WIKI'}_SOURCES env — edit your env to change">from env</span>
    `
    wrap.appendChild(row)
  }

  // Stored entries with remove buttons.
  for (const entry of stored) {
    const row = document.createElement('div')
    row.className = 'px-3 py-2 text-xs flex items-center gap-2 border-b border-border'
    row.innerHTML = `
      <span class="font-mono text-text flex-1 truncate">${escapeHtml(entry)}</span>
      <button class="ds-remove text-text-subtle hover:text-danger" title="Remove" aria-label="Remove">×</button>
    `
    row.querySelector<HTMLButtonElement>('.ds-remove')?.addEventListener('click', async () => {
      const next = stored.filter((s) => s !== entry)
      const result = await saveSources(domain, next)
      if (result.ok === false) {
        showToast(document.body, `Remove failed: ${result.error}`, { type: 'error', position: 'fixed' })
        return
      }
      await renderSourcesEditor(container, domain)
    })
    wrap.appendChild(row)
  }

  if (stored.length === 0 && fromEnv.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'px-3 py-2 text-xs text-text-muted italic'
    empty.textContent = 'No sources yet. Add a GitHub owner or owner/repo below.'
    wrap.appendChild(empty)
  }

  // Add row.
  const addRow = document.createElement('div')
  addRow.className = 'px-3 py-2 text-xs flex items-center gap-2 border-b border-border'
  addRow.innerHTML = `
    <input class="ds-input flex-1 px-2 py-1 text-xs font-mono bg-surface border border-border rounded" placeholder="${escapeHtml(placeholderFor(domain))}" />
    <button class="ds-add px-2 py-1 text-xs bg-accent text-white rounded hover:opacity-90">Add</button>
  `
  wrap.appendChild(addRow)

  const input = addRow.querySelector<HTMLInputElement>('.ds-input')!
  const btn = addRow.querySelector<HTMLButtonElement>('.ds-add')!
  const submit = async (): Promise<void> => {
    const value = input.value.trim()
    if (!value) return
    if (stored.includes(value)) {
      showToast(document.body, 'Already in the list', { position: 'fixed' })
      return
    }
    btn.disabled = true
    const next = [...stored, value]
    const result = await saveSources(domain, next)
    btn.disabled = false
    if (result.ok === false) {
      showToast(document.body, `Add failed: ${result.error}`, { type: 'error', position: 'fixed' })
      return
    }
    input.value = ''
    await renderSourcesEditor(container, domain)
  }
  btn.addEventListener('click', submit)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); void submit() }
  })
}
