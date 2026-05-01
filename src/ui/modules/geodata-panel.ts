// ============================================================================
// Geodata panel — read-only first pass.
//
// Shows per-category counts (bundled vs local-verified vs local-unverified),
// a search box hitting /api/geodata/search (which runs the full cascade),
// and a list of local features with delete-buttons for unverified entries.
//
// Import / export / edit / promote-to-verified are NOT in this pass — they
// live in a follow-up milestone.
// ============================================================================

import { showToast } from './toast.ts'
import { renderMapSource } from './map/index.ts'

type Category = 'airport' | 'offshore-platform' | 'city' | 'landmark' | 'address' | 'other'

interface OverviewRow {
  readonly category: Category
  readonly bundled: number
  readonly local: number
  readonly verified: number
  readonly unverified: number
}

interface OverviewResp {
  readonly categories: ReadonlyArray<OverviewRow>
  readonly bundledVersion: string
}

interface GeoFeature {
  readonly type: 'Feature'
  readonly geometry: { readonly type: 'Point'; readonly coordinates: readonly [number, number] }
  readonly properties: {
    readonly id: string
    readonly name: string
    readonly category: Category
    readonly verified: boolean
    readonly source: string
    readonly aliases?: ReadonlyArray<string>
    readonly country?: string
    readonly operator?: string
    readonly icao?: string
    readonly iata?: string
  }
}

const CATEGORIES: ReadonlyArray<Category> = [
  'airport', 'offshore-platform', 'city', 'landmark', 'address', 'other',
]

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c))

const fetchOverview = async (): Promise<OverviewResp> => {
  const res = await fetch('/api/geodata')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json() as OverviewResp
}

const fetchCategoryFeatures = async (c: Category): Promise<ReadonlyArray<GeoFeature>> => {
  const res = await fetch(`/api/geodata/${encodeURIComponent(c)}`)
  if (!res.ok) return []
  const data = await res.json() as { features?: ReadonlyArray<GeoFeature> }
  return data.features ?? []
}

