// ============================================================================
// Geodata panel — categories list, search, per-category & per-feature delete.
//
// Categories are user-defined via the paste-import flow (geodata-import-modal).
// Empty registry on first install → empty-state with prominent Import CTA.
//
// Read-only first pass for category metadata (display only, no edit).
// Edit/promote-to-verified come in a follow-up milestone.
// ============================================================================

import { showToast } from '../toast.ts'
import { renderMapSource } from '../map/index.ts'
import { openGeodataImportModal } from '../modals/geodata-import-modal.ts'
import type { MarkerIcon } from '../map/normalise.ts'

interface CategoryRow {
  readonly id: string
  readonly displayName: string
  readonly icon: MarkerIcon
  readonly osmQuery: string | null
  readonly total: number
  readonly verified: number
  readonly unverified: number
}

interface OverviewResp { readonly categories: ReadonlyArray<CategoryRow> }

interface GeoFeature {
  readonly type: 'Feature'
  readonly geometry: { readonly type: 'Point'; readonly coordinates: readonly [number, number] }
  readonly properties: {
    readonly id: string
    readonly name: string
    readonly category: string
    readonly verified: boolean
    readonly source: string
    readonly aliases?: ReadonlyArray<string>
    readonly country?: string
    readonly operator?: string
    readonly icao?: string
    readonly iata?: string
  }
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c))

const fetchOverview = async (): Promise<OverviewResp> => {
  const res = await fetch('/api/geodata')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json() as OverviewResp
}

const fetchCategoryFeatures = async (id: string): Promise<ReadonlyArray<GeoFeature>> => {
  const res = await fetch(`/api/geodata/${encodeURIComponent(id)}`)
  if (!res.ok) return []
  const data = await res.json() as { features?: ReadonlyArray<GeoFeature> }
  return data.features ?? []
}

const deleteFeature = async (categoryId: string, source: string, id: string): Promise<boolean> => {
  const res = await fetch(`/api/geodata/${encodeURIComponent(categoryId)}/${encodeURIComponent(source)}/${encodeURIComponent(id)}`, { method: 'DELETE' })
  return res.ok
}

const deleteCategoryRequest = async (id: string): Promise<boolean> => {
  const res = await fetch(`/api/geodata/categories/${encodeURIComponent(id)}`, { method: 'DELETE' })
  return res.ok
}

const search = async (q: string, c: string): Promise<{ source: string; features: ReadonlyArray<GeoFeature> } | null> => {
  const url = `/api/geodata/search?q=${encodeURIComponent(q)}&category=${encodeURIComponent(c)}`
  const res = await fetch(url)
  if (!res.ok) return null
  const data = await res.json() as { result?: { source: string; features: ReadonlyArray<GeoFeature> } }
  return data.result ?? null
}

// ============================================================================
// Renderers
// ============================================================================

const renderEmptyState = (container: HTMLElement, refresh: () => void): void => {
  container.innerHTML = `
    <div class="px-6 py-10 text-center">
      <div class="text-sm text-text-muted mb-4">No categories yet.</div>
      <p class="text-xs text-text-muted mb-6 max-w-md mx-auto leading-relaxed">
        Categories are user-defined. Import a category by pasting JSON produced by an AI agent — copy the prompt template, fill in your task ("all wind farms in the North Sea"), and paste the response back.
      </p>
      <button class="empty-import-btn px-4 py-2 rounded bg-blue-600 hover:bg-blue-700 text-white text-xs">Open Import…</button>
    </div>`
  container.querySelector<HTMLButtonElement>('.empty-import-btn')!.onclick = (): void => {
    void openGeodataImportModal(refresh)
  }
}

