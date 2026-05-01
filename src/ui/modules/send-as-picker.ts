// Send-as picker — opens when the user submits a message in a room with no
// poster selected and more than one human candidate. Lists humans (in-room
// first, then others); selecting one sets the per-room poster and re-fires
// the post. If no humans exist anywhere, falls through to createHumanInline.

import { $agents, $agentListView, $selectedHumanByRoom, type AgentInfo } from './stores.ts'
import { roomIdToName } from './identity-lookups.ts'
import { send } from './ws-send.ts'
import { showToast } from './toast.ts'

export interface SendAsPickerDeps {
  readonly chatInput: HTMLTextAreaElement | HTMLInputElement
  readonly resetChatInputHeight: () => void
}

// Quick "create human" path used when no humans exist anywhere. Inline
// prompt → POST /api/agents/human → add to current room → select → re-send.
export const createHumanInline = async (
  roomId: string,
  content: string,
  deps: SendAsPickerDeps,
): Promise<void> => {
  const name = window.prompt('Name for the new human:')?.trim()
  if (!name) return
  const roomName = roomIdToName(roomId)
  if (!roomName) return
  try {
    const res = await fetch('/api/agents/human', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, roomName }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string }
      showToast(document.body, data.error ?? `Create failed (${res.status})`, { type: 'error', position: 'fixed' })
      return
    }
    const { id } = await res.json() as { id: string }
    $selectedHumanByRoom.setKey(roomId, id)
    if (content) {
      send({ type: 'post_message', target: { rooms: [roomName] }, content, senderId: id })
      deps.chatInput.value = ''
      deps.resetChatInputHeight()
    }
  } catch {
    showToast(document.body, 'Create failed', { type: 'error', position: 'fixed' })
  }
}

export const openSendAsPicker = async (
  roomId: string,
  content: string,
  deps: SendAsPickerDeps,
): Promise<void> => {
  const allAgents = Object.values($agents.get())
  const humans = allAgents.filter(a => a.kind === 'human')
  const memberSet = new Set($agentListView.get().roomMemberIds)
  const roomName = roomIdToName(roomId)
  if (!roomName) return

  if (humans.length === 0) {
    await createHumanInline(roomId, content, deps)
    return
  }

  const overlay = document.createElement('div')
  overlay.className = 'fixed inset-0 flex items-center justify-center z-50 p-4'
  overlay.style.background = 'var(--shadow-overlay)'
  const card = document.createElement('div')
  card.className = 'rounded-lg shadow-xl w-full max-w-md bg-surface text-text overflow-hidden'
  const header = document.createElement('div')
  header.className = 'px-6 py-3 border-b border-border'
  header.innerHTML = `<h3 class="text-base font-semibold">Post as…</h3><div class="text-xs text-text-muted mt-1">Pick a human to attribute this message to in <strong>${roomName}</strong>.</div>`
  card.appendChild(header)

  const body = document.createElement('div')
  body.className = 'px-6 py-3 max-h-[60vh] overflow-y-auto'
  const inRoom = humans.filter(h => memberSet.has(h.id))
  const elsewhere = humans.filter(h => !memberSet.has(h.id))

  const close = (): void => overlay.remove()
  overlay.onclick = (e) => { if (e.target === overlay) close() }
  const onEsc = (e: KeyboardEvent): void => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc) } }
  document.addEventListener('keydown', onEsc)

  const buildRow = (h: AgentInfo, needsAdd: boolean): HTMLElement => {
    const row = document.createElement('div')
    row.className = 'py-2 flex items-center gap-2 border-b border-border last:border-b-0 cursor-pointer hover:bg-surface-muted px-2 -mx-2 rounded'
    row.innerHTML = `<span class="font-medium flex-1">${h.name}</span><span class="text-[10px] uppercase tracking-wide text-text-subtle">${needsAdd ? 'add to room' : 'in room'}</span>`
    row.onclick = () => {
      if (needsAdd) {
        if (!confirm(`Add ${h.name} to ${roomName}?`)) return
        send({ type: 'add_to_room', roomName, agentName: h.name })
      }
      $selectedHumanByRoom.setKey(roomId, h.id)
      send({ type: 'post_message', target: { rooms: [roomName] }, content, senderId: h.id })
      deps.chatInput.value = ''
      deps.resetChatInputHeight()
      close()
    }
    return row
  }
  for (const h of inRoom) body.appendChild(buildRow(h, false))
  for (const h of elsewhere) body.appendChild(buildRow(h, true))

  const footer = document.createElement('div')
  footer.className = 'px-6 py-3 border-t border-border flex justify-between gap-2'
  const newBtn = document.createElement('button')
  newBtn.className = 'px-3 py-1 text-xs border border-border-strong rounded hover:bg-surface-muted'
  newBtn.textContent = '+ New human'
  newBtn.onclick = async () => { close(); await createHumanInline(roomId, content, deps) }
  const cancel = document.createElement('button')
  cancel.className = 'px-3 py-1 text-xs text-text-muted'
  cancel.textContent = 'Cancel'
  cancel.onclick = close
  footer.appendChild(newBtn)
  footer.appendChild(cancel)
  card.appendChild(body)
  card.appendChild(footer)
  overlay.appendChild(card)
  document.body.appendChild(overlay)
}
