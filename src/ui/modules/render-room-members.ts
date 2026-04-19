// ============================================================================
// Room members — the chip row at the top of the room page.
//
// Shows agents currently in the selected room as chips (emoji + name +
// hover-revealed mute/remove). An "Add" button opens a picker listing
// eligible agents plus a "Create new agent…" shortcut. The create-flow
// auto-adds the new agent to the originating room via a short-lived
// pending map, with a toast on success.
// ============================================================================

import { $agentListView, $agents, type AgentEntry } from './stores.ts'
import { showToast, roomIdToName } from './ui-utils.ts'

// --- Pending create-then-add state ---

interface PendingAdd { readonly roomName: string; readonly at: number }
const pendingCreateAdds = new Map<string, PendingAdd>()  // agentName → roomName
const PENDING_TTL_MS = 10_000

// One-shot auto-add room for the next agent-modal submission.
let autoAddRoomOnNextCreate: string | null = null

/** Consumed by app.ts agentForm.onsubmit to learn if the create was
 *  initiated from a room-members picker. Clears on read. */
export const consumeAutoAddRoom = (): string | null => {
  const r = autoAddRoomOnNextCreate
  autoAddRoomOnNextCreate = null
  return r
}

/** Called by app.ts once the create request is about to fire, so that
 *  the subsequent agent_joined event triggers add_to_room. */
export const registerPendingCreateAdd = (agentName: string, roomName: string): void => {
  pendingCreateAdds.set(agentName, { roomName, at: Date.now() })
}

/** Cleared when the agent-modal is dismissed without submitting — prevents
 *  a stale auto-add from bleeding into the next create flow. */
export const clearAutoAddRoom = (): void => { autoAddRoomOnNextCreate = null }

// --- Module init ---

export interface RoomMembersDeps {
  readonly container: HTMLElement
  readonly send: (data: unknown) => void
  readonly openCreateAgentModal: () => void
  readonly inspectAgent: (agentId: string) => void
}

export const mountRoomMembers = (deps: RoomMembersDeps): void => {
  const { container, send, openCreateAgentModal, inspectAgent } = deps

  // --- Track known agent IDs so we can detect new ones ---
  let knownAgentIds = new Set(Object.keys($agents.get()))

  $agents.listen((agents) => {
    // Prune expired pending entries first.
    const now = Date.now()
    for (const [name, entry] of pendingCreateAdds) {
      if (now - entry.at > PENDING_TTL_MS) pendingCreateAdds.delete(name)
    }

    // Detect newly added agents by id; if any pending map keyed by name
    // matches, fire add_to_room and toast.
    for (const [id, a] of Object.entries(agents)) {
      if (knownAgentIds.has(id)) continue
      const pending = pendingCreateAdds.get(a.name)
      if (pending) {
        pendingCreateAdds.delete(a.name)
        send({ type: 'add_to_room', roomName: pending.roomName, agentName: a.name })
        showToast(document.body, `Added ${a.name} to ${pending.roomName}`, { type: 'success', position: 'fixed' })
      }
    }
    knownAgentIds = new Set(Object.keys(agents))
  })

  // --- Render on any relevant state change ---
  $agentListView.subscribe(({ agents, mutedAgents, selectedRoomId, roomMemberIds }) => {
    if (!selectedRoomId) {
      container.classList.add('hidden')
      container.innerHTML = ''
      return
    }
    container.classList.remove('hidden')
    render(container, {
      agents,
      mutedAgentIds: mutedAgents,
      memberIds: roomMemberIds,
      selectedRoomId,
      send,
      openCreateAgentModal,
      inspectAgent,
    })
  })
}

// --- Rendering ---

interface RenderOpts {
  readonly agents: Record<string, AgentEntry>
  readonly mutedAgentIds: Set<string>
  readonly memberIds: ReadonlyArray<string>
  readonly selectedRoomId: string
  readonly send: (data: unknown) => void
  readonly openCreateAgentModal: () => void
  readonly inspectAgent: (agentId: string) => void
}

const render = (container: HTMLElement, opts: RenderOpts): void => {
  container.innerHTML = ''

  const roomName = roomIdToName(opts.selectedRoomId)
  if (!roomName) return

  for (const agentId of opts.memberIds) {
    const agent = opts.agents[agentId]
    if (!agent) continue
    container.appendChild(renderChip(agent, opts.mutedAgentIds.has(agentId), roomName, opts.send, opts.inspectAgent))
  }

  container.appendChild(renderAddButton(opts, roomName))
}

