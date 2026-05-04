// Fallback UI for map render failures. Shared between the inline chat
// renderer and the artifact renderer (legacy) for visual consistency.
//
// The "invalid" path renders structured validation errors prominently —
// the same text that would be returned to an agent in a tool result, so
// when the agent reads its own chat history on the next turn it sees
// the structured error and can self-correct. No silent fallbacks.
//
// Built with createElement + textContent — no innerHTML — so future edits
// can't accidentally introduce an XSS hole when concatenating source.

import { truncateForDisplay } from './normalise.ts'

export type FallbackReason = 'unavailable' | 'invalid' | 'tile-blocked' | 'empty'

const REASON_HEADLINE: Record<FallbackReason, string> = {
  unavailable: 'Map rendering unavailable',
  invalid: 'Map could not render',
  'tile-blocked': 'Map tiles failed to load',
  empty: 'Map has no features and no view set',
}

const REASON_HINT: Record<FallbackReason, string> = {
  unavailable: 'Leaflet failed to load — likely a network or CSP issue.',
  invalid: '',  // detail carries the validation messages
  'tile-blocked': 'OSM tile servers refused the request. The map outline rendered but tiles are missing.',
  empty: 'Add at least one feature or set `view` to a center+zoom.',
}

export const showMapFallback = (
  el: HTMLElement,
  source: string,
  reason: FallbackReason,
  detail?: string,
): void => {
  el.replaceChildren()
  el.className = 'my-2 text-xs border border-amber-500/40 bg-amber-50 dark:bg-amber-950/40 rounded p-3'
  el.setAttribute('role', 'alert')
  el.setAttribute('aria-label', 'Map rendering issue')

  const headline = document.createElement('div')
  headline.className = 'font-medium text-amber-900 dark:text-amber-200 mb-1 flex items-center gap-2'
  const icon = document.createElement('span')
  icon.textContent = '⚠'
  icon.setAttribute('aria-hidden', 'true')
  headline.appendChild(icon)
  const headlineText = document.createElement('span')
  headlineText.textContent = REASON_HEADLINE[reason]
  headline.appendChild(headlineText)
  el.appendChild(headline)

  // Detail block — for `invalid`, this is the structured validation
  // messages from parseMapBody (e.g. `features[3].icon: unknown marker
  // icon "directions_run". Valid: pin, plane, ...`). Multi-line preserved.
  if (detail) {
    const detailBlock = document.createElement('div')
    detailBlock.className = 'whitespace-pre-wrap text-amber-900 dark:text-amber-100 mb-2 font-mono text-[11px]'
    detailBlock.textContent = detail
    el.appendChild(detailBlock)
  } else if (REASON_HINT[reason]) {
    const hint = document.createElement('div')
    hint.className = 'text-amber-800 dark:text-amber-300 mb-2'
    hint.textContent = REASON_HINT[reason]
    el.appendChild(hint)
  }

  // Collapsed source view — clicking expands. Lets the user inspect
  // exactly what the agent emitted without burying the validation message.
  if (source && reason !== 'empty') {
    const details = document.createElement('details')
    details.className = 'text-text-muted'
    const summary = document.createElement('summary')
    summary.className = 'cursor-pointer text-[11px] hover:text-text'
    summary.textContent = 'Show source'
    details.appendChild(summary)
    const pre = document.createElement('pre')
    pre.className = 'whitespace-pre-wrap text-text font-mono text-[11px] mt-1 max-h-64 overflow-auto'
    pre.textContent = truncateForDisplay(source)
    details.appendChild(pre)
    el.appendChild(details)
  }
}
