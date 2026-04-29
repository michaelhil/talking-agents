// ============================================================================
// Room members — the chip row at the top of the room page.
//
// Shows agents currently in the selected room as chips (emoji + name +
// hover-revealed mute/remove). An "Add" button opens a picker listing
// eligible agents plus a "Create new agent…" shortcut. The create
// flow auto-adds the new agent to the originating room via a short-lived
// pending map, with a toast on success.
// ============================================================================

import { $agentListView, $agents, $selectedHumanByRoom, type AgentEntry } from './stores.ts'
import { showToast } from './toast.ts'
import { roomIdToName } from './identity-lookups.ts'
import { icon } from './icon.ts'

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
  const wrapper = container.parentElement ?? container
  $agentListView.subscribe(({ agents, mutedAgents, selectedRoomId, roomMemberIds, deliveryMode }) => {
    if (!selectedRoomId) {
      wrapper.classList.add('hidden')
      container.innerHTML = ''
      return
    }
    wrapper.classList.remove('hidden')
    const selectedHumanId = $selectedHumanByRoom.get()[selectedRoomId] ?? null
    render(container, {
      agents,
      mutedAgentIds: mutedAgents,
      memberIds: roomMemberIds,
      selectedRoomId,
      selectedHumanId,
      deliveryMode,
      send,
      openCreateAgentModal,
      inspectAgent,
    })
  })

  // Re-render when the per-room human selection changes — the chip's
  // dot inner-border reflects the selected human only.
  $selectedHumanByRoom.subscribe(() => {
    const view = $agentListView.get()
    if (!view.selectedRoomId) return
    const selectedHumanId = $selectedHumanByRoom.get()[view.selectedRoomId] ?? null
    render(container, {
      agents: view.agents,
      mutedAgentIds: view.mutedAgents,
      memberIds: view.roomMemberIds,
      selectedRoomId: view.selectedRoomId,
      selectedHumanId,
      deliveryMode: view.deliveryMode,
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
  readonly selectedHumanId: string | null   // per-room poster (humans only)
  readonly deliveryMode: string
  readonly send: (data: unknown) => void
  readonly openCreateAgentModal: () => void
  readonly inspectAgent: (agentId: string) => void
}

const render = (container: HTMLElement, opts: RenderOpts): void => {
  container.innerHTML = ''

  const roomName = roomIdToName(opts.selectedRoomId)
  if (!roomName) return

  const isManual = opts.deliveryMode === 'manual'

  for (const agentId of opts.memberIds) {
    const agent = opts.agents[agentId]
    if (!agent) continue
    const isGenerating = agent.state === 'generating'
    const isSelected = agent.id === opts.selectedHumanId
    container.appendChild(renderChip(agent, opts.mutedAgentIds.has(agentId), isGenerating, isManual, isSelected, opts.selectedRoomId, roomName, opts.send, opts.inspectAgent))
  }

  container.appendChild(renderAddButton(opts, roomName))
}

const renderChip = (
  agent: AgentEntry,
  isMuted: boolean,
  isGenerating: boolean,
  isManualMode: boolean,
  isSelected: boolean,             // human selected as current poster (humans only)
  roomId: string,
  roomName: string,
  send: (data: unknown) => void,
  inspectAgent: (agentId: string) => void,
): HTMLElement => {
  const chip = document.createElement('span')
  const bg = isMuted ? 'bg-surface-strong text-text-subtle' : 'bg-surface-muted text-accent'
  chip.className = `inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${bg} group/chip`

  const isHuman = agent.kind === 'human'

  // Dot. For humans: green (default) or green with inner accent ring (selected).
  //   - Click toggles per-room selection; existing entry deselects.
  //   - We DON'T set bg-text-muted for humans (no human mute concept).
  // For AI: existing bg-text-muted on mute, click toggles set_muted.
  const dot = document.createElement('button')
  let dotColor: string
  if (isHuman) {
    dotColor = isGenerating ? 'bg-thinking typing-indicator' : 'bg-success'
  } else {
    dotColor = isMuted ? 'bg-text-muted'
      : isGenerating ? 'bg-thinking typing-indicator'
      : 'bg-success'
  }
  dot.className = `inline-block w-2 h-2 rounded-full shrink-0 cursor-pointer ${dotColor}`
  // Inner border for selected humans — inset box-shadow keeps dot size unchanged.
  if (isHuman && isSelected) {
    dot.style.boxShadow = 'inset 0 0 0 1px var(--accent, currentColor)'
    dot.style.outline = '1px solid var(--accent, currentColor)'
    dot.style.outlineOffset = '-2px'
  }
  if (isHuman) {
    dot.title = isSelected ? `Deselect ${agent.name}` : `Post as ${agent.name}`
    dot.onclick = (e) => {
      e.stopPropagation()
      const map = $selectedHumanByRoom.get()
      if (map[roomId] === agent.id) {
        // Deselect: remove key.
        const next = { ...map }; delete next[roomId]
        $selectedHumanByRoom.set(next)
      } else {
        $selectedHumanByRoom.setKey(roomId, agent.id)
      }
    }
  } else {
    dot.title = isMuted ? `Unmute ${agent.name}` : `Mute ${agent.name}`
    dot.onclick = (e) => {
      e.stopPropagation()
      send({ type: 'set_muted', roomName, agentName: agent.name, muted: !isMuted })
    }
  }
  chip.appendChild(dot)

  const name = document.createElement('span')
  // Strikethrough only for AI mute. Humans have no mute, so always solid.
  const nameStyle = (!isHuman && isMuted) ? 'line-through' : ''
  name.className = `font-medium cursor-pointer hover:underline ${nameStyle}`
  name.textContent = agent.name
  name.title = `Inspect ${agent.name}`
  name.onclick = (e) => { e.stopPropagation(); inspectAgent(agent.id) }
  chip.appendChild(name)

  const kindIcon = icon(agent.kind === 'ai' ? 'cpu' : 'user', { size: 12 })
  kindIcon.classList.add('shrink-0', 'text-text-subtle')
  chip.appendChild(kindIcon)

  // In manual mode, show a ▶ on AI agent chips (hidden when muted). Click
  // fires activate_agent — the server catches the agent up on missed
  // messages and triggers one evaluation.
  if (isManualMode && agent.kind === 'ai' && !isMuted) {
    const activateBtn = document.createElement('button')
    const disabled = isGenerating
    activateBtn.className = `text-xs px-1 ${disabled ? 'text-border-strong cursor-not-allowed' : 'text-emerald-500 hover:text-emerald-700'}`
    activateBtn.textContent = '▶'
    activateBtn.title = disabled ? `${agent.name} is generating` : `Activate ${agent.name} for one turn`
    activateBtn.disabled = disabled
    activateBtn.onclick = (e) => {
      e.stopPropagation()
      if (disabled) return
      send({ type: 'activate_agent', roomName, agentName: agent.name })
    }
    chip.appendChild(activateBtn)
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
  // inline-flex avoids the baseline whitespace that inline-block adds and
  // lets the parent `#room-members` items-center flex-align the wrap with
  // the sibling chips.
  wrap.className = 'relative inline-flex items-center'

  const btn = document.createElement('button')
  // Match the chip's box: same inline-flex centring, same px-2/py-0.5,
  // explicit h-5 to align with the chip's intrinsic height (20 px) so the
  // row reads as a single unbroken band of equal-height pills.
  btn.className = 'inline-flex items-center justify-center h-5 w-5 text-xs border border-dashed border-border-strong text-text-subtle rounded leading-none hover:border-blue-400 hover:text-accent-hover'
  btn.textContent = '＋'
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
  picker.className = 'absolute z-30 mt-1 bg-surface border rounded shadow-lg py-1 text-xs min-w-[180px]'

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
  createRow.className = 'px-3 py-1 cursor-pointer hover:bg-success-soft-bg text-success font-medium'
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
    empty.className = 'px-3 py-1 text-text-muted italic'
    empty.textContent = 'All existing agents are in this room'
    picker.appendChild(empty)
  } else {
    for (const agent of eligible) {
      const row = document.createElement('div')
      row.className = 'px-3 py-1 cursor-pointer hover:bg-surface-muted flex items-center gap-1.5'
      const kindIcon2 = icon(agent.kind === 'ai' ? 'cpu' : 'user', { size: 12 })
      kindIcon2.classList.add('shrink-0', 'text-text-subtle')
      const name = document.createElement('span')
      name.textContent = agent.name
      row.appendChild(kindIcon2)
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
