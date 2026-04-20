// ============================================================================
// The four inspector groups (Prompts / Context / Tools / Model) plus the
// shared DOM helpers they build on. Each builder returns a configured
// HTMLElement ready to append into the 2x2 grid; orchestration (state
// resolution, summary, re-render) lives in index.ts.
// ============================================================================

import { createInlineNumberEditor, showToast } from '../ui-utils.ts'
import { openModal } from './modal.ts'

// --- Shared types ---

export interface AgentData {
  systemPrompt?: string
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
  { code: 'agent',          section: 'agent',          label: 'Agent prompt' },
  { code: 'room',           section: 'room',           label: 'Room prompt' },
  { code: 'house',          section: 'house',          label: 'System prompt' },
  { code: 'responseFormat', section: 'responseFormat', label: 'Response format' },
  { code: 'skills',         section: 'skills',         label: 'Skills' },
] as const

export const CONTEXT_KEYS = [
  { code: 'participants', section: 'ctx_participants', label: 'Participants list' },
  { code: 'flow',         section: 'ctx_flow',         label: 'Flow section' },
  { code: 'artifacts',    section: 'ctx_artifacts',    label: 'Artifacts' },
  { code: 'activity',     section: 'ctx_activity',     label: 'Activity in other rooms' },
  { code: 'knownAgents',  section: 'ctx_knownAgents',  label: 'Known agents', warning: 'breaks [[Name]] mentions' },
] as const

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export const sectionByKey = (p: ContextPreview, key: string): PreviewSection | undefined =>
  p.sections.find(s => s.key === key)

// --- Shared DOM helpers ---

const mkGlass = (label: string, onPreview: () => void | Promise<void>): HTMLButtonElement => {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'text-gray-400 hover:text-blue-500'
  b.setAttribute('aria-label', `Preview ${label}`)
  b.textContent = '🔍'
  b.onclick = (e) => { e.preventDefault(); void onPreview() }
  return b
}

// Flip a group's greyed/disabled state. Called when the master checkbox flips.
const applyGroupDisabled = (groupEl: HTMLElement, disabled: boolean): void => {
  groupEl.classList.toggle('opacity-50', disabled)
  const inputs = groupEl.querySelectorAll<HTMLInputElement>('input[data-group-child]')
  const labels = groupEl.querySelectorAll<HTMLElement>('[data-group-child-label]')
  for (const input of inputs) input.disabled = disabled
  for (const lbl of labels) lbl.classList.toggle('text-gray-400', disabled)
}

