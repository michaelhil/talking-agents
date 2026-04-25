// ============================================================================
// Reset action + global countdown banner.
//
// Triggered from the Settings drawer (data-settings-row="reset"). On click:
// confirmation modal → POST /api/system/reset → server schedules a 10-second
// commit and broadcasts `reset_pending`. Every connected tab shows a banner
// with a `Cancel` button; any tab can cancel during the window. After commit
// the server exits, systemd respawns, browsers reconnect via the existing
// WS reconnect loop in ws-client.ts.
//
// Server-side single-flight + 5-minute cooldown lives in src/api/routes/
// system.ts. The UI just trusts the server's responses.
// ============================================================================

import { showToast } from './toast.ts'

let bannerEl: HTMLElement | null = null
let countdownTimer: ReturnType<typeof setInterval> | null = null

const removeBanner = (): void => {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null }
  bannerEl?.remove()
  bannerEl = null
}

const showCountdownBanner = (commitsAtMs: number): void => {
  removeBanner()
  const banner = document.createElement('div')
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:var(--danger);color:#fff;z-index:10000;display:flex;align-items:center;justify-content:center;gap:16px;padding:10px 16px;font:600 13px/1.3 system-ui,-apple-system,sans-serif;box-shadow:0 2px 8px var(--shadow-overlay)'

  const text = document.createElement('span')
  text.textContent = ''  // populated by tick

  const cancel = document.createElement('button')
  cancel.textContent = 'Cancel reset'
  cancel.style.cssText = 'background:#fff;color:var(--danger);border:none;border-radius:4px;padding:6px 12px;font-weight:600;cursor:pointer'
  cancel.onclick = async () => {
    cancel.disabled = true
    try {
      const res = await fetch('/api/system/reset/cancel', { method: 'POST' })
      if (!res.ok) showToast(document.body, 'Cancel failed', { type: 'error', position: 'fixed' })
      // The server's broadcast `reset_cancelled` will clear the banner.
    } catch {
      showToast(document.body, 'Cancel failed', { type: 'error', position: 'fixed' })
      cancel.disabled = false
    }
  }

  banner.appendChild(text)
  banner.appendChild(cancel)
  document.body.appendChild(banner)
  bannerEl = banner

  const tick = () => {
    const remaining = Math.max(0, Math.ceil((commitsAtMs - Date.now()) / 1000))
    text.textContent = `⚠ Sandbox resetting in ${remaining}s — all rooms, agents, and messages will be wiped.`
  }
  tick()
  countdownTimer = setInterval(tick, 200)
}

const showConfirmModal = (): Promise<boolean> =>
  new Promise(resolve => {
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;background:var(--shadow-overlay);display:flex;align-items:center;justify-content:center;z-index:9998'

    const card = document.createElement('div')
    card.style.cssText = 'background:var(--surface);padding:20px;border-radius:8px;box-shadow:0 4px 24px var(--shadow-overlay);max-width:420px;width:90%;font-family:system-ui,sans-serif'

    const title = document.createElement('h2')
    title.textContent = '⚠ Reset sandbox?'
    title.style.cssText = 'margin:0 0 8px;font-size:16px;font-weight:600;color:var(--text-strong)'

    const desc = document.createElement('p')
    desc.textContent = 'Wipes all rooms, agents, messages, agent memory, installed packs, and any user-created skills/tools. Returns to the default state. There is a 10-second window after confirming where any user can cancel.'
    desc.style.cssText = 'margin:0 0 16px;font-size:13px;line-height:1.5;color:var(--text)'

    const actions = document.createElement('div')
    actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end'

    const cancel = document.createElement('button')
    cancel.textContent = 'Cancel'
    cancel.style.cssText = 'padding:8px 14px;border:1px solid var(--border-strong);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px;cursor:pointer'
    cancel.onclick = () => { overlay.remove(); resolve(false) }

    const confirm = document.createElement('button')
    confirm.textContent = 'Reset'
    confirm.style.cssText = 'padding:8px 14px;border:none;border-radius:4px;background:var(--danger);color:#fff;font-size:13px;font-weight:600;cursor:pointer'
    confirm.onclick = () => { overlay.remove(); resolve(true) }

    actions.appendChild(cancel)
    actions.appendChild(confirm)
    card.appendChild(title)
    card.appendChild(desc)
    card.appendChild(actions)
    overlay.appendChild(card)
    document.body.appendChild(overlay)
    cancel.focus()
  })

// Triggered from the Settings drawer. Shows a confirmation modal, then POSTs
// to /api/system/reset. The countdown banner is rendered by the global WS
// listeners (initResetPanel) — visible to ALL tabs, not just the initiator.
export const triggerReset = async (): Promise<void> => {
  const ok = await showConfirmModal()
  if (!ok) return
  try {
    const res = await fetch('/api/system/reset', { method: 'POST' })
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string }
      showToast(document.body, body.error ?? `Reset failed (${res.status})`, { type: 'error', position: 'fixed' })
    }
    // Success path: server broadcasts reset_pending; the banner appears
    // via the listener installed in initResetPanel().
  } catch {
    showToast(document.body, 'Reset request failed', { type: 'error', position: 'fixed' })
  }
}

// Install the global WS listeners that show / hide the countdown banner.
// Called once at app startup. Independent of the trigger surface so the
// banner appears even on tabs that didn't initiate the reset.
export const initResetPanel = (): void => {
  window.addEventListener('reset-pending', (e) => {
    const detail = (e as CustomEvent<{ commitsAtMs: number }>).detail
    showCountdownBanner(detail.commitsAtMs)
  })
  window.addEventListener('reset-cancelled', () => {
    removeBanner()
    showToast(document.body, 'Reset cancelled', { position: 'fixed' })
  })
  window.addEventListener('reset-failed', (e) => {
    const detail = (e as CustomEvent<{ reason: string }>).detail
    removeBanner()
    showToast(document.body, `Reset failed: ${detail.reason}`, { type: 'error', position: 'fixed' })
  })
}
