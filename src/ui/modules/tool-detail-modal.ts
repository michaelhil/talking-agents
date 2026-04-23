// Read-only tool inspector. Shows description, usage, returns, parameter
// schema, originating file, and — for external / skill-bundled tools served
// from localhost — the source code. Each enabledFor agent is a pill that
// jumps to that agent's inspector where per-agent tool wiring lives.

import { $selectedAgentId } from './stores.ts'
import {
  createCodeBlock,
  createModal,
  createPillList,
  createReadonlyRow,
  createSectionLabel,
  prettyJson,
} from './detail-modal.ts'

interface ToolDetailPayload {
  readonly name: string
  readonly description: string
  readonly usage?: string
  readonly returns?: string
  readonly parameters: Record<string, unknown>
  readonly source: {
    readonly kind: 'built-in' | 'external' | 'skill-bundled'
    readonly path?: string
    readonly skill?: string
    readonly code?: string
  }
  readonly enabledFor: ReadonlyArray<{ readonly id: string; readonly name: string }>
}

const sourceLabel = (source: ToolDetailPayload['source']): string => {
  switch (source.kind) {
    case 'built-in': return 'built-in'
    case 'external': return source.path ? `external · ${source.path}` : 'external'
    case 'skill-bundled': return source.skill
      ? `skill: ${source.skill}${source.path ? ` · ${source.path}` : ''}`
      : (source.path ?? 'skill-bundled')
  }
}

export const openToolDetailModal = async (toolName: string): Promise<void> => {
  const res = await fetch(`/api/tools/${encodeURIComponent(toolName)}`)
  if (!res.ok) return
  const data = await res.json() as ToolDetailPayload

  const modal = createModal({ title: data.name, width: 'max-w-2xl' })

  const desc = document.createElement('div')
  desc.className = 'text-xs mb-2 text-text'
  desc.textContent = data.description
  modal.scrollBody.appendChild(desc)

  if (data.usage) {
    modal.scrollBody.appendChild(createSectionLabel('Usage'))
    modal.scrollBody.appendChild(createReadonlyRow(data.usage))
  }
  if (data.returns) {
    modal.scrollBody.appendChild(createSectionLabel('Returns'))
    modal.scrollBody.appendChild(createReadonlyRow(data.returns))
  }

  modal.scrollBody.appendChild(createSectionLabel('Source'))
  modal.scrollBody.appendChild(createReadonlyRow(sourceLabel(data.source), { mono: true, muted: true }))

  modal.scrollBody.appendChild(createSectionLabel('Parameters'))
  modal.scrollBody.appendChild(createCodeBlock(prettyJson(data.parameters), '12rem'))

  if (data.source.code) {
    modal.scrollBody.appendChild(createSectionLabel('Code'))
    modal.scrollBody.appendChild(createCodeBlock(data.source.code, '20rem'))
  }

  modal.scrollBody.appendChild(createSectionLabel(`Enabled for (${data.enabledFor.length})`))
  modal.scrollBody.appendChild(createPillList(
    data.enabledFor.map(a => ({
      label: a.name,
      title: `Open ${a.name}'s inspector`,
      onClick: () => {
        modal.close()
        $selectedAgentId.set(a.id)
      },
    })),
    'No agents have this tool enabled',
  ))

  document.body.appendChild(modal.overlay)
}