const renderChip = (
  agent: AgentEntry,
  isMuted: boolean,
  roomName: string,
  send: (data: unknown) => void,
  inspectAgent: (agentId: string) => void,
): HTMLElement => {
  const chip = document.createElement('span')
  const bg = isMuted ? 'bg-gray-100 text-gray-500' : 'bg-blue-50 text-blue-700'
  chip.className = `inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${bg} group/chip`

  const emoji = document.createElement('span')
  emoji.textContent = agent.kind === 'ai' ? '🤖' : '🧠'
  chip.appendChild(emoji)

  const name = document.createElement('span')
  name.className = 'font-medium cursor-pointer hover:underline'
  name.textContent = agent.name
  name.title = `Inspect ${agent.name}`
  name.onclick = (e) => { e.stopPropagation(); inspectAgent(agent.id) }
  chip.appendChild(name)

  if (agent.kind === 'ai') {
    const muteBtn = document.createElement('button')
    // Muted: always visible (state must be legible at rest). Unmuted: hover-reveal.
    const visibility = isMuted ? '' : 'opacity-0 group-hover/chip:opacity-100'
    muteBtn.className = `${visibility} text-xs hover:text-amber-600`
    muteBtn.textContent = isMuted ? '🔕' : '🔔'
    muteBtn.title = isMuted ? `Unmute ${agent.name}` : `Mute ${agent.name}`
    muteBtn.onclick = (e) => {
      e.stopPropagation()
      send({ type: 'set_muted', roomName, agentName: agent.name, muted: !isMuted })
    }
    chip.appendChild(muteBtn)
  }

  const removeBtn = document.createElement('button')
  removeBtn.className = 'opacity-0 group-hover/chip:opacity-100 text-orange-400 hover:text-orange-700 text-xs ml-0.5'
  removeBtn.textContent = '×'
  removeBtn.title = `Remove ${agent.name} from room`
  removeBtn.onclick = (e) => {
    e.stopPropagation()
    send({ type: 'remove_from_room', roomName, agentName: agent.name })
  }
  chip.appendChild(removeBtn)

  return chip
}

const renderAddButton = (opts: RenderOpts, roomName: string): HTMLElement => {
  const wrap = document.createElement('div')
  wrap.className = 'relative inline-block'

  const btn = document.createElement('button')
  btn.className = 'px-2 py-0.5 text-xs border border-dashed border-gray-300 text-gray-500 rounded hover:border-blue-400 hover:text-blue-600'
  btn.textContent = '＋ Add'
  btn.title = 'Add an agent to this room'

  btn.onclick = (e) => {
    e.stopPropagation()
    const existing = document.getElementById('room-member-picker')
    if (existing) { existing.remove(); return }
    wrap.appendChild(buildPicker(opts, roomName))
  }

  wrap.appendChild(btn)
  return wrap
}

const buildPicker = (opts: RenderOpts, roomName: string): HTMLElement => {
  const picker = document.createElement('div')
  picker.id = 'room-member-picker'
  picker.className = 'absolute z-30 mt-1 bg-white border rounded shadow-lg py-1 text-xs min-w-[180px]'

  const closePicker = () => picker.remove()
  const offClick = (e: MouseEvent) => {
    if (!picker.contains(e.target as Node)) {
      closePicker()
      document.removeEventListener('click', offClick, true)
    }
  }
  setTimeout(() => document.addEventListener('click', offClick, true), 0)

  // "Create new" entry
  const createRow = document.createElement('div')
  createRow.className = 'px-3 py-1 cursor-pointer hover:bg-green-50 text-green-700 font-medium'
  createRow.textContent = '＋ Create new agent…'
  createRow.onclick = () => {
    autoAddRoomOnNextCreate = roomName
    closePicker()
    opts.openCreateAgentModal()
  }
  picker.appendChild(createRow)

  // Separator
  const sep = document.createElement('div')
  sep.className = 'border-t my-1'
  picker.appendChild(sep)

  // Eligible agents (not already members)
  const memberSet = new Set(opts.memberIds)
  const eligible = Object.values(opts.agents).filter(a => !memberSet.has(a.id))

  if (eligible.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'px-3 py-1 text-gray-400 italic'
    empty.textContent = 'All existing agents are in this room'
    picker.appendChild(empty)
  } else {
    for (const agent of eligible) {
      const row = document.createElement('div')
      row.className = 'px-3 py-1 cursor-pointer hover:bg-blue-50 flex items-center gap-1.5'
      const emoji = document.createElement('span')
      emoji.textContent = agent.kind === 'ai' ? '🤖' : '🧠'
      const name = document.createElement('span')
      name.textContent = agent.name
      row.appendChild(emoji)
      row.appendChild(name)
      row.onclick = () => {
        opts.send({ type: 'add_to_room', roomName, agentName: agent.name })
        closePicker()
      }
      picker.appendChild(row)
    }
  }

  return picker
}
