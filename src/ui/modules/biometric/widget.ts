// Biometric capture widget — the inline element rendered in place of a
// `\`\`\`biometric` fenced code block. One widget per fenced block instance
// (per captureId).
//
// Architecture: the MediaStream is owned by the module-scoped
// SessionRegistry, NOT by this widget. Widgets are *views* into a live
// session; they can come and go (room switches, markdown re-renders) and
// the camera stays correctly owned. The registry's 2 s sweep timer
// guarantees that any session whose wrapper is no longer in the document
// gets stopped — no race condition with MutationObserver attachment,
// no dependence on any specific mutation event firing.
//
// State machine: requested → active → stopped (terminal).
// Off-paths: denied / failed / unavailable / claimed-elsewhere (all terminal).
//
// Lifecycle invariants:
//   - All camera teardown funnels through sessionRegistry.release().
//     Multiple paths (Stop button, agent stop, claim loss, page unload,
//     orphan sweep) all call release; the registry handles idempotency.
//   - On widget re-mount for an existing captureId, the wrapper is swapped
//     onto the existing live session — no re-consent, no second
//     getUserMedia. The old wrapper detaches naturally.
//   - Re-mount after stop is idempotent: `state: 'stopped'` in the fenced
//     block payload renders a static summary; never reopens the camera.

import { createBiometricSession, type CaptureSession, type BiometricSignal } from '../../../biometrics/index.ts'
import { send as sendWS } from '../ws-send.ts'
import { createSessionRegistry, type ReleaseReason } from './session-registry.ts'

interface FencedPayload {
  readonly captureId: string
  readonly agentName: string
  readonly reason: string
  readonly state?: 'requested' | 'active' | 'stopped'
  readonly resolution?: { readonly width: number; readonly height: number }
}

const SIGNAL_PUSH_INTERVAL_MS = 2000

const sessionRegistry = createSessionRegistry({
  onRelease: (captureId, reason) => {
    // Tell the server the capture is done. Server uses this to transition
    // its registry entry to 'stopped' so biometrics_read returns the
    // frozen last snapshot rather than appearing live.
    sendWS({ type: 'biometric_capture_stopped', captureId, reason })
  },
})

// Page-level fan-outs. Set up once at module load; cheap to keep live.
// These trigger registry releases — the registry handles camera teardown,
// view-binding teardown (timers), and subscriber fan-out.
let pageListenersAttached = false
const ensurePageListeners = (): void => {
  if (pageListenersAttached) return
  pageListenersAttached = true

  document.addEventListener('samsinn:biometric-stop-all', () => {
    void sessionRegistry.releaseAll('agent')
  })
  // pagehide covers bfcache + mobile better than beforeunload. Keep both
  // because some browsers fire only one or the other reliably.
  const releaseOnUnload = (): void => { void sessionRegistry.releaseAll('disconnect') }
  window.addEventListener('beforeunload', releaseOnUnload)
  window.addEventListener('pagehide', releaseOnUnload)

  // Agent called biometrics_stop while a widget was still live. The WS
  // dispatcher fans this out as a CustomEvent keyed by captureId.
  window.addEventListener('biometric:stop-requested', (e: Event) => {
    const detail = (e as CustomEvent<{ captureId: string }>).detail
    if (detail?.captureId) void sessionRegistry.release(detail.captureId, 'agent')
  })

  // Another tab won the claim. Drop our local session.
  window.addEventListener('biometric:claimed', (e: Event) => {
    const detail = (e as CustomEvent<{ captureId: string }>).detail
    if (detail?.captureId && sessionRegistry.get(detail.captureId)) {
      void sessionRegistry.release(detail.captureId, 'disconnect')
    }
  })
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c))

const formatPercent = (v: number): string => `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`

