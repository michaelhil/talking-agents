// ============================================================================
// Triggers panel — three modals stacked from the room header's clock icon.
//
// Modal A: per-room agent picker → opens Modal B for the chosen agent.
// Modal B: per-agent trigger list scoped to the current room → opens Modal C.
// Modal C: form for create or edit (one shape, mode toggled by `existing?`).
//
// Server APIs in src/api/routes/triggers.ts. Re-renders on triggers_changed
// WS event AND directly after a successful save (belt + suspenders for
// disconnected WS).
// ============================================================================

import { showToast } from './toast.ts'
import { createModal, createInput, createButtonRow, createTextarea, setButtonPending } from './detail-modal.ts'
import { icon } from './icon.ts'
import type { Trigger, TriggerMode } from '../../core/triggers/types.ts'

// Mirrors src/core/triggers/types.ts — keep in sync if server bounds change.
// Value-imports from core/ aren't reachable from the UI dev server (only
// the modules/ tree is served), so we re-declare the constants + a
// pre-flight validator here. Server is still authoritative — this is only
// a UX convenience to avoid round-trips on obvious errors.
const MIN_INTERVAL_SEC = 60
const MAX_INTERVAL_SEC = 86400

const validateTriggerInput = (input: Record<string, unknown>, agentKind: 'ai' | 'human'): string | null => {
  if (typeof input.name !== 'string' || input.name.trim() === '') return 'name is required'
  if (typeof input.prompt !== 'string' || input.prompt.trim() === '') return 'prompt is required'
  if (typeof input.roomId !== 'string' || input.roomId.trim() === '') return 'roomId is required'
  if (typeof input.intervalSec !== 'number' || !Number.isFinite(input.intervalSec)) return 'intervalSec must be a number'
  if (input.intervalSec < MIN_INTERVAL_SEC || input.intervalSec > MAX_INTERVAL_SEC) {
    return `intervalSec must be between ${MIN_INTERVAL_SEC} and ${MAX_INTERVAL_SEC}`
  }
  if (input.mode !== 'execute' && input.mode !== 'post') return `mode must be 'execute' or 'post'`
  if (agentKind === 'human' && input.mode === 'execute') return `human agents cannot use mode 'execute'`
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') return 'enabled must be a boolean'
  return null
}

interface AgentRow { id: string; name: string; kind: 'ai' | 'human'; triggerCount: number }
interface RoomCtx { id: string; name: string }

const fetchTriggers = async (agentName: string): Promise<Trigger[]> => {
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(agentName)}/triggers`)
    if (!res.ok) return []
    const data = await res.json() as { triggers?: Trigger[] }
    return data.triggers ?? []
  } catch { return [] }
}

const fetchRoomAgents = async (roomName: string): Promise<AgentRow[]> => {
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(roomName)}/members`)
    if (!res.ok) return []
    const members = await res.json() as ReadonlyArray<{ id: string; name: string; kind?: 'ai' | 'human' }>
    // Each member needs its trigger count for this room — one fetch each.
    // Filter to known kinds only (defensive against the route's fallback shape).
    const rows = await Promise.all(members
      .filter((m): m is { id: string; name: string; kind: 'ai' | 'human' } => m.kind === 'ai' || m.kind === 'human')
      .map(async (m) => {
        const triggers = await fetchTriggers(m.name)
        return { id: m.id, name: m.name, kind: m.kind, triggerCount: triggers.length }
      }))
    return rows
  } catch { return [] }
}

// Format intervalSec as a friendly "every Nm" / "every Nh" string for the row.
const formatInterval = (sec: number): string => {
  if (sec % 3600 === 0) return `every ${sec / 3600}h`
  if (sec % 60 === 0) return `every ${sec / 60}m`
  return `every ${sec}s`
}

