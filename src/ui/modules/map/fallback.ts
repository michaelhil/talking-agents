// Fallback UI for map render failures. Shared between the inline chat
// renderer and the artifact renderer for visual consistency.
//
// Built with createElement + textContent — no innerHTML — so future edits
// can't accidentally introduce an XSS hole when concatenating source.

import { truncateForDisplay } from './normalise.ts'

export type FallbackReason = 'unavailable' | 'invalid' | 'tile-blocked' | 'empty'

const REASON_TEXT: Record<FallbackReason, string> = {
  unavailable: 'Map rendering unavailable (Leaflet failed to load — network or CSP).',
  invalid: "Map source couldn't parse — showing source.",
  'tile-blocked': 'Map tiles failed to load (likely a CSP or network issue). The map renders but tiles are missing.',
  empty: 'Map has no features and no view set — nothing to render.',
}

export const showMapFallback = (
  el: HTMLElement,
  source: string,
  reason: FallbackReason,
  detail?: string,
): void => {
  el.replaceChildren()
  el.className = 'my-2 text-xs border border-border rounded p-2 bg-surface-muted'
  el.setAttribute('role', 'alert')
  el.setAttribute('aria-label', 'Map rendering issue')

  const notice = document.createElement('div')
  notice.className = 'text-text-muted mb-1'
  notice.textContent = detail ? `${REASON_TEXT[reason]} (${detail})` : REASON_TEXT[reason]
  el.appendChild(notice)

  if (source && reason !== 'empty') {
    const pre = document.createElement('pre')
    pre.className = 'whitespace-pre-wrap text-text font-mono text-[11px]'
    pre.textContent = truncateForDisplay(source)
    el.appendChild(pre)
  }
}
