// Agent list rendering — global registry. Per-room actions live in
// render-room-members.ts; this list shows all agents and highlights those
// that are members of the currently selected room.
//
// Sidebar dots are display-only — they show presence/mute state, not
// per-room selection. Selection happens via clicking the dot on the
// agent's chip in the room members row at the top of the active room.
//
// Click targets:
//   - dot   → no-op (display only)
//   - name  → open agent-detail-modal (inspect)
//   - × on hover → delete

import type { AgentInfo } from '../render/render-types.ts'
import { icon } from '../icon.ts'

const renderAgentRow = (
  agent: AgentInfo,
  isInSelectedRoom: boolean,
  isGenerating: boolean,
  isInspectSelected: boolean,
  onInspect: (agentName: string) => void,
  onDelete: (agentName: string) => void,
): HTMLElement => {
  const div = document.createElement('div')
  const tint = isInspectSelected ? 'bg-surface-strong' : isInSelectedRoom ? 'bg-surface-muted' : ''
  div.className = `px-3 py-1 flex items-center gap-1.5 group relative ${tint}`

  const dot = document.createElement('span')
  const dotColor = isGenerating ? 'bg-thinking typing-indicator' : 'bg-success'
  dot.className = `inline-block w-2 h-2 rounded-full shrink-0 ${dotColor}`
  div.appendChild(dot)

  const name = document.createElement('span')
  // Sidebar agent names are labels, not links — keep them in the regular
  // text color even when "inspect-selected" (the row tint already signals
  // selection). Inspect-selected gets a slightly stronger text via
  // text-text-strong so it's still visually distinct.
  name.className = `text-xs truncate cursor-pointer font-medium ${isInspectSelected ? 'text-text-strong' : 'text-text'}`
  name.textContent = agent.name
  name.onclick = (e) => { e.stopPropagation(); onInspect(agent.name) }
  div.appendChild(name)

  const kindIcon = icon(agent.kind === 'ai' ? 'cpu' : 'user', { size: 12 })
  kindIcon.classList.add('shrink-0', 'text-text-subtle')
  div.appendChild(kindIcon)

  const del = document.createElement('button')
  del.className = 'opacity-0 group-hover:opacity-100 ml-auto text-orange-400 hover:text-orange-700 text-xs'
  del.textContent = '×'
  del.title = `Delete ${agent.name}`
  del.onclick = (e) => { e.stopPropagation(); onDelete(agent.name) }
  div.appendChild(del)

  return div
}

export interface RenderAgentsOptions {
  agents: Record<string, AgentInfo>
  selectedAgentId: string | null              // inspect highlight
  roomMemberIds: string[]
  hasSelectedRoom: boolean
  onInspect: (agentId: string) => void
  onDelete: (agentName: string) => void
}

export const renderAgents = (
  container: HTMLElement,
  opts: RenderAgentsOptions,
): void => {
  container.innerHTML = ''

  const memberSet = new Set(opts.roomMemberIds)
  const allAgents = Object.values(opts.agents)

  for (const agent of allAgents) {
    const isInRoom = opts.hasSelectedRoom && memberSet.has(agent.id)
    const isGenerating = agent.state === 'generating'
    const isInspectSelected = agent.id === opts.selectedAgentId
    container.appendChild(renderAgentRow(
      agent, isInRoom, isGenerating, isInspectSelected,
      () => opts.onInspect(agent.id),
      () => opts.onDelete(agent.name),
    ))
  }
}
