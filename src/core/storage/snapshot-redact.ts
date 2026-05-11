// Save-time redactor for ephemeral biometric capture messages. Rewrites the
// fenced-block content of any message tagged cause.kind === 'biometric'
// into a terminal `state: "stopped"` fence so on-disk snapshots never
// contain landmark JSON, head pose, or expression scores — but the
// fence is still parseable, so on reload the inline widget renders a
// "Capture stopped" terminal card instead of bare placeholder text.
// Live in-room rendering is unaffected — the in-memory message keeps
// its original content until next save.
//
// Why rewrite as a fence (not a plain placeholder)?
// The render layer treats biometric-caused messages as widget hosts: it
// runs them through the markdown pipeline so `\`\`\`biometric` blocks get
// replaced with an inline component. If the content is plain text, the
// markdown pass produces a `<p>...</p>` and the user sees a near-invisible
// muted line with no indication a capture happened. Emitting a `stopped`-
// state fence makes the post-reload UI clearly say "Capture stopped"
// with the captureId, matching the live terminal-state rendering.
//
// Why redact instead of dropping the message?
// Dropping would break message-id continuity for downstream consumers (e.g.
// a follow-up message that inReplyTo's the original). The fence rewrite
// keeps the chain intact while making it obvious in any audit that a
// capture happened and what is missing.
//
// SNAPSHOT_VERSION is NOT bumped: this is purely additive on an optional
// field (cause), and load remains compatible. See feedback_no_snapshot_backcompat.md.

import type { Message } from '../types/messaging.ts'

const buildStoppedFence = (captureId: string, agentName: string): string =>
  '```biometric\n' + JSON.stringify({
    captureId,
    agentName,
    reason: '(not persisted)',
    state: 'stopped',
  }, null, 2) + '\n```'

export const redactBiometricMessages = (messages: ReadonlyArray<Message>): ReadonlyArray<Message> =>
  messages.map(m => {
    if (m.cause?.kind !== 'biometric') return m
    const captureId = m.cause.name && m.cause.name.length > 0 ? m.cause.name : 'unknown'
    const agentName = m.senderName ?? 'agent'
    return { ...m, content: buildStoppedFence(captureId, agentName) }
  })
