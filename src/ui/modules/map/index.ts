// Public entrypoints for map rendering.
//
//   renderMapBlocks(container) — post-processes ```map and ```geojson code
//     fences inside a rendered markdown container (chat message rendering).
//   renderMapSource(container, source) — renders raw map JSON into a
//     container (artifact renderer).
//
// Each rendered wrapper stores the source on `data-map-source` so future
// re-renders (theme flip, etc.) can reuse it. v1 doesn't re-render on
// theme — OSM has no dark variant — but the attribute is there for it.

import { ensureLeaflet, type LeafletApi, type LeafletMap } from './api.ts'
import { parseMapSource, collectLatLngs, type ParsedMap, type EnvelopeFeature } from './normalise.ts'
import { showMapFallback } from './fallback.ts'
import { buildIconSpec } from './icons.ts'

const OSM_TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
const TILE_ERROR_THRESHOLD = 3   // After N tile errors, surface a fallback overlay.
const DEFAULT_HEIGHT_PX = 360

const buildMapContainer = (height = DEFAULT_HEIGHT_PX): HTMLElement => {
  const wrapper = document.createElement('div')
  wrapper.className = 'my-2 rounded overflow-hidden border border-border'
  wrapper.style.height = `${height}px`
  wrapper.style.width = '100%'
  return wrapper
}

const addEnvelopeFeature = (L: LeafletApi, map: LeafletMap, f: EnvelopeFeature): void => {
  if (f.type === 'marker') {
    // Use a divIcon path when the marker carries an explicit `icon` or
    // `color` — Leaflet's default bitmap pin ignores `color` silently, so
    // honoring those fields means swapping the icon entirely. Markers with
    // neither stay on the bitmap path (matches existing visual).
    const opts: Record<string, unknown> = {}
    if (f.icon || f.color) {
      const spec = buildIconSpec(f.icon, f.color)
      opts.icon = L.divIcon({
        html: spec.html,
        className: 'samsinn-marker',
        iconSize: spec.size,
        iconAnchor: spec.anchor,
      })
    }
    const m = L.marker([f.lat, f.lng], opts)
    if (f.label) m.bindTooltip(f.label, { permanent: false })
    m.addTo(map)
  } else if (f.type === 'line' || f.type === 'track') {
    const opts: Record<string, unknown> = {}
    if (f.color) opts.color = f.color
    if (f.weight) opts.weight = f.weight
    L.polyline(f.coords, opts).addTo(map)
  } else if (f.type === 'polygon') {
    const opts: Record<string, unknown> = {}
    if (f.color) opts.color = f.color
    if (f.fillColor) opts.fillColor = f.fillColor
    L.polygon(f.coords, opts).addTo(map)
  } else if (f.type === 'circle') {
    const opts: Record<string, unknown> = { radius: f.radius }
    if (f.color) opts.color = f.color
    L.circle([f.lat, f.lng], opts).addTo(map)
  }
}