const deleteFeature = async (c: Category, source: string, id: string): Promise<boolean> => {
  const res = await fetch(`/api/geodata/${encodeURIComponent(c)}/${encodeURIComponent(source)}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
  return res.ok
}

const search = async (q: string, c: Category): Promise<{ source: string; features: ReadonlyArray<GeoFeature> } | null> => {
  const url = `/api/geodata/search?q=${encodeURIComponent(q)}&category=${encodeURIComponent(c)}`
  const res = await fetch(url)
  if (!res.ok) return null
  const data = await res.json() as { result?: { source: string; features: ReadonlyArray<GeoFeature> } }
  return data.result ?? null
}

// ============================================================================
// Renderers
// ============================================================================

const renderOverview = async (container: HTMLElement): Promise<void> => {
  container.innerHTML = '<div class="px-6 py-4 text-text-muted text-xs">Loading…</div>'
  let resp: OverviewResp
  try { resp = await fetchOverview() }
  catch (err) {
    container.innerHTML = `<div class="px-6 py-4 text-red-400 text-xs">Failed: ${escapeHtml(String(err))}</div>`
    return
  }

  const sections: string[] = []
  sections.push(`<div class="px-6 py-3 text-xs text-text-muted border-b border-border">Bundled snapshot version: <span class="font-mono text-text">${escapeHtml(resp.bundledVersion)}</span>${resp.bundledVersion === '0.0.0' ? ' — bundled dataset not yet shipped' : ''}</div>`)
  sections.push('<table class="w-full text-xs"><thead><tr class="text-left text-text-muted border-b border-border"><th class="px-6 py-2">Category</th><th class="px-3 py-2 text-right">Bundled</th><th class="px-3 py-2 text-right">Verified (local)</th><th class="px-3 py-2 text-right">Unverified</th><th class="px-3 py-2 text-right"></th></tr></thead><tbody>')
  for (const row of resp.categories) {
    sections.push(`
      <tr class="border-b border-border/50 hover:bg-surface-muted/40">
        <td class="px-6 py-2 font-mono">${escapeHtml(row.category)}</td>
        <td class="px-3 py-2 text-right">${row.bundled}</td>
        <td class="px-3 py-2 text-right">${row.verified}</td>
        <td class="px-3 py-2 text-right">${row.unverified}</td>
        <td class="px-3 py-2 text-right"><button data-cat="${escapeHtml(row.category)}" class="cat-list-btn text-blue-400 hover:underline">View</button></td>
      </tr>`)
  }
  sections.push('</tbody></table>')
  container.innerHTML = sections.join('')

  container.querySelectorAll<HTMLButtonElement>('button.cat-list-btn').forEach((btn) => {
    btn.onclick = (): void => {
      const c = btn.dataset.cat as Category
      void renderCategoryList(container, c)
    }
  })
}

const renderCategoryList = async (container: HTMLElement, category: Category): Promise<void> => {
  container.innerHTML = `<div class="px-6 py-3 border-b border-border flex items-center justify-between">
    <button class="back-btn text-xs text-blue-400 hover:underline">← Back</button>
    <span class="text-xs text-text-muted font-mono">${escapeHtml(category)}</span>
  </div><div class="loading px-6 py-4 text-text-muted text-xs">Loading…</div>`
  container.querySelector<HTMLButtonElement>('.back-btn')!.onclick = (): void => {
    void renderOverview(container)
  }
  const features = await fetchCategoryFeatures(category)
  const loadingEl = container.querySelector<HTMLDivElement>('.loading')
  if (!loadingEl) return

  if (features.length === 0) {
    loadingEl.innerHTML = '<div class="text-text-muted">No local features in this category.</div>'
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
      const ok = await deleteFeature(category, source, id)
      if (ok) {
        showToast(document.body, 'Deleted', { type: 'success', position: 'fixed' })
        await renderCategoryList(container, category)
      } else {
        showToast(document.body, 'Delete failed', { type: 'error', position: 'fixed' })
      }
    }
  })
}

// ============================================================================
// Search renderer + map preview
// ============================================================================

export const renderSearchInto = async (container: HTMLElement, q: string, c: Category): Promise<void> => {
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
    features: [{
      type: 'marker', lat, lng, label: p.name,
      icon: p.category === 'airport' ? 'airport' : p.category === 'offshore-platform' ? 'platform' : p.category === 'city' ? 'city' : 'pin',
    }],
  })
  await renderMapSource(previewEl, env)
}

// ============================================================================
// Public entry point
// ============================================================================

export const renderGeodataPanel = async (container: HTMLElement): Promise<void> => {
  // Search bar + body. The body section toggles between overview / category /
  // search-result modes.
  container.innerHTML = `
    <div class="px-6 py-3 border-b border-border flex items-center gap-2">
      <input type="text" placeholder="Search…" class="search-q flex-1 bg-surface-muted text-text text-xs px-2 py-1 rounded border border-border" />
      <select class="search-cat bg-surface-muted text-text text-xs px-2 py-1 rounded border border-border">
        ${CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join('')}
      </select>
      <button class="search-btn text-xs px-2 py-1 rounded bg-surface-muted hover:bg-surface text-text border border-border">Search</button>
    </div>
    <div class="body"></div>`
  const body = container.querySelector<HTMLDivElement>('.body')!
  await renderOverview(body)

  const qEl = container.querySelector<HTMLInputElement>('.search-q')!
  const catEl = container.querySelector<HTMLSelectElement>('.search-cat')!
  const btn = container.querySelector<HTMLButtonElement>('.search-btn')!
  const submit = (): void => {
    const q = qEl.value.trim()
    if (!q) return
    void renderSearchInto(body, q, catEl.value as Category)
  }
  btn.onclick = submit
  qEl.onkeydown = (e): void => { if (e.key === 'Enter') submit() }
}
