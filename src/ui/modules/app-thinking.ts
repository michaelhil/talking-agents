// Thinking-indicator lifecycle.
//
// Architecture (rewritten 2026-05-01):
//   1. Existence is driven by ONE source of truth: $visibleThinkingIndicators
//      computed atom. Any agent in 'generating' state for the selected room
//      yields one entry — no chunk/context fallback rules, no magic-number
//      heuristics. If the agent_state event chain is reliable, the indicator
//      is reliable.
//   2. Once shown, an indicator stays in the DOM at least MIN_VISIBLE_MS so
//      sub-second generations don't flash-and-vanish below the perceptual
//      floor. The min-visible-duration logic lives in
//      ./min-visible-duration.ts as a pure function so it can be tested
//      without DOM.
//   3. Per-agent content stores ($thinkingPreviews / $thinkingTools /
//      $agentContexts / $agentWarnings) keep updating via their existing
//      thinking-display.ts listeners. Cleanup of those stores is moved
//      into clearThinkingIndicator (post-hold) so preview text doesn't
//      vanish during the hold window.

import {
  renderThinkingIndicator,
  removeThinkingIndicator,
  updateThinkingLabel,
  updateThinkingPreview,
  updateThinkingPreviewStyle,
  showContextIcon,
} from './render/render-thinking.ts'
import { derivePhase, phaseLabel, THINKING_MARKER } from './thinking-phase.ts'
import type { MapStore, ReadableAtom } from '../lib/nanostores.ts'
import type { AgentContext, AgentEntry, IndicatorState } from './stores.ts'
import { computeMinVisibleDecision, type MinVisibleEntry } from './min-visible-duration.ts'

const MIN_VISIBLE_MS = 400  // perceptual floor for "I saw an indicator"

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
  readonly $visibleThinkingIndicators: ReadableAtom<ReadonlyArray<IndicatorState>>
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
    $agentContexts, $agentWarnings, $thinkingTools, $thinkingPreviews,
    $visibleThinkingIndicators,
    showContextModal,
  } = deps

  // Per-agent indicator metadata. createdAt drives MIN_VISIBLE_MS calculations.
  // pendingRemoval, when set, is the setTimeout handle for a deferred removal.
  interface ThinkingEntry extends MinVisibleEntry {
    readonly timer: number   // 1s tick interval handle
    readonly name: string
    readonly createdAt: number
    readonly pendingRemovalHandle?: number  // narrow opaque handle to number
  }
  const thinkingState = new Map<string, ThinkingEntry>()

  const ensureThinkingIndicator = (agentId: string, agentName: string): void => {
    if (messagesDiv.querySelector(`[data-thinking-agent="${agentName}"]`)) return
    const { timer } = renderThinkingIndicator(messagesDiv, agentName, (name) => {
      send({ type: 'cancel_generation', name })
    })
    thinkingState.set(agentId, { timer, name: agentName, createdAt: Date.now() })

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
      if (entry.pendingRemovalHandle !== undefined) clearTimeout(entry.pendingRemovalHandle)
      removeThinkingIndicator(messagesDiv, entry.name)
      thinkingState.delete(agentId)
    }
    firstChunkSeen.delete(agentId)
    // Clear per-agent content stores AFTER the hold completes — moved here
    // from ws-dispatch agent_state handler to prevent preview text vanishing
    // mid-hold. Each delete is the same shape as before.
    const previews = { ...$thinkingPreviews.get() }
    if (agentId in previews) { delete previews[agentId]; $thinkingPreviews.set(previews) }
    const tools = { ...$thinkingTools.get() }
    if (agentId in tools) { delete tools[agentId]; $thinkingTools.set(tools) }
    const ctxs = { ...$agentContexts.get() }
    if (agentId in ctxs) { delete ctxs[agentId]; $agentContexts.set(ctxs) }
    const warns = { ...$agentWarnings.get() }
    if (agentId in warns) { delete warns[agentId]; $agentWarnings.set(warns) }
  }

  // Reconcile DOM against the current visible-indicators set. Called by
  // the $visibleThinkingIndicators subscription below; also called once on
  // controller creation so any visible-on-mount indicators render.
  const syncThinkingIndicators = (): void => {
    const visible = $visibleThinkingIndicators.get()
    const visibleIds = new Set(visible.map(v => v.agentId))

    // Pure decision — what should change.
    const decision = computeMinVisibleDecision(thinkingState, visibleIds, Date.now(), MIN_VISIBLE_MS)

    // Cancel pending removals for indicators that came back into the set.
    for (const id of decision.toCancelRemoval) {
      const entry = thinkingState.get(id)
      if (entry?.pendingRemovalHandle !== undefined) {
        clearTimeout(entry.pendingRemovalHandle)
        // Strip the handle so future syncs don't try to cancel it again.
        const { pendingRemovalHandle: _drop, ...rest } = entry
        thinkingState.set(id, rest)
      }
    }

    // Schedule deferred removals (hold not yet elapsed).
    for (const { id, delayMs } of decision.toScheduleRemove) {
      const entry = thinkingState.get(id)
      if (!entry) continue
      const handle = window.setTimeout(() => clearThinkingIndicator(id), delayMs)
      thinkingState.set(id, { ...entry, pendingRemovalHandle: handle })
    }

    // Immediate removals (hold already elapsed).
    for (const id of decision.toRemoveImmediately) clearThinkingIndicator(id)

    // Create new indicators.
    for (const id of decision.toCreate) {
      const v = visible.find(x => x.agentId === id)
      if (v) ensureThinkingIndicator(id, v.agentName)
    }

    // Keep DOM order stable: re-append visible indicators that aren't last.
    for (const v of visible) {
      const existing = messagesDiv.querySelector(`[data-thinking-agent="${v.agentName}"]`)
      if (existing && existing !== messagesDiv.lastElementChild) {
        messagesDiv.appendChild(existing)
      }
    }
  }

  // Subscribe directly to the computed source-of-truth. nanostores' computed
  // already coalesces upstream changes; one subscription = one render per
  // observable change.
  $visibleThinkingIndicators.listen(() => syncThinkingIndicators())

  return { ensureThinkingIndicator, clearThinkingIndicator, syncThinkingIndicators }
}