// ============================================================================
// Modal C — form (create or edit)
// ============================================================================
export const openTriggerForm = async (
  agentName: string,
  agentKind: 'ai' | 'human',
  room: RoomCtx,
  existing: Trigger | undefined,
  onSaved: () => Promise<void>,
): Promise<void> => {
  const isEdit = existing !== undefined
  const modal = createModal({
    title: isEdit ? `Edit trigger — ${existing!.name}` : `New trigger for ${agentName}`,
    width: 'max-w-md',
  })
  document.body.appendChild(modal.overlay)

  const body = modal.scrollBody
  body.className = 'px-6 py-4 overflow-y-auto min-h-0 flex-1 space-y-3'

  // --- Name ---
  const nameLabel = document.createElement('label')
  nameLabel.className = 'block text-xs text-text-muted'
  nameLabel.textContent = 'Name'
  const nameInput = createInput({ value: existing?.name ?? '', placeholder: 'Check vatsim status' })
  body.appendChild(nameLabel); body.appendChild(nameInput)

  // --- Prompt ---
  const promptLabel = document.createElement('label')
  promptLabel.className = 'block text-xs text-text-muted mt-3'
  promptLabel.textContent = 'Prompt'
  const promptTextarea = createTextarea(existing?.prompt ?? '', 5)
  body.appendChild(promptLabel); body.appendChild(promptTextarea)

  // --- Mode (AI only — humans always 'post') ---
  let modeValue: TriggerMode = existing?.mode ?? (agentKind === 'human' ? 'post' : 'execute')
  if (agentKind === 'ai') {
    const modeLabel = document.createElement('label')
    modeLabel.className = 'block text-xs text-text-muted mt-3'
    modeLabel.textContent = 'Mode'
    const modeWrap = document.createElement('div')
    modeWrap.className = 'flex flex-col gap-1 text-xs'
    const mkRadio = (val: TriggerMode, label: string, hint: string): HTMLLabelElement => {
      const w = document.createElement('label')
      w.className = 'flex items-start gap-2 cursor-pointer'
      const input = document.createElement('input')
      input.type = 'radio'
      input.name = 'trigger-mode'
      input.value = val
      input.checked = modeValue === val
      input.className = 'mt-0.5 cursor-pointer'
      input.onchange = () => { if (input.checked) modeValue = val }
      const text = document.createElement('div')
      text.innerHTML = `<div class="font-medium">${label}</div><div class="text-text-muted">${hint}</div>`
      w.appendChild(input); w.appendChild(text)
      return w
    }
    modeWrap.appendChild(mkRadio('execute', 'Execute', 'Run the prompt internally; post the response. Tools and skills work as normal.'))
    modeWrap.appendChild(mkRadio('post', 'Post', 'Post the prompt verbatim into the room as if the agent typed it. Triggers other agents to respond.'))
    body.appendChild(modeLabel); body.appendChild(modeWrap)
  } else {
    const hint = document.createElement('div')
    hint.className = 'text-[11px] text-text-muted'
    hint.textContent = 'Mode: Post (human agents post the prompt verbatim into the room).'
    body.appendChild(hint)
  }

  // --- Interval ---
  const intervalLabel = document.createElement('label')
  intervalLabel.className = 'block text-xs text-text-muted mt-3'
  intervalLabel.textContent = 'Interval'
  const intervalRow = document.createElement('div')
  intervalRow.className = 'flex items-center gap-2'
  const initialSec = existing?.intervalSec ?? 300
  const initialUnit: 'minutes' | 'hours' = initialSec % 3600 === 0 && initialSec >= 3600 ? 'hours' : 'minutes'
  const initialValue = initialUnit === 'hours' ? Math.floor(initialSec / 3600) : Math.floor(initialSec / 60)
  const numInput = createInput({ type: 'number', value: String(initialValue), className: 'w-24' })
  numInput.min = '1'
  const unitSelect = document.createElement('select')
  unitSelect.className = 'input'
  for (const u of ['minutes', 'hours']) {
    const opt = document.createElement('option')
    opt.value = u; opt.textContent = u
    if (u === initialUnit) opt.selected = true
    unitSelect.appendChild(opt)
  }
  intervalRow.appendChild(numInput); intervalRow.appendChild(unitSelect)
  body.appendChild(intervalLabel); body.appendChild(intervalRow)
  const intervalHint = document.createElement('div')
  intervalHint.className = 'text-[11px] text-text-muted'
  intervalHint.textContent = `Min ${MIN_INTERVAL_SEC}s · Max ${MAX_INTERVAL_SEC}s (${MAX_INTERVAL_SEC / 3600}h).`
  body.appendChild(intervalHint)

  // --- Enabled ---
  const enabledRow = document.createElement('label')
  enabledRow.className = 'flex items-center gap-2 mt-3 cursor-pointer text-xs'
  const enabledInput = document.createElement('input')
  enabledInput.type = 'checkbox'
  enabledInput.checked = existing?.enabled ?? true
  enabledInput.className = 'cursor-pointer'
  enabledRow.appendChild(enabledInput)
  const enabledText = document.createElement('span')
  enabledText.textContent = 'Enabled'
  enabledRow.appendChild(enabledText)
  body.appendChild(enabledRow)

  // --- Footer ---
  const errLine = document.createElement('div')
  errLine.className = 'text-xs text-red-500 mb-2'
  errLine.style.display = 'none'
  modal.footer.appendChild(errLine)

  const buttons = createButtonRow(
    () => modal.close(),
    async () => {
      const name = nameInput.value.trim()
      const prompt = promptTextarea.value.trim()
      const num = Number(numInput.value)
      const unit = unitSelect.value as 'minutes' | 'hours'
      const intervalSec = unit === 'hours' ? num * 3600 : num * 60

      const merged = { name, prompt, mode: modeValue, intervalSec, enabled: enabledInput.checked, roomId: room.id }
      const err = validateTriggerInput(merged as Record<string, unknown>, agentKind)
      if (err) {
        errLine.textContent = err
        errLine.style.display = 'block'
        return
      }
      errLine.style.display = 'none'

      const saveBtn = buttons.querySelector<HTMLButtonElement>('button:last-child')!
      setButtonPending(saveBtn, true)
      try {
        const url = isEdit
          ? `/api/agents/${encodeURIComponent(agentName)}/triggers/${encodeURIComponent(existing!.id)}`
          : `/api/agents/${encodeURIComponent(agentName)}/triggers`
        const method = isEdit ? 'PUT' : 'POST'
        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(merged),
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string }
          errLine.textContent = `Save failed: ${data.error ?? `HTTP ${res.status}`}`
          errLine.style.display = 'block'
          setButtonPending(saveBtn, false)
          return
        }
        showToast(document.body, `Saved trigger`, { type: 'success', position: 'fixed' })
        modal.close()
        await onSaved()
      } catch (e) {
        errLine.textContent = `Save failed: ${e instanceof Error ? e.message : String(e)}`
        errLine.style.display = 'block'
        setButtonPending(saveBtn, false)
      }
    },
    isEdit ? 'Save' : 'Create',
  )
  modal.footer.appendChild(buttons)
  const saveBtn = buttons.querySelector<HTMLButtonElement>('button:last-child')!
  saveBtn.className = 'btn btn-primary'

  setTimeout(() => nameInput.focus(), 0)
}

