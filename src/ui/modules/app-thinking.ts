// Thinking-indicator lifecycle: ensure/clear/sync the yellow-dot cards that
// appear in the chat while an agent is generating. Stateful — holds the
// per-agent timer and first-chunk-seen tracking.

import {
  renderThinkingIndicator,
  removeThinkingIndicator,
  updateThinkingLabel,
  updateThinkingPreview,
  updateThinkingPreviewStyle,
  showContextIcon,
} from './render-thinking.ts'
import { derivePhase, phaseLabel, THINKING_MARKER } from './thinking-phase.ts'
import type { MapStore, ReadableAtom } from '../lib/nanostores.ts'
import type { AgentContext, AgentEntry } from './stores.ts'

interface ThinkingDeps {
  readonly messagesDiv: HTMLElement
  readonly send: (data: unknown) => void
  readonly firstChunkSeen: Set<string>
  readonly $agents: MapStore<Record<string, AgentEntry>>
  readonly $agentContexts: MapStore<Record<string, AgentContext>>
  readonly $agentWarnings: MapStore<Record<string, string[]>>
  readonly $thinkingTools: MapStore<Record<string, string>>
  readonly $thinkingPreviews: MapStore<Record<string, string>>
  readonly $selectedRoomId: ReadableAtom<string | null>
  readonly showContextModal: (context: AgentContext, warnings?: string[]) => void
}

interface ThinkingController {
  readonly ensureThinkingIndicator: (agentId: string, agentName: string) => void
  readonly clearThinkingIndicator: (agentId: string) => void
  readonly syncThinkingIndicators: () => void
}

export const createThinkingController = (deps: ThinkingDeps): ThinkingController => {
  const {
    messagesDiv, send, firstChunkSeen,
    $agents, $agentContexts, $agentWarnings, $thinkingTools, $thinkingPreviews, $selectedRoomId,
    showContextModal,
  } = deps

  const thinkingState = new Map<string, { timer: number; name: string }>()

  const ensureThinkingIndicator = (agentId: string, agentName: string): void => {
    if (messagesDiv.querySelector(`[data-thinking-agent="${agentName}"]`)) return
    const { timer } = renderThinkingIndicator(messagesDiv, agentName, (name) => {
      send({ type: 'cancel_generation', name })
    })
    thinkingState.set(agentId, { timer, name: agentName })

    // Set label to match current known phase — covers room re-entry where state is already advanced.
    const ctx = $agentContexts.get()[agentId]
    const toolText = $thinkingTools.get()[agentId] ?? ''
    const phase = derivePhase({
      hasContext: ctx !== undefined,
      model: ctx?.model,
      toolText,
      firstChunkSeen: firstChunkSeen.has(agentId),
    })
    if (phase.kind !== 'building') {
      updateThinkingLabel(messagesDiv, agentName, phaseLabel(agentName, phase))
    }
    if (phase.kind === 'thinking') {
      updateThinkingPreviewStyle(messagesDiv, agentName, true)
    }
    if (ctx && toolText !== THINKING_MARKER) {
      showContextIcon(messagesDiv, agentName, () => showContextModal(ctx, $agentWarnings.get()[agentId]))
    }

    const preview = $thinkingPreviews.get()[agentId]
    if (preview) updateThinkingPreview(messagesDiv, agentName, preview)
  }

  const clearThinkingIndicator = (agentId: string): void => {
    const entry = thinkingState.get(agentId)
    if (entry) {
      clearInterval(entry.timer)
      removeThinkingIndicator(messagesDiv, entry.name)
      thinkingState.delete(agentId)
    }
    firstChunkSeen.delete(agentId)
  }

  const syncThinkingIndicators = (): void => {
    const selectedRoom = $selectedRoomId.get()
    if (!selectedRoom) return
    const agents = $agents.get()

    const shouldShow = new Set<string>()
    for (const [id, agent] of Object.entries(agents)) {
      if (agent.state === 'generating' && agent.context === selectedRoom) {
        shouldShow.add(id)
      }
    }

    for (const [id] of thinkingState) {
      if (!shouldShow.has(id)) clearThinkingIndicator(id)
    }

    for (const id of shouldShow) {
      const agent = agents[id]!
      const existing = messagesDiv.querySelector(`[data-thinking-agent="${agent.name}"]`)
      if (existing) {
        if (existing !== messagesDiv.lastElementChild) {
          messagesDiv.appendChild(existing)
        }
      } else {
        ensureThinkingIndicator(id, agent.name)
      }
    }
  }

  return { ensureThinkingIndicator, clearThinkingIndicator, syncThinkingIndicators }
}
