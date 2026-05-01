// ============================================================================
// Room switcher — the chevron-down dropdown next to the room name in the
// room header. Click → popover lists all rooms + a "Create new room" entry.
//
// Always visible (full-screen mode + sidebar-open mode), so it serves as a
// quick switcher even when the sidebar is showing. Selecting a room sets
// $selectedRoomId; "Create new" opens the existing #room-modal so the
// create flow stays single-source.
// ============================================================================

import { batched } from '../../lib/nanostores.ts'
import { $rooms, $selectedRoomId, $unreadCounts, $pausedRooms, $generatingRoomIds } from '../stores.ts'

export interface RoomSwitcherDeps {
  readonly button: HTMLButtonElement
  readonly popover: HTMLElement
  readonly openCreateRoomModal: () => void
}

export const mountRoomSwitcher = (deps: RoomSwitcherDeps): void => {
  const { button, popover, openCreateRoomModal } = deps

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
    if (e.key === 'Escape') { close(); return }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'Enter') return
    const items = Array.from(popover.querySelectorAll<HTMLElement>('[data-room-row]'))
    if (items.length === 0) return
    const focused = document.activeElement as HTMLElement | null
    const idx = focused ? items.indexOf(focused) : -1
    if (e.key === 'Enter') {
      focused?.click()
      e.preventDefault()
      return
    }
    const next = e.key === 'ArrowDown'
      ? (idx + 1) % items.length
      : (idx - 1 + items.length) % items.length
    items[next]!.focus()
    e.preventDefault()
  }

  const render = (): void => {
    popover.innerHTML = ''
    const rooms = $rooms.get()
    const selectedId = $selectedRoomId.get()
    const unread = $unreadCounts.get()
    const paused = $pausedRooms.get()
    const generating = $generatingRoomIds.get()

    const ids = Object.keys(rooms)
    if (ids.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'px-3 py-2 text-text-subtle italic'
      empty.textContent = 'No rooms yet'
      popover.appendChild(empty)
    } else {
      for (const id of ids) {
        const room = rooms[id]!
        const row = document.createElement('button')
        row.type = 'button'
        row.dataset.roomRow = ''
        const isCurrent = id === selectedId
        const bg = isCurrent ? 'bg-success-soft-bg' : 'hover:bg-surface-muted'
        row.className = `w-full text-left px-3 py-1.5 flex items-center gap-2 ${bg}`

        const dot = document.createElement('span')
        const dotColor = paused.has(id)
          ? 'bg-text-muted'
          : generating.has(id)
            ? 'bg-thinking typing-indicator'
            : 'bg-success'
        dot.className = `inline-block w-2 h-2 rounded-full shrink-0 ${dotColor}`
        row.appendChild(dot)

        const name = document.createElement('span')
        name.className = 'flex-1 truncate'
        name.textContent = room.name
        row.appendChild(name)

        const count = unread[id] ?? 0
        if (count > 0 && !isCurrent) {
          const badge = document.createElement('span')
          badge.className = 'inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-semibold rounded-full bg-accent text-white'
          badge.textContent = count > 99 ? '99+' : String(count)
          row.appendChild(badge)
        }

        row.onclick = () => {
          $selectedRoomId.set(id)
          close()
        }
        popover.appendChild(row)
      }
    }

    // Separator + Create-new row
    const sep = document.createElement('div')
    sep.className = 'border-t my-1'
    popover.appendChild(sep)

    const create = document.createElement('button')
    create.type = 'button'
    create.dataset.roomRow = ''
    create.className = 'w-full text-left px-3 py-1.5 flex items-center gap-2 text-success font-medium hover:bg-success-soft-bg'
    create.innerHTML = '<span data-icon="plus" data-icon-size="14"></span><span>Create new room</span>'
    create.onclick = () => {
      close()
      openCreateRoomModal()
    }
    popover.appendChild(create)

    // Resolve any data-icon placeholders that just got injected.
    void import('../icon.ts').then(m => m.hydrateIconPlaceholders(popover))
  }

  // Open / toggle.
  button.onclick = (e) => {
    e.stopPropagation()
    const open = !popover.classList.contains('hidden')
    if (open) {
      close()
      return
    }
    render()
    popover.classList.remove('hidden')
    button.setAttribute('aria-expanded', 'true')
    setTimeout(() => {
      document.addEventListener('click', offClick, true)
      document.addEventListener('keydown', onKey, true)
      popover.querySelector<HTMLElement>('[data-room-row]')?.focus()
    }, 0)
  }

  // Re-render on any relevant store change (only matters while open).
  const $view = batched(
    [$rooms, $selectedRoomId, $unreadCounts, $pausedRooms, $generatingRoomIds],
    () => Date.now(),
  )
  $view.subscribe(() => {
    if (!popover.classList.contains('hidden')) render()
  })
}
