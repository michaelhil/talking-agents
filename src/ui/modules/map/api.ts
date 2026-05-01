// Leaflet API loader — script-tag injection from jsdelivr.
//
// Leaflet's npm-published bundle on jsdelivr is UMD only — `import()` of a
// UMD module doesn't expose the API the way ESM does, so we inject a
// <script> tag and resolve when `window.L` becomes available. Same CDN
// host (cdn.jsdelivr.net) the mermaid loader uses, so no new CSP entries
// are needed for the script.
//
// Leaflet ALSO needs a stylesheet (~14KB) for tile layout, controls, and
// attribution. Inject as a <link> on first load. Requires CSP `style-src`
// to allow `https://cdn.jsdelivr.net` (deploy/Caddyfile).
//
// Failure policy mirrors mermaid: on load failure, ensureLeaflet resolves
// to null. The fallback UI takes over per-render. No auto-retry.

const LEAFLET_VERSION = '1.9.4'
const LEAFLET_SCRIPT = `https://cdn.jsdelivr.net/npm/leaflet@${LEAFLET_VERSION}/dist/leaflet.js`
const LEAFLET_CSS = `https://cdn.jsdelivr.net/npm/leaflet@${LEAFLET_VERSION}/dist/leaflet.css`

// Subset of the Leaflet API we actually call. `unknown` for the bits we
// pass through but don't care about the shape of (LatLngBounds, Layer, etc).
export interface LeafletApi {
  map: (el: HTMLElement, options?: Record<string, unknown>) => LeafletMap
  tileLayer: (url: string, options?: Record<string, unknown>) => LeafletLayer
  marker: (latlng: [number, number], options?: Record<string, unknown>) => LeafletLayer
  polyline: (latlngs: ReadonlyArray<[number, number]>, options?: Record<string, unknown>) => LeafletLayer
  polygon: (latlngs: ReadonlyArray<[number, number]>, options?: Record<string, unknown>) => LeafletLayer
  circle: (latlng: [number, number], options?: Record<string, unknown>) => LeafletLayer
  geoJSON: (data: unknown, options?: Record<string, unknown>) => LeafletLayer
  latLngBounds: (latlngs: ReadonlyArray<[number, number]>) => LeafletBounds
  divIcon: (options: Record<string, unknown>) => unknown
}

export interface LeafletMap {
  setView: (latlng: [number, number], zoom: number) => LeafletMap
  fitBounds: (bounds: LeafletBounds, options?: Record<string, unknown>) => LeafletMap
  remove: () => void
  invalidateSize: () => void
  addLayer: (layer: LeafletLayer) => LeafletMap
  on: (event: string, handler: (e: unknown) => void) => LeafletMap
}

export interface LeafletLayer {
  addTo: (map: LeafletMap) => LeafletLayer
  bindPopup: (content: string) => LeafletLayer
  bindTooltip: (content: string, options?: Record<string, unknown>) => LeafletLayer
  getBounds?: () => LeafletBounds
}

export interface LeafletBounds {
  isValid: () => boolean
  extend: (other: LeafletBounds | [number, number]) => LeafletBounds
}

let leafletReady: Promise<LeafletApi | null> | null = null
let leafletApi: LeafletApi | null = null

const injectStylesheet = (): void => {
  if (document.querySelector(`link[data-leaflet]`)) return
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = LEAFLET_CSS
  link.dataset.leaflet = '1'
  document.head.appendChild(link)
}

const injectScript = (): Promise<LeafletApi | null> => new Promise((resolve) => {
  // Already loaded by another renderer in the same page.
  const existing = (window as unknown as { L?: LeafletApi }).L
  if (existing) { resolve(existing); return }

  const script = document.createElement('script')
  script.src = LEAFLET_SCRIPT
  script.async = true
  script.dataset.leaflet = '1'
  script.onload = () => {
    const L = (window as unknown as { L?: LeafletApi }).L
    if (!L) {
      console.warn('[map] leaflet loaded but window.L not present')
      resolve(null)
      return
    }
    // Pin default marker icon URLs to the CDN. Leaflet's default icon
    // resolves PNG paths relative to the script's URL, which fails when
    // the script is loaded from jsdelivr — markers render as empty grey
    // rectangles. Setting Default.prototype.options applies to every
    // marker created via L.marker() without a custom icon.
    const Lwithicon = L as unknown as {
      Icon?: {
        Default?: {
          prototype?: { options?: Record<string, unknown> }
          mergeOptions?: (opts: Record<string, unknown>) => void
        }
      }
    }
    const iconBase = `https://cdn.jsdelivr.net/npm/leaflet@${LEAFLET_VERSION}/dist/images`
    if (Lwithicon.Icon?.Default?.mergeOptions) {
      Lwithicon.Icon.Default.mergeOptions({
        iconUrl: `${iconBase}/marker-icon.png`,
        iconRetinaUrl: `${iconBase}/marker-icon-2x.png`,
        shadowUrl: `${iconBase}/marker-shadow.png`,
      })
    } else if (Lwithicon.Icon?.Default?.prototype?.options) {
      Object.assign(Lwithicon.Icon.Default.prototype.options, {
        iconUrl: `${iconBase}/marker-icon.png`,
        iconRetinaUrl: `${iconBase}/marker-icon-2x.png`,
        shadowUrl: `${iconBase}/marker-shadow.png`,
      })
    }
    resolve(L)
  }
  script.onerror = (err) => {
    console.warn('[map] leaflet script load failed:', err)
    resolve(null)
  }
  document.head.appendChild(script)
})

export const ensureLeaflet = (): Promise<LeafletApi | null> => {
  if (leafletReady) return leafletReady
  injectStylesheet()
  leafletReady = injectScript().then((api) => {
    leafletApi = api
    return api
  })
  return leafletReady
}

export const getLeafletApi = (): LeafletApi | null => leafletApi