const buildSignalCard = (signal: BiometricSignal | null): string => {
  if (!signal) return '<div class="text-xs text-muted">No signal yet…</div>'
  if (!signal.presence) return '<div class="text-xs text-muted">No face detected</div>'
  const e = signal.expression
  return `
    <div class="text-xs space-y-0.5">
      <div>Attention: <strong>${formatPercent(signal.attention)}</strong></div>
      <div>Smile: ${formatPercent(e.smile)} · Frown: ${formatPercent(e.frown)}</div>
      <div>Surprise: ${formatPercent(e.surprise)} · Concentration: ${formatPercent(e.concentration)}</div>
      <div>Blinks/min: ${signal.blinkRate.toFixed(1)}</div>
    </div>`
}

const renderConsent = (wrapper: HTMLElement, payload: FencedPayload, onAllow: () => void, onDeny: () => void): void => {
  wrapper.innerHTML = `
    <div class="border border-border rounded p-3 my-2 bg-surface">
      <div class="font-medium mb-1">${escapeHtml(payload.agentName)} requests biometric capture</div>
      <div class="text-xs text-muted mb-2">Reason: ${escapeHtml(payload.reason || '(no reason given)')}</div>
      <div class="text-xs text-muted mb-3">Webcam will be active until you click Stop.</div>
      <div class="flex gap-2">
        <button data-act="allow" class="px-3 py-1 rounded bg-primary text-primary-content text-sm">Allow</button>
        <button data-act="deny" class="px-3 py-1 rounded border border-border text-sm">Deny</button>
      </div>
    </div>`
  wrapper.querySelector('[data-act="allow"]')?.addEventListener('click', onAllow)
  wrapper.querySelector('[data-act="deny"]')?.addEventListener('click', onDeny)
}

interface ActiveUI {
  readonly videoEl: HTMLVideoElement
  readonly canvasEl: HTMLCanvasElement
  readonly signalsEl: HTMLElement
  readonly stopBtn: HTMLButtonElement
  readonly elapsedEl: HTMLElement
}

const renderActive = (wrapper: HTMLElement, payload: FencedPayload): ActiveUI => {
  const w = payload.resolution?.width ?? 320
  const h = payload.resolution?.height ?? 240
  wrapper.innerHTML = `
    <div class="border border-border rounded p-3 my-2 bg-surface">
      <div class="flex items-center gap-2 mb-2">
        <span class="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
        <span class="text-sm font-medium">REC</span>
        <span class="text-xs text-muted" data-role="elapsed">0s</span>
        <span class="text-xs text-muted">· ${escapeHtml(payload.agentName)} · ${escapeHtml(payload.reason)}</span>
        <button data-act="stop" class="ml-auto px-2 py-0.5 rounded border border-border text-xs">Stop</button>
      </div>
      <div class="relative inline-block" style="width:${w}px;height:${h}px">
        <video data-role="video" width="${w}" height="${h}" muted playsinline style="transform:scaleX(-1);width:${w}px;height:${h}px;background:#000;"></video>
        <canvas data-role="canvas" width="${w}" height="${h}" style="position:absolute;inset:0;transform:scaleX(-1);pointer-events:none;"></canvas>
      </div>
      <div class="mt-2" data-role="signals"></div>
    </div>`
  return {
    videoEl: wrapper.querySelector('[data-role="video"]') as HTMLVideoElement,
    canvasEl: wrapper.querySelector('[data-role="canvas"]') as HTMLCanvasElement,
    signalsEl: wrapper.querySelector('[data-role="signals"]') as HTMLElement,
    stopBtn: wrapper.querySelector('[data-act="stop"]') as HTMLButtonElement,
    elapsedEl: wrapper.querySelector('[data-role="elapsed"]') as HTMLElement,
  }
}