// ============================================================================
// Modal B — per-agent trigger list (scoped to the current room)
// ============================================================================
export const openAgentTriggers = async (
  agentName: string,
  agentKind: 'ai' | 'human',
  room: RoomCtx,
): Promise<void> => {
  const modal = createModal({
    title: `Triggers — ${agentName} in ${room.name}`,
    width: 'max-w-2xl',
  })
  document.body.appendChild(modal.overlay)

  // Add button in the header.
  const addBtn = document.createElement('button')
  addBtn.type = 'button'
  addBtn.className = 'btn btn-ghost mr-2'
  addBtn.title = 'Add trigger'
  addBtn.appendChild(icon('plus', { size: 12 }))
  const addLabel = document.createElement('span'); addLabel.textContent = 'Add'
  addBtn.appendChild(addLabel)
  addBtn.onclick = async () => {
    await openTriggerForm(agentName, agentKind, room, undefined, async () => { await render() })
  }
  modal.header.appendChild(addBtn)

  const listEl = document.createElement('div')
  listEl.className = '-mx-6 -my-4'
  modal.scrollBody.appendChild(listEl)

  const render = async (): Promise<void> => {
    listEl.innerHTML = '<div class="text-xs text-text-muted px-3 py-2 italic">Loading…</div>'
    const all = await fetchTriggers(agentName)
    const scoped = all.filter(t => t.roomId === room.id)
    listEl.innerHTML = ''
    if (scoped.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'text-xs text-text-muted px-3 py-3 italic'
      empty.textContent = `No triggers for ${agentName} in this room. Use + to add one.`
      listEl.appendChild(empty)
      return
    }
    for (const t of scoped) {
      const row = document.createElement('div')
      row.className = 'px-3 py-2 text-xs border-b border-border'
      const modeBadge = `<span class="ml-2 text-[10px] uppercase tracking-wide text-text-subtle">${t.mode}</span>`
      const enabledBadge = t.enabled
        ? '<span class="text-text-muted">enabled</span>'
        : '<span class="text-amber-500">disabled</span>'
      row.innerHTML = `
        <div class="flex items-center gap-2" data-rowmain>
          <div class="flex-1 min-w-0">
            <div class="font-medium truncate">${escapeHtml(t.name)}${modeBadge}</div>
            <div class="text-text-muted truncate">${escapeHtml(t.prompt)}</div>
            <div class="text-text-muted">${formatInterval(t.intervalSec)} · ${enabledBadge}</div>
          </div>
        </div>
      `
      const rowMain = row.querySelector<HTMLElement>('[data-rowmain]')!
      const mkBtn = (iconName: 'settings' | 'x', title: string, danger = false): HTMLButtonElement => {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = `px-2 py-1 ${danger ? 'text-red-500' : 'text-text'} hover:bg-surface-muted rounded interactive`
        b.title = title
        b.setAttribute('aria-label', title)
        b.appendChild(icon(iconName, { size: 14 }))
        return b
      }
      const editBtn = mkBtn('settings', 'Edit')
      editBtn.onclick = async () => {
        await openTriggerForm(agentName, agentKind, room, t, async () => { await render() })
      }
      rowMain.appendChild(editBtn)
      const delBtn = mkBtn('x', 'Delete', true)
      delBtn.onclick = async () => {
        if (!confirm(`Delete trigger "${t.name}"?`)) return
        const res = await fetch(`/api/agents/${encodeURIComponent(agentName)}/triggers/${encodeURIComponent(t.id)}`, { method: 'DELETE' })
        if (res.ok) {
          showToast(document.body, 'Trigger deleted', { type: 'success', position: 'fixed' })
          await render()
        } else {
          showToast(document.body, 'Delete failed', { type: 'error', position: 'fixed' })
        }
      }
      rowMain.appendChild(delBtn)
      listEl.appendChild(row)
    }
  }

  await render()

  // Re-render on WS triggers_changed.
  const listener = (): void => { if (listEl.isConnected) void render() }
  window.addEventListener('triggers-changed', listener)
  const observer = new MutationObserver(() => {
    if (!modal.overlay.isConnected) {
      window.removeEventListener('triggers-changed', listener)
      observer.disconnect()
    }
  })
  observer.observe(document.body, { childList: true })
}

