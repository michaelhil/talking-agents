// ============================================================================
// Shared types + DOM helpers for the four inspector groups (Prompts /
// Context / Tools / Model). Each group imports from this file; the group
// builders themselves live in prompts-group.ts, context-group.ts, etc.
// ============================================================================

// --- Shared types ---

export interface AgentData {
  persona?: string
  tools?: string[]
  rooms?: string[]
}

export interface PreviewSection {
  key: string
  label: string
  text: string
  tokens: number
  enabled: boolean
  optional: boolean
}

export interface ContextPreview {
  roomId: string
  roomName: string
  sections: PreviewSection[]
  modelMax: number
  historyEstimate: { messages: number; chars: number }
  toolTokens: Record<string, number>
  registeredTools: string[]
  // `false` = model is documented to not support function calling; UI shows
  // a warning on the Tools group. `undefined` = unverified, default-allow.
  modelSupportsTools?: boolean
}

// Prompt and context key definitions — ordering drives render order.
export const PROMPT_KEYS = [
  { code: 'persona',        section: 'persona',        label: 'Agent persona' },
  { code: 'room',           section: 'room',           label: 'Room prompt' },
  { code: 'house',          section: 'house',          label: 'System prompt' },
  { code: 'responseFormat', section: 'responseFormat', label: 'Response format' },
  { code: 'skills',         section: 'skills',         label: 'Skills' },
] as const

export const CONTEXT_KEYS = [
  { code: 'participants', section: 'ctx_participants', label: 'Participants list' },
  { code: 'macro',         section: 'ctx_flow',         label: 'Macro section' },
  { code: 'artifacts',    section: 'ctx_artifacts',    label: 'Artifacts' },
  { code: 'activity',     section: 'ctx_activity',     label: 'Activity in other rooms' },
  { code: 'knownAgents',  section: 'ctx_knownAgents',  label: 'Known agents', warning: 'breaks [[Name]] mentions' },
] as const

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export const sectionByKey = (p: ContextPreview, key: string): PreviewSection | undefined =>
  p.sections.find(s => s.key === key)

// --- Builder deps ---

export interface GroupDeps {
  readonly preview: ContextPreview
  readonly agentData: AgentData & Record<string, unknown>
  readonly promptTextarea: HTMLTextAreaElement
  readonly patchAgent: (patch: Record<string, unknown>) => Promise<void>
  readonly rerender: () => Promise<void>
}

// --- Shared DOM helpers ---

export const mkGlass = (label: string, onPreview: () => void | Promise<void>): HTMLButtonElement => {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'text-text-muted hover:text-accent'
  b.setAttribute('aria-label', `Preview ${label}`)
  b.textContent = '🔍'
  b.onclick = (e) => { e.preventDefault(); void onPreview() }
  return b
}

// Flip a group's greyed/disabled state. Called when the master checkbox flips.
export const applyGroupDisabled = (groupEl: HTMLElement, disabled: boolean): void => {
  groupEl.classList.toggle('opacity-50', disabled)
  const inputs = groupEl.querySelectorAll<HTMLInputElement>('input[data-group-child]')
  const labels = groupEl.querySelectorAll<HTMLElement>('[data-group-child-label]')
  for (const input of inputs) input.disabled = disabled
  for (const lbl of labels) lbl.classList.toggle('text-text-muted', disabled)
}

export const mkToggleRow = (
  label: string,
  checked: boolean,
  tokens: number,
  onChange: (next: boolean) => Promise<void>,
  onPreview: () => void | Promise<void>,
  warning?: string,
): HTMLElement => {
  const row = document.createElement('div')
  row.className = 'flex items-center gap-1'
  const wrap = document.createElement('label')
  wrap.className = 'inline-flex items-center gap-1 cursor-pointer'
  wrap.setAttribute('data-group-child-label', '')
  const cb = document.createElement('input')
  cb.type = 'checkbox'
  cb.className = 'rounded'
  cb.checked = checked
  cb.setAttribute('data-group-child', '')
  const name = document.createElement('span')
  name.textContent = label
  wrap.appendChild(cb)
  wrap.appendChild(name)
  row.appendChild(wrap)
  row.appendChild(mkGlass(label, onPreview))
  const tok = document.createElement('span')
  tok.className = 'text-text-muted'
  tok.textContent = `(~${tokens} tok)`
  row.appendChild(tok)
  if (warning) {
    const w = document.createElement('span')
    w.className = 'text-xs text-warning ml-1'
    w.textContent = `⚠ ${warning}`
    w.style.display = checked ? 'none' : 'inline'
    row.appendChild(w)
    cb.onchange = async () => {
      w.style.display = cb.checked ? 'none' : 'inline'
      await onChange(cb.checked)
    }
  } else {
    cb.onchange = async () => { await onChange(cb.checked) }
  }
  return row
}

interface GroupOpts {
  readonly label: string
  readonly master?: { checked: boolean; onChange: (next: boolean) => Promise<void> }
  readonly totalTokens?: number
  readonly extraHeader?: HTMLElement
  readonly children: HTMLElement[]
}

export const mkGroup = (opts: GroupOpts): HTMLElement => {
  const group = document.createElement('div')
  group.className = 'flex flex-col'

  const header = document.createElement('div')
  header.className = 'flex items-center gap-1 mb-1 text-xs font-semibold text-text-subtle uppercase tracking-wide'

  // Header order: LABEL · [master checkbox] · (~N tok) — master sits between
  // label and token count so the label reads as a heading.
  const labelEl = document.createElement('span')
  labelEl.textContent = opts.label
  header.appendChild(labelEl)

  if (opts.master) {
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.className = 'rounded'
    cb.checked = opts.master.checked
    cb.onchange = async () => {
      applyGroupDisabled(group, !cb.checked)
      await opts.master!.onChange(cb.checked)
    }
    header.appendChild(cb)
  }
  if (opts.totalTokens !== undefined) {
    const t = document.createElement('span')
    t.className = 'text-text-muted font-normal normal-case'
    t.textContent = `(~${opts.totalTokens} tok)`
    header.appendChild(t)
  }
  if (opts.extraHeader) header.appendChild(opts.extraHeader)
  group.appendChild(header)

  const rows = document.createElement('div')
  rows.className = 'flex flex-col gap-y-1'
  for (const child of opts.children) rows.appendChild(child)
  group.appendChild(rows)

  if (opts.master && !opts.master.checked) applyGroupDisabled(group, true)
  return group
}
