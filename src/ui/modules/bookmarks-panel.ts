// ============================================================================
// Bookmarks Panel — system-wide message bookmarks dialog.
//
// Opens on demand, fetches /api/bookmarks, renders a scrollable list.
// Row click → sends the bookmark text into the currently selected room (via
// the same `post_message` WS command the message input uses). Pen toggles
// in-line edit (textarea that auto-grows, saves on blur/Enter, Escape cancels,
// edits preserve list position). Red × deletes. Newest entries are on top.
// ============================================================================

import { createModal } from './detail-modal.ts'
import { showToast } from './ui-utils.ts'
import type { WSOutbound } from '../../core/types/ws-protocol.ts'

interface Bookmark {
  readonly id: string
  readonly content: string
}

export interface BookmarksPanelDeps {
  readonly send: (msg: WSOutbound) => void
  readonly getSelectedRoomName: () => string | undefined
}

const fetchBookmarks = async (): Promise<Bookmark[]> => {
  const res = await fetch('/api/bookmarks')
  if (!res.ok) return []
  const data = await res.json() as { bookmarks?: Bookmark[] }
  return data.bookmarks ?? []
}

const putBookmark = async (id: string, content: string): Promise<boolean> => {
  const res = await fetch(`/api/bookmarks/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
  return res.ok
}

const deleteBookmark = async (id: string): Promise<boolean> => {
  const res = await fetch(`/api/bookmarks/${encodeURIComponent(id)}`, { method: 'DELETE' })
  return res.ok
}

// Auto-grow a textarea to fit its content.
const autoGrow = (ta: HTMLTextAreaElement): void => {
  ta.style.height = 'auto'
  ta.style.height = `${ta.scrollHeight}px`
}

const buildRow = (
  bm: Bookmark,
  onSend: (content: string) => void,
  onDelete: (id: string) => void,
  onEdited: (id: string, content: string) => void,
): HTMLDivElement => {
  // Mutable latest content — updated on successful save so subsequent edits
  // see the new text, and click-to-send always uses the latest.
  let currentContent = bm.content

  const row = document.createElement('div')
  row.className = 'flex items-center gap-2 px-2 py-1.5 border-b border-border hover:bg-surface-muted cursor-pointer'
  row.setAttribute('data-bookmark-id', bm.id)

  const textEl = document.createElement('div')
  textEl.className = 'flex-1 min-w-0 text-sm text-text truncate'
  textEl.textContent = currentContent
  textEl.title = currentContent

  const editBtn = document.createElement('button')
  editBtn.className = 'text-text-muted hover:text-accent text-sm px-1'
  editBtn.textContent = '✎'
  editBtn.title = 'Edit'

  const delBtn = document.createElement('button')
  delBtn.className = 'text-text-muted hover:text-danger text-sm px-1'
  delBtn.textContent = '×'
  delBtn.title = 'Delete'

  row.appendChild(textEl)
  row.appendChild(editBtn)
  row.appendChild(delBtn)

  row.onclick = (e) => {
    if (e.target === editBtn || e.target === delBtn) return
    onSend(currentContent)
  }

  delBtn.onclick = (e) => {
    e.stopPropagation()
    onDelete(bm.id)
  }

  editBtn.onclick = (e) => {
    e.stopPropagation()
    // Swap textEl for an auto-growing textarea seeded with the latest content.
    const ta = document.createElement('textarea')
    ta.className = 'flex-1 min-w-0 text-sm text-text border rounded p-1 resize-none focus:outline-none focus:ring-2 focus:ring-accent-ring'
    ta.value = currentContent
    ta.rows = 1
    row.classList.remove('cursor-pointer')
    row.replaceChild(ta, textEl)
    ta.focus()
    autoGrow(ta)
    ta.oninput = () => autoGrow(ta)

    let finished = false
    const commit = async (save: boolean): Promise<void> => {
      if (finished) return
      finished = true
      const next = ta.value.trim()
      const shouldSave = save && next.length > 0 && next !== currentContent
      if (shouldSave) {
        const ok = await putBookmark(bm.id, next)
        if (ok) {
          currentContent = next
          onEdited(bm.id, next)
        } else {
          showToast(document.body, 'Save failed')
        }
      }
      textEl.textContent = currentContent
      textEl.title = currentContent
      if (ta.parentNode === row) row.replaceChild(textEl, ta)
      row.classList.add('cursor-pointer')
    }

    ta.onblur = () => { void commit(true) }
    ta.onkeydown = (ke) => {
      if (ke.key === 'Enter' && !ke.shiftKey) {
        ke.preventDefault()
        void commit(true)
      } else if (ke.key === 'Escape') {
        ke.preventDefault()
        void commit(false)
      }
    }
  }

  return row
}

export const openBookmarksPanel = async (deps: BookmarksPanelDeps): Promise<void> => {
  const modal = createModal({ title: 'Bookmarks', width: 'max-w-4xl' })

  const list = document.createElement('div')
  list.className = 'border rounded max-h-96 overflow-y-auto'

  const empty = document.createElement('div')
  empty.className = 'text-sm text-text-muted text-center py-6'
  empty.textContent = 'No bookmarks yet.'

  const bookmarks = await fetchBookmarks()

  const render = (entries: Bookmark[]): void => {
    list.innerHTML = ''
    if (entries.length === 0) {
      list.appendChild(empty)
      return
    }
    for (const bm of entries) {
      list.appendChild(buildRow(
        bm,
        (content) => {
          const roomName = deps.getSelectedRoomName()
          if (!roomName) {
            showToast(document.body, 'Select a room first')
            return
          }
          deps.send({ type: 'post_message', target: { rooms: [roomName] }, content })
          modal.close()
        },
        async (id) => {
          const ok = await deleteBookmark(id)
          if (!ok) { showToast(document.body, 'Delete failed'); return }
          const next = entries.filter(b => b.id !== id)
          render(next)
        },
        (id, content) => {
          const idx = entries.findIndex(b => b.id === id)
          if (idx >= 0) entries[idx] = { id, content }
        },
      ))
    }
  }

  render(bookmarks.slice())
  modal.scrollBody.appendChild(list)
  document.body.appendChild(modal.overlay)
}
