// Context group — participants, artifacts, activity, known-agents.

import { openPreviewModal as openModal } from '../modals/detail-modal.ts'
import {
  mkToggleRow, mkGroup, sectionByKey, CONTEXT_KEYS,
  type GroupDeps, type PreviewSection,
} from './shared.ts'

export const buildContextGroup = (deps: GroupDeps): HTMLElement => {
  const { preview, agentData, patchAgent, rerender } = deps
  const get = (k: string): PreviewSection | undefined => sectionByKey(preview, k)
  const includeContext = (agentData.includeContext as Record<string, boolean>) ?? {}
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