const renderOverview = async (container: HTMLElement): Promise<void> => {
  container.innerHTML = '<div class="px-6 py-4 text-text-muted text-xs">Loading…</div>'
  let resp: OverviewResp
  try { resp = await fetchOverview() }
  catch (err) {
    container.innerHTML = `<div class="px-6 py-4 text-red-400 text-xs">Failed: ${escapeHtml(String(err))}</div>`
    return
  }

  if (resp.categories.length === 0) {
    renderEmptyState(container, () => { void renderOverview(container) })
    return
  }

  const sections: string[] = []
  sections.push('<table class="w-full text-xs"><thead><tr class="text-left text-text-muted border-b border-border"><th class="px-6 py-2">Category</th><th class="px-3 py-2">Icon</th><th class="px-3 py-2 text-right">Total</th><th class="px-3 py-2 text-right">Verified</th><th class="px-3 py-2 text-right">Unverified</th><th class="px-3 py-2 text-right"></th></tr></thead><tbody>')
  for (const row of resp.categories) {
    const overpassTag = row.osmQuery ? '<span class="ml-2 text-[10px] text-text-muted">[osm]</span>' : ''
    sections.push(`
      <tr class="border-b border-border/50 hover:bg-surface-muted/40">
        <td class="px-6 py-2"><span class="font-mono">${escapeHtml(row.id)}</span> <span class="text-text-muted">${escapeHtml(row.displayName)}</span>${overpassTag}</td>
        <td class="px-3 py-2 text-text-muted text-[11px]">${escapeHtml(row.icon)}</td>
        <td class="px-3 py-2 text-right">${row.total}</td>
        <td class="px-3 py-2 text-right">${row.verified}</td>
        <td class="px-3 py-2 text-right">${row.unverified}</td>
        <td class="px-3 py-2 text-right whitespace-nowrap">
          <button data-cat="${escapeHtml(row.id)}" class="cat-list-btn text-blue-400 hover:underline">view</button>
          <button data-cat="${escapeHtml(row.id)}" class="cat-del-btn ml-3 text-red-400 hover:underline">delete</button>
        </td>
      </tr>`)
  }
  sections.push('</tbody></table>')
  container.innerHTML = sections.join('')

  container.querySelectorAll<HTMLButtonElement>('button.cat-list-btn').forEach((btn) => {
    btn.onclick = (): void => { void renderCategoryList(container, btn.dataset.cat!) }
  })
  container.querySelectorAll<HTMLButtonElement>('button.cat-del-btn').forEach((btn) => {
    btn.onclick = async (): Promise<void> => {
      const id = btn.dataset.cat!
      if (!confirm(`Delete category "${id}" and all its features? This cannot be undone.`)) return
      const ok = await deleteCategoryRequest(id)
      if (ok) {
        showToast(document.body, `Deleted ${id}`, { type: 'success', position: 'fixed' })
        await renderOverview(container)
      } else {
        showToast(document.body, 'Delete failed', { type: 'error', position: 'fixed' })
      }
    }
  })
}

const renderCategoryList = async (container: HTMLElement, categoryId: string): Promise<void> => {
  container.innerHTML = `<div class="px-6 py-3 border-b border-border flex items-center justify-between">
    <button class="back-btn text-xs text-blue-400 hover:underline">← Back</button>
    <span class="text-xs text-text-muted font-mono">${escapeHtml(categoryId)}</span>
  </div><div class="loading px-6 py-4 text-text-muted text-xs">Loading…</div>`
  container.querySelector<HTMLButtonElement>('.back-btn')!.onclick = (): void => { void renderOverview(container) }
  const features = await fetchCategoryFeatures(categoryId)
  const loadingEl = container.querySelector<HTMLDivElement>('.loading')
  if (!loadingEl) return

  if (features.length === 0) {
    loadingEl.innerHTML = '<div class="text-text-muted">No features in this category.</div>'
    return
  }

  const rows = features.map((f) => {
    const p = f.properties
    const [lng, lat] = f.geometry.coordinates
    const aliases = p.aliases?.length ? ` <span class="text-text-muted">(${escapeHtml(p.aliases.join(', '))})</span>` : ''
    const meta = [p.country, p.operator, p.icao, p.iata].filter(Boolean).join(' · ')
    const verifiedTag = p.verified
      ? '<span class="ml-2 px-1 py-0.5 rounded bg-green-900/30 text-green-300 text-[10px]">verified</span>'
      : '<span class="ml-2 px-1 py-0.5 rounded bg-yellow-900/30 text-yellow-300 text-[10px]">unverified</span>'
    const sourceTag = `<span class="ml-1 px-1 py-0.5 rounded bg-surface-muted text-text-muted text-[10px]">${escapeHtml(p.source)}</span>`
    const deleteBtn = (!p.verified && p.source === 'local')
      ? `<button data-id="${escapeHtml(p.id)}" data-source="${escapeHtml(p.source)}" class="del-btn text-xs text-red-400 hover:underline">delete</button>`
      : '<span class="text-xs text-text-muted">—</span>'
    return `
      <tr class="border-b border-border/50 hover:bg-surface-muted/40">
        <td class="px-6 py-2">${escapeHtml(p.name)}${aliases}${verifiedTag}${sourceTag}</td>
        <td class="px-3 py-2 text-text-muted text-[11px]">${escapeHtml(meta)}</td>
        <td class="px-3 py-2 text-right font-mono text-[11px]">${lat.toFixed(4)}, ${lng.toFixed(4)}</td>
        <td class="px-3 py-2 text-right">${deleteBtn}</td>
      </tr>`
  }).join('')

  loadingEl.outerHTML = `<table class="w-full text-xs"><tbody>${rows}</tbody></table>`

  container.querySelectorAll<HTMLButtonElement>('button.del-btn').forEach((btn) => {
    btn.onclick = async (): Promise<void> => {
      const id = btn.dataset.id!
      const source = btn.dataset.source!
      const ok = await deleteFeature(categoryId, source, id)
      if (ok) {
        showToast(document.body, 'Deleted', { type: 'success', position: 'fixed' })
        await renderCategoryList(container, categoryId)
      } else {
        showToast(document.body, 'Delete failed', { type: 'error', position: 'fixed' })
      }
    }
  })
}

