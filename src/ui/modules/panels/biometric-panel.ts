// Biometrics settings panel — registered with the extension API at
// pack-mount time. Surface:
//
//   - Camera device picker (lists devices via enumerateDevices)
//   - Resolution selector (320×240, 480×360, 640×480)
//   - "Test capture" — runs a short unsolicited capture for hardware verification
//   - "Stop all active captures" — broadcasts samsinn:biometric-stop-all
//   - In-memory revocation log (last 20 captures, cleared on reload)
//
// The panel mounts only while the samsinn-biometrics pack is installed
// AND its UI extension is mounted (see src/ui/modules/extensions/biometrics.ts).
// When the pack is uninstalled, the extension's unmount() calls the panel's
// unmount which clears the host element.

import type { PanelSpec } from '../extensions/registry.ts'
import { createBiometricSession } from '../../../biometrics/index.ts'

const RESOLUTIONS: ReadonlyArray<{ readonly label: string; readonly width: number; readonly height: number }> = [
  { label: '320 × 240 (default, low CPU)', width: 320, height: 240 },
  { label: '480 × 360', width: 480, height: 360 },
  { label: '640 × 480 (high detail)', width: 640, height: 480 },
]

interface RevocationEntry {
  readonly capId: string
  readonly agent: string
  readonly status: string
  readonly at: number
}
const revocationLog: RevocationEntry[] = []
const REVOCATION_LIMIT = 20

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c))

const renderRevocationLog = (host: HTMLElement): void => {
  if (revocationLog.length === 0) {
    host.innerHTML = '<div class="text-xs text-muted">No captures this session.</div>'
    return
  }
  host.innerHTML = `
    <ul class="text-xs space-y-0.5">
      ${revocationLog.slice(-REVOCATION_LIMIT).reverse().map(e => `
        <li><span class="text-muted">${new Date(e.at).toLocaleTimeString()}</span>
            · ${escapeHtml(e.agent)} · ${escapeHtml(e.status)}
            · <span class="text-muted">${escapeHtml(e.capId.slice(0, 12))}…</span></li>`).join('')}
    </ul>`
}