const renderTerminal = (wrapper: HTMLElement, payload: FencedPayload, kind: 'stopped' | 'denied' | 'failed' | 'unavailable' | 'claimed-elsewhere', detail?: string, finalSignal?: BiometricSignal | null): void => {
  const labels: Record<typeof kind, string> = {
    stopped: 'Capture stopped',
    denied: 'Permission denied',
    failed: 'Capture failed',
    unavailable: 'Webcam unavailable',
    'claimed-elsewhere': 'Active in another tab',
  }
  wrapper.innerHTML = `
    <div class="border border-border rounded p-3 my-2 bg-surface text-sm">
      <div class="font-medium mb-1">${escapeHtml(labels[kind])}</div>
      <div class="text-xs text-muted mb-2">Capture: ${escapeHtml(payload.captureId)} · ${escapeHtml(payload.agentName)}</div>
      ${detail ? `<div class="text-xs text-muted mb-2">${escapeHtml(detail)}</div>` : ''}
      ${kind === 'stopped' ? buildSignalCard(finalSignal ?? null) : ''}
    </div>`
}

const parsePayload = (raw: string): FencedPayload | null => {
  try {
    const obj = JSON.parse(raw) as Partial<FencedPayload>
    if (typeof obj.captureId !== 'string' || !obj.captureId) return null
    return {
      captureId: obj.captureId,
      agentName: obj.agentName ?? 'agent',
      reason: obj.reason ?? '',
      state: obj.state ?? 'requested',
      resolution: obj.resolution,
    }
  } catch {
    return null
  }
}

// Wire a wrapper to an already-live session. Used both on fresh-capture
// success and on widget re-mount for an existing captureId. Sets up the
// view-side timers and Stop button; the session itself keeps streaming.
// Returns a `teardown` callback that clears both timers — handed to the
// registry via setViewBinding so release() owns the cleanup. The
// registry's sweep + release paths are now the ONLY teardown routes; the
// old `if (!wrapper.isConnected) clearInterval(...)` self-clear inside
// the tick has been removed (it raced with release ordering).
const wireActiveViewWithUI = (
  wrapper: HTMLElement,
  payload: FencedPayload,
  session: CaptureSession,
  startedAt: number,
  ui: ActiveUI,
): { teardown: () => void } => {
  const elapsedTimer = setInterval(() => {
    const s = Math.floor((performance.now() - startedAt) / 1000)
    ui.elapsedEl.textContent = `${s}s`
    ui.signalsEl.innerHTML = buildSignalCard(session.read())
  }, 250)

  const pushTimer = setInterval(() => {
    const snap = session.read()
    if (snap) sendWS({ type: 'biometric_capture_signal', captureId: payload.captureId, snapshot: snap })
  }, SIGNAL_PUSH_INTERVAL_MS)

  ui.stopBtn.addEventListener('click', () => { void sessionRegistry.release(payload.captureId, 'user') })

  // Pull the new active view into view explicitly — chat auto-scroll
  // fires on new messages, not on same-message resize.
  requestAnimationFrame(() => {
    try { wrapper.scrollIntoView({ block: 'end', behavior: 'smooth' }) } catch { /* ignore */ }
  })

  return {
    teardown: () => {
      clearInterval(elapsedTimer)
      clearInterval(pushTimer)
    },
  }
}

