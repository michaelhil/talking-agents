// ============================================================================
// Room-header icon visibility popover.
//
// Click the eye in the room header → popover lists every header button that
// carries a [data-room-icon-id]. Each row:
//
//   [ eye / eye-off toggle ]   [ icon-button quick-access ]   [ label ]
//
// Toggling the eye applies/removes .user-hidden on the live header button
// AND persists to localStorage. The icon-button quick-access delegates via
// liveBtn.click() — runs the existing handler so the popover doubles as a
// quick-access bar even when the icon is hidden in the header.
//
// The eye button itself is intentionally NOT in the registry (always visible
// escape hatch). The room name, status dot, and macro chip aren't either.
// ============================================================================

import { hydrateIconPlaceholders } from './icon.ts'

const STORAGE_KEY = 'samsinn:room-header-hidden-icons'
const USER_HIDDEN_CLASS = 'user-hidden'

const readHidden = (): Set<string> => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? new Set(parsed.filter(x => typeof x === 'string')) : new Set()
  } catch { return new Set() }
}

const writeHidden = (set: Set<string>): void => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...set])) } catch { /* quota / disabled */ }
}

// Apply the persisted hidden-set on boot (and after every toggle).
const applyHidden = (hidden: Set<string>, header: HTMLElement): void => {
  for (const btn of header.querySelectorAll<HTMLElement>('[data-room-icon-id]')) {
    const id = btn.dataset.roomIconId!
    if (hidden.has(id)) btn.classList.add(USER_HIDDEN_CLASS)
    else btn.classList.remove(USER_HIDDEN_CLASS)
  }
}

interface RegistryEntry {
  readonly id: string
  readonly label: string
  readonly liveBtn: HTMLButtonElement
}

const collect = (header: HTMLElement): RegistryEntry[] => {
  const out: RegistryEntry[] = []
  for (const btn of header.querySelectorAll<HTMLButtonElement>('button[data-room-icon-id]')) {
    const id = btn.dataset.roomIconId
    if (!id) continue
    const label = btn.dataset.roomIconLabel ?? id
    out.push({ id, label, liveBtn: btn })
  }
  return out
}

export interface VisibilityPopoverDeps {
  readonly button: HTMLButtonElement     // #btn-icon-visibility
  readonly popover: HTMLElement          // #icon-visibility-popover
  readonly roomHeader: HTMLElement       // #room-header
}

export const mountVisibilityPopover = (deps: VisibilityPopoverDeps): void => {
  const { button, popover, roomHeader } = deps
  const hidden = readHidden()

  // Boot: apply persisted hides immediately.
  applyHidden(hidden, roomHeader)

  // Re-apply whenever the room header is shown (selectedRoomId change). The
  // header's `hidden` class is toggled by app.ts; we observe its mutation.
  const observer = new MutationObserver(() => applyHidden(hidden, roomHeader))
  observer.observe(roomHeader, { attributes: true, attributeFilter: ['class'] })

  const close = () => {
    popover.classList.add('hidden')
    button.setAttribute('aria-expanded', 'false')
    document.removeEventListener('click', offClick, true)
    document.removeEventListener('keydown', onKey, true)
  }

  const offClick = (e: MouseEvent) => {
    const target = e.target as Node
    if (popover.contains(target) || button.contains(target)) return
    close()
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close()
  }

  const render = (): void => {
    popover.innerHTML = ''
    const entries = collect(roomHeader)
    if (entries.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'px-3 py-2 text-text-subtle italic'
      empty.textContent = 'No icons to show'
      popover.appendChild(empty)
      return
    }

    for (const entry of entries) {
      const row = document.createElement('div')
      row.className = 'flex items-center gap-2 px-2 py-1 hover:bg-surface-muted'

      const eyeBtn = document.createElement('button')
      eyeBtn.type = 'button'
      eyeBtn.className = 'icon-btn px-1 text-text-subtle hover:text-text'
      const isHidden = hidden.has(entry.id)
      eyeBtn.title = isHidden ? `Show ${entry.label}` : `Hide ${entry.label}`
      eyeBtn.setAttribute('aria-label', eyeBtn.title)
      eyeBtn.innerHTML = `<span data-icon="${isHidden ? 'eye-off' : 'eye'}"></span>`
      eyeBtn.onclick = () => {
        if (hidden.has(entry.id)) hidden.delete(entry.id)
        else hidden.add(entry.id)
        writeHidden(hidden)
        applyHidden(hidden, roomHeader)
        render()   // refresh popover icons
      }
      row.appendChild(eyeBtn)

      // Quick-access proxy. Cloning the live button preserves its visual
      // (svg + decorations); clicking the proxy calls .click() on the live
      // button so the existing handler fires. We DO NOT touch the live
      // button's class list here — only the eye toggle does that.
      const proxy = document.createElement('button')
      proxy.type = 'button'
      proxy.className = 'mode-btn icon-btn'
      proxy.title = entry.label
      proxy.setAttribute('aria-label', entry.label)
      // Copy the inner SVG / data-icon span from the live button so we get
      // the same visual without re-replicating the icon registry here.
      const liveContent = entry.liveBtn.firstElementChild
      if (liveContent) proxy.appendChild(liveContent.cloneNode(true))
      proxy.onclick = (e) => {
        e.stopPropagation()
        entry.liveBtn.click()
      }
      row.appendChild(proxy)

      const label = document.createElement('span')
      label.className = 'flex-1 text-sm text-text'
      label.textContent = entry.label
      row.appendChild(label)

      popover.appendChild(row)
    }

    hydrateIconPlaceholders(popover)
  }

  button.onclick = (e) => {
    e.stopPropagation()
    const open = !popover.classList.contains('hidden')
    if (open) { close(); return }
    render()
    popover.classList.remove('hidden')
    button.setAttribute('aria-expanded', 'true')
    setTimeout(() => {
      document.addEventListener('click', offClick, true)
      document.addEventListener('keydown', onKey, true)
    }, 0)
  }
}