const renderPanel = async (host: HTMLElement): Promise<void> => {
  host.innerHTML = `
    <div class="p-3 space-y-3">
      <div>
        <h3 class="font-medium mb-1">Biometrics</h3>
        <div class="text-xs text-muted mb-2">
          Webcam-based face / attention / expression tracking. Agent-triggered;
          per-capture consent required. Activate the <code>biometrics</code>
          pack in Settings → Packs in any room to enable agent-triggered
          captures from chat.
        </div>
      </div>
      <div>
        <label class="block text-xs text-muted mb-1">Camera</label>
        <select data-role="device" class="w-full rounded border border-border bg-surface px-2 py-1 text-sm"></select>
      </div>
      <div>
        <label class="block text-xs text-muted mb-1">Resolution (test capture)</label>
        <select data-role="resolution" class="w-full rounded border border-border bg-surface px-2 py-1 text-sm">
          ${RESOLUTIONS.map((r, i) => `<option value="${i}">${escapeHtml(r.label)}</option>`).join('')}
        </select>
      </div>
      <div class="flex flex-col gap-2">
        <button data-act="test" class="px-3 py-1 rounded bg-primary text-primary-content text-sm">Test capture</button>
        <button data-act="stop-all" class="px-3 py-1 rounded border border-border text-sm">Stop all active captures</button>
      </div>
      <div data-role="test-host" class="mt-2"></div>
      <div>
        <h4 class="text-xs uppercase text-muted mb-1">Recent captures (this session)</h4>
        <div data-role="log"></div>
      </div>
    </div>`

  const deviceSelect = host.querySelector('[data-role="device"]') as HTMLSelectElement
  const resolutionSelect = host.querySelector('[data-role="resolution"]') as HTMLSelectElement
  const testBtn = host.querySelector('[data-act="test"]') as HTMLButtonElement
  const stopAllBtn = host.querySelector('[data-act="stop-all"]') as HTMLButtonElement
  const testHost = host.querySelector('[data-role="test-host"]') as HTMLElement
  const logHost = host.querySelector('[data-role="log"]') as HTMLElement

  // Populate camera devices. Some browsers withhold device labels until
  // permission has been granted at least once; we still list them by id.
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const cams = devices.filter(d => d.kind === 'videoinput')
    if (cams.length === 0) {
      deviceSelect.innerHTML = '<option value="">(no cameras detected)</option>'
      deviceSelect.disabled = true
      testBtn.disabled = true
    } else {
      deviceSelect.innerHTML = ['<option value="">(default)</option>']
        .concat(cams.map(c => `<option value="${escapeHtml(c.deviceId)}">${escapeHtml(c.label || `Camera ${c.deviceId.slice(0, 6)}`)}</option>`))
        .join('')
    }
  } catch {
    deviceSelect.innerHTML = '<option value="">(enumerate failed)</option>'
    deviceSelect.disabled = true
    testBtn.disabled = true
  }

  renderRevocationLog(logHost)

  testBtn.addEventListener('click', async () => {
    testHost.innerHTML = ''
    const resolution = RESOLUTIONS[Number(resolutionSelect.value)] ?? RESOLUTIONS[0]!
    const w = resolution.width
    const h = resolution.height
    testHost.innerHTML = `
      <div class="border border-border rounded p-2">
        <div class="flex items-center gap-2 mb-1">
          <span class="text-xs">Test capture</span>
          <button data-act="stop-test" class="ml-auto px-2 py-0.5 rounded border border-border text-xs">Stop</button>
        </div>
        <div class="relative inline-block" style="width:${w}px;height:${h}px">
          <video data-role="video" width="${w}" height="${h}" muted playsinline style="transform:scaleX(-1);background:#000;"></video>
          <canvas data-role="canvas" width="${w}" height="${h}" style="position:absolute;inset:0;transform:scaleX(-1);pointer-events:none;"></canvas>
        </div>
        <div data-role="readout" class="text-xs mt-1 text-muted">Starting…</div>
      </div>`
    const videoEl = testHost.querySelector('[data-role="video"]') as HTMLVideoElement
    const canvasEl = testHost.querySelector('[data-role="canvas"]') as HTMLCanvasElement
    const readout = testHost.querySelector('[data-role="readout"]') as HTMLElement
    const stopBtn = testHost.querySelector('[data-act="stop-test"]') as HTMLButtonElement

    const session = createBiometricSession({
      videoEl,
      canvasEl,
      resolution: { width: w, height: h },
      ...(deviceSelect.value ? { deviceId: deviceSelect.value } : {}),
    })

    let pollHandle: ReturnType<typeof setInterval> | null = null
    const tearDown = async (): Promise<void> => {
      if (pollHandle) clearInterval(pollHandle)
      pollHandle = null
      await session.stop()
    }

    session.onError(err => {
      readout.textContent = `Error: ${err.message}`
    })
    try {
      await session.start()
      readout.textContent = 'Capturing…'
      pollHandle = setInterval(() => {
        const s = session.read()
        if (!s) { readout.textContent = 'Waiting for first frame…'; return }
        if (!s.presence) { readout.textContent = 'No face detected'; return }
        readout.textContent = `Attention ${Math.round(s.attention * 100)}% · smile ${Math.round(s.expression.smile * 100)}% · blinks/min ${s.blinkRate.toFixed(1)}`
      }, 250)
    } catch (err) {
      readout.textContent = `Failed: ${err instanceof Error ? err.message : String(err)}`
    }
    stopBtn.addEventListener('click', () => { void tearDown() })
  })

  stopAllBtn.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('samsinn:biometric-stop-all', { detail: { reason: 'panel-stop-all' } }))
  })
}

export const biometricPanelSpec: PanelSpec = {
  id: 'biometrics',
  title: 'Biometrics',
  mount: (host: HTMLElement) => { void renderPanel(host) },
  unmount: () => { /* host clears externally */ },
}
