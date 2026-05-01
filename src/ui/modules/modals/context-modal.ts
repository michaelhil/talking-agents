// Prompt-context inspection modal. Shown from the per-message magnifier
// icon. Captures what was sent to the model for this turn — system, user,
// assistant messages + warnings.

import { createModal } from '../modals/detail-modal.ts'
import { showToast } from '../toast.ts'
import { $messageContexts, $messageWarnings, type AgentContext } from '../stores.ts'

export const showContextModal = (context: AgentContext, warnings?: string[]): void => {
  const modal = createModal({ title: 'Prompt Context', width: 'max-w-3xl' })
  const headerEl = document.createElement('div')
  headerEl.className = 'text-xs text-text-subtle mb-3'
  headerEl.textContent = `Model: ${context.model} | Temperature: ${context.temperature ?? 'default'} | Tools: ${context.toolCount}`
  modal.scrollBody.appendChild(headerEl)

  if (warnings && warnings.length > 0) {
    const warnBox = document.createElement('div')
    warnBox.className = 'text-xs text-warning bg-warning-bg rounded p-2 mb-3 space-y-0.5'
    for (const w of warnings) {
      const line = document.createElement('div')
      line.textContent = `\u26a0 ${w}`
      warnBox.appendChild(line)
    }
    modal.scrollBody.appendChild(warnBox)
  }

  for (const msg of context.messages) {
    const section = document.createElement('div')
    section.className = 'mb-3'
    const roleLabel = document.createElement('div')
    roleLabel.className = 'text-xs font-semibold text-text-muted uppercase tracking-wide mb-1 border-b border-border pb-1'
    roleLabel.textContent = msg.role
    const content = document.createElement('pre')
    content.className = 'text-xs text-text whitespace-pre-wrap font-mono bg-surface-muted rounded p-2 max-h-64 overflow-y-auto'
    content.textContent = msg.content
    section.appendChild(roleLabel)
    section.appendChild(content)
    modal.scrollBody.appendChild(section)
  }

  document.body.appendChild(modal.overlay)
}

// Click handler for the per-message magnifier button. If the client doesn't
// have captured context for this message id (older message / post-reload),
// shows a toast rather than an empty modal.
export const handleViewContext = (msgId: string): void => {
  const ctx = $messageContexts.get()[msgId]
  if (ctx) {
    showContextModal(ctx, $messageWarnings.get()[msgId])
  } else {
    showToast(
      document.body,
      'Prompt context not captured for this message (e.g. older message or after page reload).',
      { position: 'fixed' },
    )
  }
}
