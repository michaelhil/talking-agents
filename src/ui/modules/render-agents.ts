// Agent list rendering — global registry. Per-room actions live in
// render-room-members.ts; this list shows all agents and highlights those
// that are members of the currently selected room.
//
// Click targets:
//   - dot (left)   → select-as-poster (humans only; AI no-op)
//   - name         → open agent-detail-modal (inspect)
//   - × on hover   → delete

import type { AgentInfo } from './render-types.ts'
import { icon } from './icon.ts'

const renderAgentRow = (
  agent: AgentInfo,
  isInSelectedRoom: boolean,
  isGenerating: boolean,
  isSelectedAsPoster: boolean,
  isInspectSelected: boolean,
  onInspect: (agentName: string) => void,
  onDelete: (agentName: string) => void,
  onSelectAsPoster: (agentId: string) => void,
): HTMLElement => {
  const div = document.createElement('div')
  const tint = isInspectSelected ? 'bg-surface-strong' : isInSelectedRoom ? 'bg-surface-muted' : ''
  const posterRing = isSelectedAsPoster && agent.kind === 'human' ? 'border-l-2 border-accent pl-[10px]' : ''
  div.className = `px-3 py-1 flex items-center gap-1.5 group relative ${tint} ${posterRing}`

  const dot = document.createElement('span')
  const isHuman = agent.kind === 'human'
  // Selected human: accent fill + ring. Unselected human: hover ring to
  // signal interactivity. AI: status dot, no select affordance.
  const dotColor = isGenerating ? 'bg-thinking typing-indicator'
    : isSelectedAsPoster && isHuman ? 'bg-accent ring-2 ring-accent/40'
    : 'bg-success'
  const dotInteractive = isHuman ? 'cursor-pointer hover:ring-2 hover:ring-accent/30' : ''
  dot.className = `inline-block w-2 h-2 rounded-full shrink-0 ${dotColor} ${dotInteractive}`
  if (isHuman) {
    dot.title = isSelectedAsPoster ? `Currently posting as ${agent.name}` : `Post as ${agent.name}`
    dot.onclick = (e) => { e.stopPropagation(); onSelectAsPoster(agent.id) }
  }
  div.appendChild(dot)

  const name = document.createElement('span')
  const isSelf = isSelectedAsPoster && isHuman
  name.className = `text-xs truncate cursor-pointer ${isSelf ? 'font-bold' : 'font-medium'} ${isInspectSelected ? 'text-accent' : 'text-text'}`
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
  selectedPosterId: string | null            // human currently selected for the active room
  selectedAgentId: string | null              // inspect highlight (legacy)
  roomMemberIds: string[]
  hasSelectedRoom: boolean
  onInspect: (agentId: string) => void
  onDelete: (agentName: string) => void
  onSelectAsPoster: (agentId: string) => void
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
    const isSelectedAsPoster = agent.id === opts.selectedPosterId
    const isInspectSelected = agent.id === opts.selectedAgentId
    container.appendChild(renderAgentRow(
      agent, isInRoom, isGenerating, isSelectedAsPoster, isInspectSelected,
      () => opts.onInspect(agent.id),
      () => opts.onDelete(agent.name),
      () => opts.onSelectAsPoster(agent.id),
    ))
  }
}
