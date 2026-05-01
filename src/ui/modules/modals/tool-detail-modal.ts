// Read-only tool inspector. Shows description, usage, returns, parameter
// schema, originating file, and — for external / skill-bundled tools served
// from localhost — the source code. Each enabledFor agent is a pill that
// jumps to that agent's inspector where per-agent tool wiring lives.
//
// Two entry points:
//   - openToolDetailModal(name)          — standalone modal (click a tool
//                                          pill anywhere in the app)
//   - renderToolDetailInto(el, name, {close?})
//                                        — populate an existing container
//                                          (used by Settings > Tools)

import { $selectedAgentId } from '../stores.ts'
import {
  createCodeBlock,
  createModal,
  createPillList,
  createReadonlyRow,
  createSectionLabel,
  prettyJson,
} from '../modals/detail-modal.ts'

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

// Populate `container` with the full tool detail surface. `onPillClick` (if
// given) is invoked before $selectedAgentId is set — hosts pass close()
// so the modal dismisses cleanly before navigating to the agent inspector.
export const renderToolDetailInto = async (
  container: HTMLElement,
  toolName: string,
  opts?: { readonly onPillClick?: () => void },
): Promise<void> => {
  container.innerHTML = ''
  const res = await fetch(`/api/tools/${encodeURIComponent(toolName)}`)
  if (!res.ok) {
    container.innerHTML = '<div class="text-xs text-text-muted">Tool not found.</div>'
    return
  }
  const data = await res.json() as ToolDetailPayload

  const desc = document.createElement('div')
  desc.className = 'text-xs mb-2 text-text'
  desc.textContent = data.description
  container.appendChild(desc)

  if (data.usage) {
    container.appendChild(createSectionLabel('Usage'))
    container.appendChild(createReadonlyRow(data.usage))
  }
  if (data.returns) {
    container.appendChild(createSectionLabel('Returns'))
    container.appendChild(createReadonlyRow(data.returns))
  }

  container.appendChild(createSectionLabel('Source'))
  container.appendChild(createReadonlyRow(sourceLabel(data.source), { mono: true, muted: true }))

  container.appendChild(createSectionLabel('Parameters'))
  container.appendChild(createCodeBlock(prettyJson(data.parameters), '12rem'))

  if (data.source.code) {
    container.appendChild(createSectionLabel('Code'))
    container.appendChild(createCodeBlock(data.source.code, '20rem'))
  }

  container.appendChild(createSectionLabel(`Enabled for (${data.enabledFor.length})`))
  container.appendChild(createPillList(
    data.enabledFor.map(a => ({
      label: a.name,
      title: `Open ${a.name}'s inspector`,
      onClick: () => {
        opts?.onPillClick?.()
        $selectedAgentId.set(a.id)
      },
    })),
    'No agents have this tool enabled',
  ))
}

export const openToolDetailModal = async (toolName: string): Promise<void> => {
  const modal = createModal({ title: toolName, width: 'max-w-2xl' })
  document.body.appendChild(modal.overlay)
  await renderToolDetailInto(modal.scrollBody, toolName, { onPillClick: modal.close })
}
