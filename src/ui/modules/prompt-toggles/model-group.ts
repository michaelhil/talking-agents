// Model group — temperature, history limit, thinking toggle. No master
// checkbox — model settings always apply.

import { createInlineNumberEditor, showToast } from '../ui-utils.ts'
import { mkGroup, type GroupDeps } from './shared.ts'

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
  thinkRow.className = 'inline-flex items-center gap-1 cursor-pointer text-xs text-text-subtle'
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
