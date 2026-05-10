// System / orchestration events: instance reset lifecycle, packs/triggers/
// providers config changes, summary config, errors. These mostly fan out
// via CustomEvents so independent panels can opt in without tight
// coupling to this dispatcher.

import type { WSOutbound } from '../../../../core/types/ws-protocol.ts'

type OutboundByType<K extends WSOutbound['type']> = Extract<WSOutbound, { readonly type: K }>

type SystemHandlers = {
  readonly [K in WSOutbound['type']]?: (msg: OutboundByType<K>) => void
}

export const systemHandlers: SystemHandlers = {

  providers_changed(_msg) {
    // A key was added/removed/updated live. Prompt the providers panel to
    // re-poll and any open model dropdown to refetch /api/models. We use a
    // CustomEvent so subscribers (agent-modal, inspector, editor) can opt in
    // without tight coupling to this dispatcher.
    window.dispatchEvent(new CustomEvent('providers-changed'))
  },

  packs_changed(_msg) {
    // A pack was installed / updated / uninstalled. The packs panel listens
    // for this CustomEvent and re-fetches /api/packs. Tool/skill sections
    // refresh lazily on next open (their `loaded` flag is reset here).
    // Also drives the UI extension reconciler in src/ui/modules/extensions/registry.ts
    // (subscribed in app.ts).
    window.dispatchEvent(new CustomEvent('packs-changed'))
  },

  biometric_capture_claimed(msg) {
    // Server has accepted a tab's claim of this captureId. Other tabs
    // viewing the same fenced block need to release their MediaStream and
    // swap to the "active in another tab" placeholder. The widget instance
    // listens for this event keyed by captureId.
    window.dispatchEvent(new CustomEvent('biometric:claimed', {
      detail: { captureId: msg.captureId, claimedBy: msg.claimedBy },
    }))
  },

  pack_activation_changed(msg) {
    // A room's activePacks list was replaced. Packs panel re-renders the
    // per-room toggle column. Keyed by roomId so unrelated rooms don't
    // trigger a refetch.
    window.dispatchEvent(new CustomEvent('pack-activation-changed', {
      detail: { roomId: msg.roomId, activePacks: msg.activePacks },
    }))
  },

  triggers_changed(_msg) {
    // A trigger was created / updated / deleted on some agent. Open
    // triggers modals re-fetch their data.
    window.dispatchEvent(new CustomEvent('triggers-changed'))
  },

  reset_pending(msg) {
    window.dispatchEvent(new CustomEvent('reset-pending', { detail: { commitsAtMs: msg.commitsAtMs } }))
  },

  reset_cancelled(_msg) {
    window.dispatchEvent(new CustomEvent('reset-cancelled'))
  },

  reset_failed(msg) {
    window.dispatchEvent(new CustomEvent('reset-failed', { detail: { reason: msg.reason } }))
  },

  summary_config_changed(_msg) {
    // Room config is server-authoritative; the settings modal re-fetches on open.
    // No store write needed unless we want to surface the current config elsewhere.
  },

  error(msg) {
    console.error('Server error:', msg.message)
  },
}
