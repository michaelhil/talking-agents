// ============================================================================
// Thinking-indicator store subscriptions.
//
// Four store listeners that forward agent eval state into the thinking
// indicator's DOM surface:
//   - $thinkingPreviews → preview text + first-chunk label switch
//   - $thinkingTools    → tool / thinking-phase label + style
//   - $agentContexts    → "Waiting for model" label + context-inspector icon
//   - $agentWarnings    → appends retry / context-trim warnings
//
// The fifth thinking-related listener, `$agents.listen(() =>
// syncThinkingIndicators())`, stays in app.ts — it's a three-line call
// that doesn't earn its own import boundary.
//
// The controller itself (ensureThinkingIndicator / clearThinkingIndicator /
// syncThinkingIndicators) is built by createThinkingController() in app.ts
// and passed in here via deps. This module owns no state.
// ============================================================================

import {
  $agentContexts,
  $agentWarnings,
  $thinkingPreviews,
  $thinkingTools,
  type AgentContext,
} from './stores.ts'
import { agentIdToName } from './identity-lookups.ts'
import {
  updateThinkingPreview,
  updateThinkingTool,
  updateThinkingLabel,
  updateThinkingPreviewStyle,
  showContextIcon,
  addThinkingWarning,
} from './render/render-thinking.ts'

export interface ThinkingDisplayDeps {
  readonly messagesDiv: HTMLElement
  readonly firstChunkSeen: Set<string>
  readonly showContextModal: (ctx: AgentContext, warnings?: string[]) => void
}

export const initThinkingDisplay = (deps: ThinkingDisplayDeps): void => {
  const { messagesDiv, firstChunkSeen, showContextModal } = deps

  $thinkingPreviews.listen((previews, _old, changedId) => {
    if (!changedId) return
    const agentName = agentIdToName(changedId)
    if (!agentName) return
    // First chunk → switch label from "Sending to model..." to "Generating..."
    if (!firstChunkSeen.has(changedId)) {
      firstChunkSeen.add(changedId)
      updateThinkingLabel(messagesDiv, agentName, `${agentName}: Generating...`)
    }
    updateThinkingPreview(messagesDiv, agentName, previews[changedId] ?? '')
  })

  $thinkingTools.listen((tools, _old, changedId) => {
    if (!changedId) return
    const agentName = agentIdToName(changedId)
    if (!agentName) return
    const toolText = tools[changedId] ?? ''
    if (toolText === '__thinking__') {
      // Model is in CoT thinking phase — dim the preview
      updateThinkingLabel(messagesDiv, agentName, `${agentName}: Thinking...`)
      updateThinkingPreviewStyle(messagesDiv, agentName, true)
    } else if (toolText === '') {
      // Thinking phase ended, response starting — restore normal style
      updateThinkingLabel(messagesDiv, agentName, `${agentName}: Generating...`)
      updateThinkingPreviewStyle(messagesDiv, agentName, false)
      firstChunkSeen.add(changedId) // treat as first chunk seen
    } else {
      updateThinkingTool(messagesDiv, agentName, toolText)
      if (toolText.endsWith('...')) {
        updateThinkingLabel(messagesDiv, agentName, `${agentName}: ${toolText}`)
      } else {
        updateThinkingLabel(messagesDiv, agentName, `${agentName}: Generating...`)
      }
    }
  })

  $agentContexts.listen((contexts, _old, changedId) => {
    if (!changedId) return
    const agentName = agentIdToName(changedId)
    if (!agentName) return
    const ctx = contexts[changedId]
    if (ctx) {
      // Context ready → waiting for LLM to start generating (prefill phase)
      updateThinkingLabel(messagesDiv, agentName, `${agentName}: Waiting for ${ctx.model}...`)
      showContextIcon(messagesDiv, agentName, () => showContextModal(ctx, $agentWarnings.get()[changedId]))
    }
  })

  $agentWarnings.listen((warnings, _old, changedId) => {
    if (!changedId) return
    const agentName = agentIdToName(changedId)
    if (!agentName) return
    const msgs = warnings[changedId] ?? []
    // Show the latest warning (new ones are appended)
    if (msgs.length > 0) {
      addThinkingWarning(messagesDiv, agentName, msgs[msgs.length - 1]!)
    }
  })
}