const renderSearchInto = async (container: HTMLElement, q: string, c: string): Promise<void> => {
  container.innerHTML = '<div class="px-6 py-4 text-text-muted text-xs">Searching…</div>'
  const result = await search(q, c)
  if (!result || result.features.length === 0) {
    container.innerHTML = `<div class="px-6 py-4 text-text-muted text-xs">No match for "${escapeHtml(q)}" in ${escapeHtml(c)}.</div>`
    return
  }
  const f = result.features[0]!
  const p = f.properties
  const [lng, lat] = f.geometry.coordinates
  container.innerHTML = `
    <div class="px-6 py-3 border-b border-border">
      <div class="text-sm">${escapeHtml(p.name)} <span class="ml-2 px-1 py-0.5 rounded bg-surface-muted text-text-muted text-[10px]">${escapeHtml(result.source)}</span></div>
      <div class="text-xs text-text-muted font-mono mt-1">${lat.toFixed(5)}, ${lng.toFixed(5)}</div>
    </div>
    <div class="map-preview" style="height:240px"></div>`
  const previewEl = container.querySelector<HTMLDivElement>('.map-preview')!
  const env = JSON.stringify({
    view: { center: [lat, lng], zoom: 9 },
    features: [{ type: 'marker', lat, lng, label: p.name }],
  })
  await renderMapSource(previewEl, env)
}

// ============================================================================
// Public entry point
// ============================================================================

export const renderGeodataPanel = async (container: HTMLElement): Promise<void> => {
  let categoryOptions = ''
  try {
    const resp = await fetchOverview()
    categoryOptions = resp.categories.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.displayName)}</option>`).join('')
  } catch { /* empty */ }

  container.innerHTML = `
    <div class="px-6 py-3 border-b border-border flex items-center gap-2">
      <input type="text" placeholder="Search…" class="search-q flex-1 bg-surface-muted text-text text-xs px-2 py-1 rounded border border-border" />
      <select class="search-cat bg-surface-muted text-text text-xs px-2 py-1 rounded border border-border">${categoryOptions}</select>
      <button class="search-btn text-xs px-2 py-1 rounded bg-surface-muted hover:bg-surface text-text border border-border">Search</button>
      <button class="import-btn text-xs px-2 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white">Import…</button>
    </div>
    <div class="body"></div>`
  const body = container.querySelector<HTMLDivElement>('.body')!
  await renderOverview(body)

  const qEl = container.querySelector<HTMLInputElement>('.search-q')!
  const catEl = container.querySelector<HTMLSelectElement>('.search-cat')!
  const searchBtn = container.querySelector<HTMLButtonElement>('.search-btn')!
  const importBtn = container.querySelector<HTMLButtonElement>('.import-btn')!
  const submit = (): void => {
    const q = qEl.value.trim()
    const c = catEl.value
    if (!q || !c) return
    void renderSearchInto(body, q, c)
  }
  searchBtn.onclick = submit
  qEl.onkeydown = (e): void => { if (e.key === 'Enter') submit() }
  importBtn.onclick = (): void => {
    void openGeodataImportModal(() => { void renderGeodataPanel(container) })
  }
}
