// Icon helper — vendored Lucide SVGs (ISC licensed, attribution: lucide.dev).
// Returns an SVGElement configured with the default stroke + size. Callers
// can override via opts. Kept dep-free: no npm import, icons copied inline.
//
// To add an icon: copy the inner <path>/<circle>/... elements from
// https://lucide.dev/icons/<name>, viewBox always '0 0 24 24'. The wrapper
// attributes (fill none, stroke currentColor, stroke-width, linecap, linejoin)
// are applied uniformly below.

export type IconName =
  | 'sun'
  | 'moon'
  | 'bookmark'
  | 'message-square'       // room prompt
  | 'x'                    // close buttons (replaces many × glyphs if desired)
  | 'settings'             // summary settings cog
  | 'external-link'
  | 'refresh-cw'           // rescan / regenerate
  | 'plus'                 // create-new
  | 'chevron-right'        // collapsed row
  | 'chevron-down'         // expanded row
  | 'trash'                // delete / clear messages
  | 'megaphone'            // broadcast mode
  | 'hand'                 // manual mode
  | 'archive'              // summary / compression
  | 'search'               // summary inspect
  | 'pin'                  // pin message
  | 'folder-open'          // workspace
  | 'corner-down-left'     // send (carriage-return)
  | 'eye'                  // visibility toggle (visible)
  | 'eye-off'              // visibility toggle (hidden)
  | 'bug'                  // bug report
  | 'clapperboard'         // script start
  | 'play'                 // run / start (script chip)
  | 'square'               // stop (script chip)
  | 'skip-forward'         // force-advance step
  | 'copy'                 // copy-to-clipboard hover button
  | 'check'                // copy-confirmation feedback
  | 'cpu'                  // AI agent kind glyph (replaces 🤖)
  | 'user'                 // human agent kind glyph (replaces 🧠)
  | 'pencil'               // inline edit / rename

// Path fragments only (no SVG wrapper). Each string is the inner markup of
// a 24×24 viewBox. Keep alphabetical.
const PATHS: Readonly<Record<IconName, string>> = {
  'archive':
    '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  'bookmark':
    '<path d="m19 21-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  'bug':
    '<path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/>',
  'check':
    '<polyline points="20 6 9 17 4 12"/>',
  'chevron-down':
    '<path d="m6 9 6 6 6-6"/>',
  'chevron-right':
    '<path d="m9 18 6-6-6-6"/>',
  'copy':
    '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  'cpu':
    '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>',
  'pencil':
    '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  'clapperboard':
    '<path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3z"/><path d="m6.2 5.3 3.1 3.9"/><path d="m12.4 3.4 3.1 4"/><path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  'corner-down-left':
    '<polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>',
  'external-link':
    '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  'eye':
    '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off':
    '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/>',
  'folder-open':
    '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  'hand':
    '<path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
  'megaphone':
    '<path d="m3 11 18-5v12L3 14z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  'message-square':
    '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  'moon':
    '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  'play':
    '<polygon points="6 3 20 12 6 21 6 3"/>',
  'square':
    '<rect width="14" height="14" x="5" y="5" rx="2"/>',
  'skip-forward':
    '<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/>',
  'pin':
    '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  'plus':
    '<path d="M12 5v14M5 12h14"/>',
  'refresh-cw':
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  'search':
    '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  'settings':
    '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  'sun':
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
  'trash':
    '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  'user':
    '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  'x':
    '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
}

export interface IconOptions {
  readonly size?: number        // px, default 16
  readonly stroke?: number      // stroke-width, default 1.5
  readonly className?: string
  readonly title?: string       // accessible label; adds <title> inside SVG
  readonly fill?: string        // default 'none' — bookmark often 'currentColor'
  readonly style?: string       // CSS inline style for ad-hoc transforms (e.g. rotate)
}

export const icon = (name: IconName, opts: IconOptions = {}): SVGSVGElement => {
  const size = opts.size ?? 16
  const stroke = opts.stroke ?? 1.5
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', opts.fill ?? 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', String(stroke))
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  if (opts.className) svg.setAttribute('class', opts.className)
  if (opts.style) svg.setAttribute('style', opts.style)
  if (opts.title) {
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'title')
    t.textContent = opts.title
    svg.appendChild(t)
  }
  // innerHTML on SVG works in modern browsers; cheap + readable.
  svg.innerHTML = svg.innerHTML + PATHS[name]
  return svg
}

// One-shot DOM scan: replace every `<span data-icon="name">` placeholder
// in static HTML with the corresponding SVG. Reads optional inline style
// hints from `data-icon-fill`, `data-icon-style`, `data-icon-size`,
// `data-icon-stroke`. Idempotent — placeholders are replaced (not nested).
export const hydrateIconPlaceholders = (root: ParentNode = document): void => {
  const nodes = root.querySelectorAll<HTMLElement>('[data-icon]')
  for (const el of nodes) {
    const name = el.getAttribute('data-icon') as IconName | null
    if (!name || !(name in PATHS)) continue
    const size = el.getAttribute('data-icon-size')
    const stroke = el.getAttribute('data-icon-stroke')
    const fill = el.getAttribute('data-icon-fill')
    const style = el.getAttribute('data-icon-style')
    const cls = el.getAttribute('data-icon-class')
    const opts: IconOptions = {
      ...(size ? { size: Number(size) } : {}),
      ...(stroke ? { stroke: Number(stroke) } : {}),
      ...(fill ? { fill } : {}),
      ...(style ? { style } : {}),
      ...(cls ? { className: cls } : {}),
    }
    const svg = icon(name, opts)
    // Preserve the placeholder element itself (theme toggle uses .theme-icon-sun
    // to control visibility). Replace only its contents.
    el.replaceChildren(svg)
  }
}

// HTML-string variant for contexts that inject via innerHTML (e.g. inline
// button markup in existing templates). Same attributes as icon().
export const iconHtml = (name: IconName, opts: IconOptions = {}): string => {
  const size = opts.size ?? 16
  const stroke = opts.stroke ?? 1.5
  const cls = opts.className ? ` class="${opts.className}"` : ''
  const style = opts.style ? ` style="${opts.style}"` : ''
  const fill = opts.fill ?? 'none'
  const title = opts.title ? `<title>${opts.title}</title>` : ''
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"${cls}${style}>${title}${PATHS[name]}</svg>`
}
