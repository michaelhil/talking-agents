// ============================================================================
// Empty-state inline strip — discoverability lure for the demos pack.
//
// Renders inside the messages container when:
//   - the current room has zero non-system messages (i.e. the only thing
//     anyone sees is the welcome banner from the boot scenario)
//   - AND no scenario is currently running in this tab's ownership
//
// Disappears as soon as either condition becomes false (the user posts, or
// any scenario starts). Lives at the bottom of #messages so it doesn't
// shove the welcome banner around — fits the "quiet nudge" UX.
//
// The strip queries /api/scenarios on mount; renders nothing if the demos
// pack didn't load. No state lives in the strip — it's stateless rendering
// driven by store events the app already pushes.
// ============================================================================

import { confirmRunWithConsent, type ScenarioConsentMeta } from './scenario-consent.ts'
import { $selectedRoomId, $rooms } from './stores.ts'

interface CatalogScenario {
  readonly id: string
  readonly pack: string
  readonly name: string
  readonly title: string
  readonly description: string
  readonly category: 'demo' | 'tutorial' | 'onboarding'
  readonly opCount: number
  readonly opKinds: ReadonlyArray<string>
}

const currentRoomName = (): string | undefined => {
  const id = $selectedRoomId.get()
  if (!id) return undefined
  return $rooms.get()[id]?.name
}

const STRIP_ID = 'scenario-empty-state-strip'

const fetchDemoCatalog = async (): Promise<CatalogScenario[]> => {
  try {
    const res = await fetch('/api/scenarios')
    if (!res.ok) return []
    const data = await res.json() as { scenarios: CatalogScenario[] }
    // Filter to category: demo specifically — tutorials are interactive
    // walkthroughs that need a fresh room, and onboarding/welcome already
    // ran. We want the strip to only pitch the one-click showcase set.
    return data.scenarios.filter(s => s.category === 'demo')
  } catch { return [] }
}

const hasOwnedActiveRun = (): boolean => {
  try {
    const raw = sessionStorage.getItem('samsinn:owned-scenario-runs') ?? ''
    return raw.split(',').filter(Boolean).length > 0
  } catch { return false }
}

const buildStrip = (demos: ReadonlyArray<CatalogScenario>, refresh: () => void): HTMLElement => {
  const wrap = document.createElement('div')
  wrap.id = STRIP_ID
  wrap.className = 'mt-4 mx-4 p-3 rounded border border-border bg-surface-muted'

  const header = document.createElement('div')
  header.className = 'text-xs text-text-subtle mb-2'
  header.textContent = 'New here? Try a demo →'
  wrap.appendChild(header)

  // Vertical column — full-width cards, one per row. Grows naturally with
  // the demo count; no horizontal scroll. The strip lives in the messages
  // container so the surrounding scroll is the existing chat scroll, which
  // already handles overflow when the demo list outgrows the viewport.
  const grid = document.createElement('div')
  grid.className = 'flex flex-col gap-2'
  for (const demo of demos) {
    const btn = document.createElement('button')
    btn.className = 'w-full text-left px-3 py-2 rounded border border-border bg-surface hover:bg-surface-strong'
    btn.title = demo.description
    const t = document.createElement('div')
    t.className = 'text-xs font-semibold text-text'
    t.textContent = demo.title
    const d = document.createElement('div')
    d.className = 'text-xs text-text-subtle'
    d.textContent = demo.description
    btn.appendChild(t)
    btn.appendChild(d)
    btn.addEventListener('click', async () => {
      const meta: ScenarioConsentMeta = {
        id: demo.id,
        pack: demo.pack,
        name: demo.name,
        title: demo.title,
        description: demo.description,
        opKinds: demo.opKinds,
      }
      const runId = await confirmRunWithConsent(meta, currentRoomName())
      if (runId) refresh()   // strip will hide once active run is detected
    })
    grid.appendChild(btn)
  }
  wrap.appendChild(grid)
  return wrap
}

// Per-call token — incremented on every render-strip entry. The async
// fetch+append phase checks the token on resume; if a newer call has run
// in the meantime, the older one drops out instead of double-appending.
// Without this, the room-load + room-message-update WS events both call
// in quickly, both pass the initial dedup query, both await fetch, both
// append — duplicate-id strips in the DOM.
let renderToken = 0

// Public — called by app.ts after WS connect. Mounts inside the messages
// container; re-evaluates visibility on every refresh() call (which app.ts
// can wire to message events / room switches).
export const renderScenarioStrip = async (
  messagesContainer: HTMLElement,
  isCurrentRoomEmpty: () => boolean,
): Promise<void> => {
  const myToken = ++renderToken
  // Remove ALL existing strips (not just first; defensive against any
  // pre-existing duplicates from a prior race window).
  for (const el of messagesContainer.querySelectorAll(`#${STRIP_ID}`)) el.remove()

  if (!isCurrentRoomEmpty()) return
  if (hasOwnedActiveRun()) return

  const demos = await fetchDemoCatalog()
  // If a newer render started during the await, drop out — the newer call
  // owns the result, and we'd just be racing to append the same thing.
  if (myToken !== renderToken) return
  if (demos.length === 0) return

  // Re-check both predicates after the await — state may have changed.
  if (!isCurrentRoomEmpty()) return
  if (hasOwnedActiveRun()) return

  const refresh = (): void => { void renderScenarioStrip(messagesContainer, isCurrentRoomEmpty) }
  messagesContainer.appendChild(buildStrip(demos, refresh))
}