const mkToggleRow = (
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
  tok.className = 'text-gray-400'
  tok.textContent = `(~${tokens} tok)`
  row.appendChild(tok)
  if (warning) {
    const w = document.createElement('span')
    w.className = 'text-xs text-amber-600 ml-1'
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

const mkGroup = (opts: GroupOpts): HTMLElement => {
  const group = document.createElement('div')
  group.className = 'flex flex-col'

  const header = document.createElement('div')
  header.className = 'flex items-center gap-1 mb-1 text-xs font-semibold text-gray-500 uppercase tracking-wide'

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
    t.className = 'text-gray-400 font-normal normal-case'
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

// --- Builder deps ---

export interface GroupDeps {
  readonly preview: ContextPreview
  readonly agentData: AgentData & Record<string, unknown>
  readonly promptTextarea: HTMLTextAreaElement
  readonly patchAgent: (patch: Record<string, unknown>) => Promise<void>
  readonly rerender: () => Promise<void>
}

// --- Prompts group ---

export const buildPromptsGroup = (deps: GroupDeps): HTMLElement => {
  const { preview, agentData, promptTextarea, patchAgent, rerender } = deps
  const get = (k: string): PreviewSection | undefined => sectionByKey(preview, k)
  const includePrompts = (agentData.includePrompts as Record<string, boolean>) ?? {}
  const promptsEnabled = (agentData.promptsEnabled as boolean) ?? true

  const totalTokens = PROMPT_KEYS.reduce((s, p) => s + (get(p.section)?.tokens ?? 0), 0)

  const rows = PROMPT_KEYS.map(p => {
    const sec = get(p.section)
    return mkToggleRow(
      p.label,
      includePrompts[p.code] ?? true,
      sec?.tokens ?? 0,
      async (next) => {
        (agentData as Record<string, unknown>).includePrompts = { ...includePrompts, [p.code]: next }
        await patchAgent({ includePrompts: { [p.code]: next } })
        await rerender()
      },
      p.code === 'agent'
        ? () => {
            promptTextarea.scrollIntoView({ behavior: 'smooth', block: 'center' })
            promptTextarea.classList.add('ring-2', 'ring-blue-400')
            setTimeout(() => promptTextarea.classList.remove('ring-2', 'ring-blue-400'), 1500)
          }
        : () => openModal(`${p.label}${p.code === 'room' ? ` — "${preview.roomName}"` : ''}`, sec?.text ?? '', sec?.tokens ?? 0),
    )
  })

  return mkGroup({
    label: 'Prompts',
    master: {
      checked: promptsEnabled,
      onChange: async (next) => {
        (agentData as Record<string, unknown>).promptsEnabled = next
        await patchAgent({ promptsEnabled: next })
        await rerender()
      },
    },
    totalTokens,
    children: rows,
  })
}

// --- Context group (includes flow-step row) ---

export const buildContextGroup = (deps: GroupDeps): HTMLElement => {
  const { preview, agentData, patchAgent, rerender } = deps
  const get = (k: string): PreviewSection | undefined => sectionByKey(preview, k)
  const includeContext = (agentData.includeContext as Record<string, boolean>) ?? {}
  const includeFlowStepPrompt = (agentData.includeFlowStepPrompt as boolean) ?? true
  const contextEnabled = (agentData.contextEnabled as boolean) ?? true

  const totalTokens = CONTEXT_KEYS.reduce((s, c) => s + (get(c.section)?.tokens ?? 0), 0)

  const rows: HTMLElement[] = CONTEXT_KEYS.map(c => {
    const sec = get(c.section)
    return mkToggleRow(
      c.label,
      includeContext[c.code] ?? true,
      sec?.tokens ?? 0,
      async (next) => {
        (agentData as Record<string, unknown>).includeContext = { ...includeContext, [c.code]: next }
        await patchAgent({ includeContext: { [c.code]: next } })
        await rerender()
      },
      () => openModal(c.label, sec?.text ?? '', sec?.tokens ?? 0),
      'warning' in c ? c.warning : undefined,
    )
  })

  // Flow-step instructions — moved here from Advanced.
  const flowRow = document.createElement('div')
  flowRow.className = 'flex items-center gap-1'
  const flowLabel = document.createElement('label')
  flowLabel.className = 'inline-flex items-center gap-1 cursor-pointer'
  flowLabel.setAttribute('data-group-child-label', '')
  const flowCb = document.createElement('input')
  flowCb.type = 'checkbox'
  flowCb.className = 'rounded'
  flowCb.checked = includeFlowStepPrompt
  flowCb.setAttribute('data-group-child', '')
  const flowText = document.createElement('span')
  flowText.textContent = 'Flow step instructions'
  flowLabel.appendChild(flowCb)
  flowLabel.appendChild(flowText)
  flowRow.appendChild(flowLabel)
  const flowWarn = document.createElement('span')
  flowWarn.className = 'text-xs text-amber-600 ml-1'
  flowWarn.textContent = '⚠ off may break flow routing'
  flowWarn.style.display = includeFlowStepPrompt ? 'none' : 'inline'
  flowRow.appendChild(flowWarn)
  flowCb.onchange = async () => {
    flowWarn.style.display = flowCb.checked ? 'none' : 'inline'
    ;(agentData as Record<string, unknown>).includeFlowStepPrompt = flowCb.checked
    await patchAgent({ includeFlowStepPrompt: flowCb.checked })
  }
  rows.push(flowRow)

  return mkGroup({
    label: 'Context',
    master: {
      checked: contextEnabled,
      onChange: async (next) => {
        (agentData as Record<string, unknown>).contextEnabled = next
        await patchAgent({ contextEnabled: next })
        await rerender()
      },
    },
    totalTokens,
    children: rows,
  })
}

// --- Tools group (list fold + iter/result inputs) ---

export interface ToolsDeps extends GroupDeps {
  readonly foldOpen: { current: boolean }
}

export const buildToolsGroup = (deps: ToolsDeps): HTMLElement => {
  const { preview, agentData, patchAgent, rerender, foldOpen } = deps
  const registered = preview.registeredTools
  const toolTokens = preview.toolTokens
  const enabledTools = new Set<string>((agentData.tools as string[] | undefined) ?? registered)
  const includeTools = (agentData.includeTools as boolean) ?? true
  const maxToolResultChars = agentData.maxToolResultChars as number | null | undefined
  const maxToolIterations = agentData.maxToolIterations as number | null | undefined

  const toolTokensTotal = [...enabledTools].reduce((s, n) => s + (toolTokens[n] ?? 0), 0)

  // Fold trigger ("N/M tools ▾") — open state persists across rerender() via
  // the foldOpen ref owned by the orchestrator.
  const toolFold = document.createElement('details')
  toolFold.className = 'mt-1'
  toolFold.open = foldOpen.current
  toolFold.setAttribute('data-group-child-label', '')
  toolFold.ontoggle = () => { foldOpen.current = toolFold.open }

  const toolSummary = document.createElement('summary')
  toolSummary.className = 'cursor-pointer text-gray-500 hover:text-gray-700 list-none select-none'
  toolSummary.textContent = `${enabledTools.size}/${registered.length} tools ▾`
  toolFold.appendChild(toolSummary)

  const toolListBody = document.createElement('div')
  toolListBody.className = 'mt-1 space-y-0.5 max-h-40 overflow-y-auto pl-2'

  // Check-all / uncheck-all smart button (label flips).
  if (registered.length > 0) {
    const allChecked = registered.every(n => enabledTools.has(n))
    const toggleAll = document.createElement('button')
    toggleAll.type = 'button'
    toggleAll.className = 'text-xs text-blue-500 hover:text-blue-700 mb-1 underline'
    toggleAll.textContent = allChecked ? 'uncheck all' : 'check all'
    toggleAll.onclick = async (e) => {
      e.preventDefault()
      e.stopPropagation()
      const next = allChecked ? [] : [...registered]
      ;(agentData as Record<string, unknown>).tools = next
      await patchAgent({ tools: next })
      await rerender()
    }
    toolListBody.appendChild(toggleAll)
  }

  for (const name of registered) {
    const row = document.createElement('label')
    row.className = 'flex items-center gap-1 w-full'
    row.setAttribute('data-group-child-label', '')
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.className = 'rounded'
    cb.checked = enabledTools.has(name)
    cb.setAttribute('data-group-child', '')
    const tok = toolTokens[name] ?? 0
    const span = document.createElement('span')
    span.innerHTML = `<span class="font-mono">${escapeHtml(name)}</span> <span class="text-gray-400">~${tok} tok</span>`
    cb.onchange = async () => {
      // enabledTools is rebuilt per render, so we send the next array directly.
      const next = cb.checked
        ? [...enabledTools, name]
        : [...enabledTools].filter(n => n !== name)
      ;(agentData as Record<string, unknown>).tools = next
      await patchAgent({ tools: next })
      await rerender()
    }
    row.appendChild(cb)
    row.appendChild(span)
    toolListBody.appendChild(row)
  }
  toolFold.appendChild(toolListBody)

  // Tool option inputs (iter + result chars) — moved from Advanced
  const toolOpts = document.createElement('div')
  toolOpts.className = 'flex items-center gap-3 mt-2 text-xs text-gray-500'

  const iterWrap = createInlineNumberEditor({
    label: 'iter',
    value: String(maxToolIterations ?? 5),
    tooltip: 'Max tool iterations (default 5)',
    step: '1',
    onSave: async (v) => {
      const n = v === '' ? 5 : Number(v)
      if (!Number.isFinite(n) || n < 1) return
      await patchAgent({ maxToolIterations: n })
      ;(agentData as Record<string, unknown>).maxToolIterations = n
    },
  })
  iterWrap.setAttribute('data-group-child-label', '')

  const resWrap = createInlineNumberEditor({
    label: 'result chars',
    value: typeof maxToolResultChars === 'number' ? String(maxToolResultChars) : 'default',
    tooltip: 'Max characters per tool result (blank = default)',
    step: '100',
    onSave: async (v) => {
      const patch = v === '' ? { maxToolResultChars: null } : { maxToolResultChars: Number(v) }
      await patchAgent(patch)
      ;(agentData as Record<string, unknown>).maxToolResultChars = v === '' ? null : Number(v)
    },
  })
  resWrap.setAttribute('data-group-child-label', '')

  toolOpts.appendChild(iterWrap)
  toolOpts.appendChild(resWrap)

  const children: HTMLElement[] = [toolFold, toolOpts]
  if (preview.modelSupportsTools === false) {
    const warn = document.createElement('div')
    warn.className = 'text-xs text-amber-600 mt-1'
    warn.textContent = '⚠ this model does not support function calling — tools will be ignored'
    children.unshift(warn)
  }

  return mkGroup({
    label: 'Tools',
    master: {
      checked: includeTools,
      onChange: async (next) => {
        (agentData as Record<string, unknown>).includeTools = next
        await patchAgent({ includeTools: next })
        await rerender()
      },
    },
    totalTokens: toolTokensTotal,
    children,
  })
}

// --- Model group (no master; always applies) ---

export const buildModelGroup = (deps: GroupDeps): HTMLElement => {
  const { agentData, patchAgent } = deps
  const temperature = agentData.temperature as number | undefined
  const historyLimit = agentData.historyLimit as number | undefined
  const thinking = (agentData.thinking as boolean) ?? false

  const modelRows: HTMLElement[] = []

  const tempRow = createInlineNumberEditor({
    label: 'temp',
    value: String(temperature ?? 'default'),
    tooltip: 'Temperature — controls randomness',
    step: '0.1',
    onSave: async (v) => {
      const patch = v === '' ? { temperature: undefined } : { temperature: Number(v) }
      await patchAgent(patch)
      ;(agentData as Record<string, unknown>).temperature = v === '' ? undefined : Number(v)
    },
  })
  modelRows.push(tempRow)

  const histRow = createInlineNumberEditor({
    label: 'history',
    value: String(historyLimit ?? 'default'),
    tooltip: 'History limit — max messages',
    step: '1',
    onSave: async (v) => {
      const patch = v === '' ? { historyLimit: undefined } : { historyLimit: Number(v) }
      await patchAgent(patch)
      ;(agentData as Record<string, unknown>).historyLimit = v === '' ? undefined : Number(v)
    },
  })
  modelRows.push(histRow)

  const thinkRow = document.createElement('label')
  thinkRow.className = 'inline-flex items-center gap-1 cursor-pointer text-xs text-gray-500'
  const thinkCb = document.createElement('input')
  thinkCb.type = 'checkbox'
  thinkCb.className = 'rounded'
  thinkCb.checked = thinking
  thinkCb.onchange = async () => {
    await patchAgent({ thinking: thinkCb.checked })
    ;(agentData as Record<string, unknown>).thinking = thinkCb.checked
    showToast(document.body, `Thinking ${thinkCb.checked ? 'on' : 'off'}`, { position: 'fixed' })
  }
  const thinkText = document.createElement('span')
  thinkText.textContent = 'thinking'
  thinkRow.appendChild(thinkCb)
  thinkRow.appendChild(thinkText)
  modelRows.push(thinkRow)

  return mkGroup({
    label: 'Model',
    children: modelRows,
  })
}