// ============================================================================
// Modal A — entry: list of room's agents with trigger counts
// ============================================================================
export const openTriggersModal = async (room: RoomCtx): Promise<void> => {
  const modal = createModal({ title: `Triggers — ${room.name}`, width: 'max-w-lg' })
  document.body.appendChild(modal.overlay)

  const listEl = document.createElement('div')
  listEl.className = '-mx-6 -my-4'
  modal.scrollBody.appendChild(listEl)

  const render = async (): Promise<void> => {
    listEl.innerHTML = '<div class="text-xs text-text-muted px-3 py-2 italic">Loading…</div>'
    const agents = await fetchRoomAgents(room.name)
    listEl.innerHTML = ''
    if (agents.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'text-xs text-text-muted px-3 py-3 italic'
      empty.textContent = 'No agents in this room. Add agents from the sidebar to configure their triggers.'
      listEl.appendChild(empty)
      return
    }
    const hint = document.createElement('div')
    hint.className = 'text-[11px] text-text-muted px-3 py-2 italic'
    hint.textContent = 'Pick an agent to configure scheduled prompts that fire in this room.'
    listEl.appendChild(hint)

    for (const a of agents) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'w-full text-left px-3 py-2 text-xs border-b border-border hover:bg-surface-muted interactive flex items-center gap-2'
      row.innerHTML = `
        <div class="flex-1 min-w-0">
          <div class="font-medium truncate">${escapeHtml(a.name)} <span class="text-text-muted">(${a.kind})</span></div>
          <div class="text-text-muted">${a.triggerCount} trigger${a.triggerCount === 1 ? '' : 's'} in this room</div>
        </div>
        <span class="text-text-subtle">›</span>
      `
      row.onclick = async () => {
        modal.close()
        await openAgentTriggers(a.name, a.kind, room)
      }
      listEl.appendChild(row)
    }
  }

  await render()

  const listener = (): void => { if (listEl.isConnected) void render() }
  window.addEventListener('triggers-changed', listener)
  const observer = new MutationObserver(() => {
    if (!modal.overlay.isConnected) {
      window.removeEventListener('triggers-changed', listener)
      observer.disconnect()
    }
  })
  observer.observe(document.body, { childList: true })
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c))
