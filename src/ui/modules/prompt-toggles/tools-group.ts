// Tools group — list fold (check/uncheck individual tools), check-all
// shortcut, iter + result-chars inline number editors, warning when the
// current model is known not to support function calling.

import { createInlineNumberEditor } from '../inline-number.ts'
import {
  mkGroup, escapeHtml,
  type GroupDeps,
} from './shared.ts'

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
  toolSummary.className = 'cursor-pointer text-text-subtle hover:text-text list-none select-none'
  toolSummary.textContent = `${enabledTools.size}/${registered.length} tools ▾`
  toolFold.appendChild(toolSummary)

  const toolListBody = document.createElement('div')
  toolListBody.className = 'mt-1 space-y-0.5 max-h-40 overflow-y-auto pl-2'

  // Check-all / uncheck-all smart button (label flips).
  if (registered.length > 0) {
    const allChecked = registered.every(n => enabledTools.has(n))
    const toggleAll = document.createElement('button')
    toggleAll.type = 'button'
    toggleAll.className = 'text-xs text-accent hover:text-accent mb-1 underline'
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
    span.innerHTML = `<span class="font-mono">${escapeHtml(name)}</span> <span class="text-text-muted">~${tok} tok</span>`
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
  toolOpts.className = 'flex items-center gap-3 mt-2 text-xs text-text-subtle'

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
    warn.className = 'text-xs text-warning mt-1'
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
