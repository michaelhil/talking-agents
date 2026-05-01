// Marker icon SVGs — inline, monochrome, colour-driven.
//
// Each factory returns a complete <svg> string. The renderer wraps these in
// a Leaflet divIcon when a marker has an `icon` or `color` field. The default
// bitmap pin (set up in api.ts) handles plain markers with neither field.
//
// Anchor convention:
//   - 'pin' is a teardrop, anchored at bottom-centre (the tip touches the
//     coordinate). All others are square and anchored at centre.
//
// Colour: the SVGs use `currentColor` everywhere, and the divIcon wrapper
// sets `color: <user-colour>` inline. One CSS variable indirection means
// future theme-aware fallbacks are a one-liner.

import type { MarkerIcon } from './normalise.ts'

export interface IconSpec {
  html: string
  size: [number, number]
  anchor: [number, number]
}

const DEFAULT_COLOR = '#2563eb' // blue-600 — close to Leaflet's default pin tone

const escapeAttr = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

const wrap = (svg: string, color: string): string =>
  `<div style="color:${escapeAttr(color)};display:flex;align-items:center;justify-content:center;width:100%;height:100%;filter:drop-shadow(0 1px 1px rgba(0,0,0,.4))">${svg}</div>`

// Teardrop pin — anchor at the tip.
const PIN_SVG = `<svg viewBox="0 0 24 32" width="24" height="32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M12 0C5.4 0 0 5.4 0 12c0 8.5 12 20 12 20s12-11.5 12-20c0-6.6-5.4-12-12-12z" fill="currentColor" stroke="rgba(0,0,0,.35)" stroke-width="1"/>
  <circle cx="12" cy="12" r="4.5" fill="white"/>
</svg>`

const PLANE_SVG = `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M12 2 L13.5 10 L22 12 L13.5 14 L12 22 L10.5 14 L2 12 L10.5 10 Z" fill="currentColor" stroke="rgba(0,0,0,.4)" stroke-width=".6"/>
</svg>`

const AIRPORT_SVG = `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <circle cx="12" cy="12" r="10" fill="currentColor" stroke="rgba(0,0,0,.4)" stroke-width="1"/>
  <path d="M12 5 L13 11 L19 12 L13 13 L12 19 L11 13 L5 12 L11 11 Z" fill="white"/>
</svg>`

const PLATFORM_SVG = `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect x="2" y="14" width="20" height="3" fill="currentColor" stroke="rgba(0,0,0,.4)" stroke-width=".5"/>
  <path d="M6 14 L6 22 M18 14 L18 22 M10 14 L10 22 M14 14 L14 22" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  <path d="M12 2 L8 14 L16 14 Z" fill="currentColor" stroke="rgba(0,0,0,.4)" stroke-width=".5"/>
</svg>`

const SHIP_SVG = `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M3 17 L21 17 L19 21 L5 21 Z" fill="currentColor" stroke="rgba(0,0,0,.4)" stroke-width=".5"/>
  <rect x="9" y="10" width="6" height="7" fill="currentColor"/>
  <path d="M12 2 L12 10" stroke="currentColor" stroke-width="1.5"/>
  <path d="M12 4 L17 7 L12 7 Z" fill="currentColor"/>
</svg>`

const CITY_SVG = `<svg viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect x="3" y="10" width="5" height="12" fill="currentColor" stroke="rgba(0,0,0,.4)" stroke-width=".5"/>
  <rect x="10" y="4" width="5" height="18" fill="currentColor" stroke="rgba(0,0,0,.4)" stroke-width=".5"/>
  <rect x="17" y="8" width="4" height="14" fill="currentColor" stroke="rgba(0,0,0,.4)" stroke-width=".5"/>
</svg>`

const DOT_SVG = `<svg viewBox="0 0 16 16" width="16" height="16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <circle cx="8" cy="8" r="6" fill="currentColor" stroke="white" stroke-width="2"/>
</svg>`

const SVG_BY_ICON: Record<MarkerIcon, string> = {
  pin: PIN_SVG,
  plane: PLANE_SVG,
  airport: AIRPORT_SVG,
  platform: PLATFORM_SVG,
  ship: SHIP_SVG,
  city: CITY_SVG,
  dot: DOT_SVG,
}

const SIZE_BY_ICON: Record<MarkerIcon, { size: [number, number]; anchor: [number, number] }> = {
  // Pin tip is at the bottom-centre. Bitmap pin uses 25×41 / anchor [12,41];
  // we scale to 24×32 / anchor [12,32] which is visually similar.
  pin:      { size: [24, 32], anchor: [12, 32] },
  plane:    { size: [24, 24], anchor: [12, 12] },
  airport:  { size: [24, 24], anchor: [12, 12] },
  platform: { size: [24, 24], anchor: [12, 12] },
  ship:     { size: [24, 24], anchor: [12, 12] },
  city:     { size: [24, 24], anchor: [12, 12] },
  dot:      { size: [16, 16], anchor: [8, 8] },
}

export const buildIconSpec = (icon: MarkerIcon | undefined, color: string | undefined): IconSpec => {
  // No icon set but colour is — render a coloured pin (most common case
  // for "highlight this marker red").
  const effectiveIcon: MarkerIcon = icon ?? 'pin'
  const svg = SVG_BY_ICON[effectiveIcon]
  const dim = SIZE_BY_ICON[effectiveIcon]
  return {
    html: wrap(svg, color ?? DEFAULT_COLOR),
    size: dim.size,
    anchor: dim.anchor,
  }
}