const mountWidget = (wrapper: HTMLElement, payload: FencedPayload): void => {
  ensurePageListeners()

  // Terminal-state payload — render summary and bail. Never opens camera.
  if (payload.state === 'stopped') {
    renderTerminal(wrapper, payload, 'stopped')
    return
  }

  // Re-mount path: a live session already exists for this captureId
  // (the message was re-rendered; markdown produced a fresh wrapper).
  // Swap the wrapper onto the existing session — no re-consent, no
  // second getUserMedia. The previous wrapper is naturally orphaned
  // (it's no longer the registered one).
  const existing = sessionRegistry.get(payload.captureId)
  if (existing) {
    // Re-mount ordering (pinned): (1) setWrapper, (2) renderActive,
    // (3) retarget the live stream onto the new <video>, (4) wire timers
    // and capture teardown, (5) setViewBinding so the registry owns the
    // new timers. Step 5 replaces the previous binding, tearing down the
    // old wrapper's intervals.
    sessionRegistry.setWrapper(payload.captureId, wrapper)
    const ui = renderActive(wrapper, payload)
    void existing.resource.retarget(ui.videoEl, ui.canvasEl)
    const binding = wireActiveViewWithUI(wrapper, payload, existing.resource, performance.now(), ui)
    sessionRegistry.setViewBinding(payload.captureId, binding)
    return
  }

  // No webcam at all on this device → bail before consent.
  if (!navigator.mediaDevices?.getUserMedia) {
    sendWS({ type: 'biometric_capture_failed', captureId: payload.captureId, error: 'getUserMedia unavailable' })
    renderTerminal(wrapper, payload, 'unavailable', 'This browser/device does not expose a webcam.')
    return
  }

  const onAllow = async (): Promise<void> => {
    // Render the active UI *before* awaiting so the user sees the video
    // element appear immediately. The video stays black until session
    // start() assigns srcObject.
    const ui = renderActive(wrapper, payload)
    let session: CaptureSession | null = null
    try {
      session = createBiometricSession({
        videoEl: ui.videoEl,
        canvasEl: ui.canvasEl,
        ...(payload.resolution ? { resolution: payload.resolution } : {}),
      })
      session.onError((err) => {
        sendWS({ type: 'biometric_capture_failed', captureId: payload.captureId, error: err.message })
        renderTerminal(wrapper, payload, 'failed', err.message)
        void sessionRegistry.release(payload.captureId, 'error')
      })
      await session.start()

      // CRITICAL: if the wrapper was detached during the multi-second
      // session.start() (room switch, full re-render, etc.), stop
      // immediately and bail. Without this the camera streams into a
      // detached video element until the registry's next sweep tick —
      // which IS the safety net, but the bail here is faster and avoids
      // a momentary "active" registry entry the agent could read.
      if (!wrapper.isConnected) {
        try { await session.stop() } catch { /* ignore */ }
        sendWS({ type: 'biometric_capture_failed', captureId: payload.captureId, error: 'widget detached during start' })
        return
      }

      sessionRegistry.attach(payload.captureId, session, wrapper)
      sendWS({ type: 'biometric_capture_started', captureId: payload.captureId })
      // Wire timers + listeners onto the ALREADY-RENDERED ui — re-rendering
      // here would destroy the <video> element that just received the
      // live stream, leaving a black box despite an active capture. Hand
      // the teardown to the registry so release() owns timer cleanup.
      const binding = wireActiveViewWithUI(wrapper, payload, session, performance.now(), ui)
      sessionRegistry.setViewBinding(payload.captureId, binding)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Make sure no half-started session leaks if start() partly succeeded.
      try { await session?.stop() } catch { /* ignore */ }
      // Distinguish permission denial from genuine failure.
      if (/denied|not allowed|notallowed/i.test(msg)) {
        sendWS({ type: 'biometric_capture_denied', captureId: payload.captureId })
        renderTerminal(wrapper, payload, 'denied', msg)
      } else {
        sendWS({ type: 'biometric_capture_failed', captureId: payload.captureId, error: msg })
        renderTerminal(wrapper, payload, 'failed', msg)
      }
    }
  }

  const onDeny = (): void => {
    sendWS({ type: 'biometric_capture_denied', captureId: payload.captureId })
    renderTerminal(wrapper, payload, 'denied')
  }

  renderConsent(wrapper, payload, onAllow, onDeny)
}

export const renderBiometricBlocks = async (container: HTMLElement): Promise<void> => {
  const blocks = container.querySelectorAll('code.language-biometric')
  if (blocks.length === 0) return
  for (const block of blocks) {
    const pre = block.parentElement
    if (!pre) continue
    const payload = parsePayload(block.textContent ?? '')
    const wrapper = document.createElement('div')
    if (!payload) {
      wrapper.className = 'border border-border rounded p-3 my-2 bg-surface text-xs text-muted'
      wrapper.textContent = 'Invalid biometric block payload.'
      pre.replaceWith(wrapper)
      continue
    }
    pre.replaceWith(wrapper)
    mountWidget(wrapper, payload)
  }
}

// Re-exported for tests + diagnostics. Not part of the stable public API.
export { sessionRegistry as _sessionRegistry }
export type { ReleaseReason }
