// Agent list rendering — global registry. Per-room actions live in
// render-room-members.ts; this list shows all agents and highlights those
// that are members of the currently selected room.

import type { AgentInfo } from './render-types.ts'

const renderAgentRow = (
  agent: AgentInfo,
  isInSelectedRoom: boolean,
  isGenerating: boolean,
  isSelf: boolean,
  isSelected: boolean,
  onInspect: (agentName: string) => void,
): HTMLElement => {
  const div = document.createElement('div')
  const tint = isSelected ? 'bg-blue-100' : isInSelectedRoom ? 'bg-blue-50' : ''
  div.className = `px-3 py-1 flex items-center gap-1.5 group relative ${tint}`

  const dot = document.createElement('span')
  const dotColor = isGenerating ? 'bg-yellow-400 typing-indicator' : 'bg-green-400'
  dot.className = `inline-block w-2 h-2 rounded-full shrink-0 ${dotColor}`
  div.appendChild(dot)

  const emoji = document.createElement('span')
  emoji.className = 'text-xs shrink-0'
  emoji.textContent = agent.kind === 'ai' ? '🤖' : '🧠'
  div.appendChild(emoji)

  const name = document.createElement('span')
  name.className = `text-xs truncate cursor-pointer ${isSelf ? 'font-bold' : 'font-medium'} ${isSelected ? 'text-blue-700' : 'text-gray-700'}`
  name.textContent = agent.name
  name.onclick = (e) => { e.stopPropagation(); onInspect(agent.name) }
  div.appendChild(name)

  return div
}

export interface RenderAgentsOptions {
  agents: Record<string, AgentInfo>
  myAgentId: string | null
  selectedAgentId: string | null
  roomMemberIds: string[]
  hasSelectedRoom: boolean
  onInspect: (agentId: string) => void
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
    const isSelf = agent.id === opts.myAgentId
    const isSelected = agent.id === opts.selectedAgentId
    container.appendChild(renderAgentRow(
      agent, isInRoom, isGenerating, isSelf, isSelected,
      () => opts.onInspect(agent.id),
    ))
  }
}
