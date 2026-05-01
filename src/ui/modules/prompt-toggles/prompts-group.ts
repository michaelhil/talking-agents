// Prompts group — persona, room prompt, system prompt, response format, skills.
// Each row has a magnifier that opens the preview modal (or scrolls the
// persona textarea into view for the persona row).

import { openPreviewModal as openModal } from '../modals/detail-modal.ts'
import {
  mkToggleRow, mkGroup, sectionByKey, PROMPT_KEYS,
  type GroupDeps, type PreviewSection,
} from './shared.ts'

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
      p.code === 'persona'
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
