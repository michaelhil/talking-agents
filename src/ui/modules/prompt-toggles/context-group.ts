// Context group — participants, macro, artifacts, activity, known-agents,
// plus the "macro step instructions" toggle (moved here from Advanced).

import { openPreviewModal as openModal } from '../detail-modal.ts'
import {
  mkToggleRow, mkGroup, sectionByKey, CONTEXT_KEYS,
  type GroupDeps, type PreviewSection,
} from './shared.ts'

export const buildContextGroup = (deps: GroupDeps): HTMLElement => {
  const { preview, agentData, patchAgent, rerender } = deps
  const get = (k: string): PreviewSection | undefined => sectionByKey(preview, k)
  const includeContext = (agentData.includeContext as Record<string, boolean>) ?? {}
  const includeMacroStepPrompt = (agentData.includeMacroStepPrompt as boolean) ?? true
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

  // Macro-step instructions — moved here from Advanced.
  const macroRow = document.createElement('div')
  macroRow.className = 'flex items-center gap-1'
  const macroLabel = document.createElement('label')
  macroLabel.className = 'inline-flex items-center gap-1 cursor-pointer'
  macroLabel.setAttribute('data-group-child-label', '')
  const macroCb = document.createElement('input')
  macroCb.type = 'checkbox'
  macroCb.className = 'rounded'
  macroCb.checked = includeMacroStepPrompt
  macroCb.setAttribute('data-group-child', '')
  const macroText = document.createElement('span')
  macroText.textContent = 'Macro step instructions'
  macroLabel.appendChild(macroCb)
  macroLabel.appendChild(macroText)
  macroRow.appendChild(macroLabel)
  const macroWarn = document.createElement('span')
  macroWarn.className = 'text-xs text-warning ml-1'
  macroWarn.textContent = '⚠ off may break macro routing'
  macroWarn.style.display = includeMacroStepPrompt ? 'none' : 'inline'
  macroRow.appendChild(macroWarn)
  macroCb.onchange = async () => {
    macroWarn.style.display = macroCb.checked ? 'none' : 'inline'
    ;(agentData as Record<string, unknown>).includeMacroStepPrompt = macroCb.checked
    await patchAgent({ includeMacroStepPrompt: macroCb.checked })
  }
  rows.push(macroRow)

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