// Build a Leaflet map into the given (sized) container, returning a tear-down
// the caller can use for re-renders. Returns null if rendering is impossible
// (already-flagged unavailable / invalid / empty); the caller swaps in a
// fallback overlay.
const buildMap = (
  L: LeafletApi,
  container: HTMLElement,
  parsed: Extract<ParsedMap, { kind: 'envelope' | 'geojson' }>,
  source: string,
): { map: LeafletMap } | null => {
  // Empty FeatureCollection AND no view => nothing to render.
  const points = collectLatLngs(parsed)
  const view = parsed.data.view
  if (points.length === 0 && !view) {
    showMapFallback(container, source, 'empty')
    return null
  }

  const map = L.map(container, { zoomControl: true, scrollWheelZoom: true })

  // Tile-error detection — fail loud after N errors so a CSP-blocked tile
  // host is visible, not a silent grey grid.
  let tileErrors = 0
  let tileErrorOverlay: HTMLElement | null = null
  // referrerPolicy on tile <img>s: OSM's volunteer-run servers reject
  // requests with no/weak Referer ("Referer is required" 403 tile).
  // 'no-referrer-when-downgrade' forces the browser to attach the full
  // page Referer on HTTPS→HTTPS tile fetches, overriding any stricter
  // page-level Referrer-Policy. crossOrigin is set so the browser uses
  // CORS on the tile request — required by some tile providers; OSM
  // accepts it.
  const tileLayer = L.tileLayer(OSM_TILE_URL, {
    attribution: OSM_ATTRIBUTION,
    maxZoom: 19,
    crossOrigin: '',
    referrerPolicy: 'no-referrer-when-downgrade',
  })
  ;(tileLayer as unknown as { on: (e: string, h: () => void) => void }).on('tileerror', () => {
    tileErrors++
    if (tileErrors === TILE_ERROR_THRESHOLD && !tileErrorOverlay) {
      tileErrorOverlay = document.createElement('div')
      tileErrorOverlay.className = 'absolute inset-0 flex items-center justify-center bg-surface/95 text-warning text-xs p-3 text-center'
      tileErrorOverlay.style.pointerEvents = 'none'
      tileErrorOverlay.textContent = 'Tiles failed to load — likely a CSP or network issue. Map controls still work.'
      container.style.position = 'relative'
      container.appendChild(tileErrorOverlay)
    }
  })
  tileLayer.addTo(map)

  // Add features. GeoJSON path delegates to L.geoJSON for the common case.
  if (parsed.kind === 'envelope') {
    for (const f of parsed.data.features) addEnvelopeFeature(L, map, f)
  } else {
    L.geoJSON(parsed.data, {}).addTo(map)
  }

  // View: explicit wins; else fitBounds. Single-point feature uses setView
  // with a sensible default zoom because fitBounds on a single point picks
  // the deepest zoom available — visually disorienting.
  if (view) {
    map.setView(view.center, view.zoom)
  } else if (points.length === 1) {
    map.setView(points[0]!, 12)
  } else {
    const bounds = L.latLngBounds(points)
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [20, 20] })
  }

  // After a sync render, the container has its measured size; Leaflet sometimes
  // computes tile layout pre-paint, leaving zero-tile coverage. invalidateSize
  // on next tick forces a recompute. Cheap insurance.
  setTimeout(() => { try { map.invalidateSize() } catch { /* noop */ } }, 0)

  return { map }
}

const renderInto = async (container: HTMLElement, source: string): Promise<void> => {
  container.setAttribute('data-map-source', source)

  const L = await ensureLeaflet()
  if (!L) {
    showMapFallback(container, source, 'unavailable')
    return
  }

  const parsed = parseMapSource(source)
  if (parsed.kind === 'invalid') {
    showMapFallback(container, source, 'invalid', parsed.reason)
    return
  }

  buildMap(L, container, parsed, source)
}

export const renderMapBlocks = async (container: HTMLElement): Promise<void> => {
  // Match both ```map and ```geojson fenced blocks. The markdown renderer
  // emits these as <code class="language-map"> / <code class="language-geojson">.
  const blocks = container.querySelectorAll('code.language-map, code.language-geojson')
  if (blocks.length === 0) return

  for (const block of blocks) {
    const pre = block.parentElement
    if (!pre) continue
    const source = block.textContent ?? ''
    const wrapper = buildMapContainer()
    pre.replaceWith(wrapper)
    // Fire-and-forget the render — Leaflet load is async but wrapper is in
    // the DOM with a height so layout doesn't shift when content arrives.
    void renderInto(wrapper, source)
  }
}

export const renderMapSource = async (container: HTMLElement, source: string): Promise<void> => {
  // Artifact path — caller passes the raw source. Make sure the container
  // has a sized box for Leaflet to measure against.
  if (!container.style.height) container.style.height = `${DEFAULT_HEIGHT_PX}px`
  if (!container.style.width) container.style.width = '100%'
  container.className = 'my-2 rounded overflow-hidden border border-border'
  await renderInto(container, source)
}
