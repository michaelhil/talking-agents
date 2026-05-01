// ============================================================================
// Logging panel — renderers used by the Settings > Logging modal and the
// always-live state dot next to the Logging row in the sidebar.
//
// `renderLoggingInto(panel)` populates the given container with the full
// control surface (toggle, session, directory, kinds, stats). It polls every
// 5 s while its container is in the DOM.
//
// `startLoggingStateDot()` keeps the sidebar dot fresh (every 10 s) whether
// or not the modal is open.
// ============================================================================

import { domRefs } from '../app-dom.ts'
import { showToast } from '../toast.ts'

interface LoggingState {
  enabled: boolean
  dir: string
  sessionId: string
  kinds: string[]
  currentFile: string | null
  stats: {
    eventCount: number
    droppedCount: number
    queuedCount: number
    currentFile: string | null
    currentFileBytes: number
  }
}

const fetchState = async (): Promise<LoggingState | null> => {
  try {
    const res = await fetch('/api/logging')
    if (!res.ok) return null
    return await res.json() as LoggingState
  } catch { return null }
}

const putConfig = async (partial: Partial<LoggingState>): Promise<LoggingState | { error: string }> => {
  const res = await fetch('/api/logging', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(partial),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'update failed' })) as { error?: string }
    return { error: body.error ?? `HTTP ${res.status}` }
  }
  return await res.json() as LoggingState
}

const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttr = (s: string): string =>
  escapeHtml(s).replace(/"/g, '&quot;')

const renderStateDot = (state: LoggingState | null): void => {
  const dot = domRefs.loggingStateDot
  if (!dot) return
  if (!state) { dot.textContent = '◌'; dot.title = 'Logging state unavailable'; return }
  if (!state.enabled) { dot.textContent = '◌'; dot.title = 'Logging off'; return }
  if (state.stats.droppedCount > 0) {
    dot.textContent = '⚠'
    dot.title = `Logging on; ${state.stats.droppedCount} events dropped`
    return
  }
  dot.textContent = '●'
  dot.title = `Logging on · ${state.stats.eventCount} events`
}

const renderPanel = (panel: HTMLElement, refresh: () => Promise<void>, state: LoggingState | null): void => {
  renderStateDot(state)
  if (!state) {
    panel.innerHTML = '<div class="text-text-muted">Logging state unavailable.</div>'
    return
  }

  panel.innerHTML = `
    <div class="space-y-3 text-xs">
      <div class="flex items-center gap-2">
        <button id="logging-toggle-btn" class="px-3 py-1 rounded text-xs font-medium ${state.enabled ? 'bg-danger/20 text-danger hover:bg-danger/30' : 'bg-success/20 text-success hover:bg-success/30'}">
          ${state.enabled ? 'Stop recording' : 'Start recording'}
        </button>
        <span class="text-text-subtle">${state.enabled ? 'recording' : 'off'}</span>
      </div>

      <div>
        <div class="text-text-subtle mb-1 text-xs font-semibold uppercase tracking-wide">Session id</div>
        <div class="flex gap-1">
          <input id="logging-session" type="text" value="${escapeAttr(state.sessionId)}" class="input flex-1" />
          <button id="logging-session-apply" class="btn btn-ghost" title="Apply — starts a new file with session.start">Apply</button>
        </div>
      </div>

      <div>
        <div class="text-text-subtle mb-1 text-xs font-semibold uppercase tracking-wide">Output directory</div>
        <div class="flex gap-1">
          <input id="logging-dir" type="text" value="${escapeAttr(state.dir)}" class="input flex-1 font-mono" />
          <button id="logging-dir-apply" class="btn btn-ghost" title="Apply — closes current file, opens in new dir">Apply</button>
        </div>
      </div>

      <div>
        <div class="text-text-subtle mb-1 text-xs font-semibold uppercase tracking-wide">Kind filter (comma-separated globs)</div>
        <div class="flex gap-1">
          <input id="logging-kinds" type="text" value="${escapeAttr(state.kinds.join(', '))}" class="input flex-1 font-mono" placeholder="*" />
          <button id="logging-kinds-apply" class="btn btn-ghost">Apply</button>
        </div>
      </div>

      <div class="pt-2 border-t border-border space-y-1 text-text-subtle">
        <div>Current file: <span class="text-text font-mono break-all">${state.currentFile ? escapeHtml(state.currentFile) : '—'}</span></div>
        <div>Events written: <span class="text-text">${state.stats.eventCount}</span> · queued: <span class="text-text">${state.stats.queuedCount}</span> · dropped: <span class="${state.stats.droppedCount > 0 ? 'text-warning' : 'text-text'}">${state.stats.droppedCount}</span></div>
        <div>File size: <span class="text-text">${fmtBytes(state.stats.currentFileBytes)}</span></div>
      </div>
    </div>
  `

  panel.querySelector<HTMLButtonElement>('#logging-toggle-btn')?.addEventListener('click', async () => {
    const result = await putConfig({ enabled: !state.enabled })
    if ('error' in result) {
      showToast(document.body, `Logging: ${result.error}`, { type: 'error', position: 'fixed' })
    } else {
      showToast(document.body, `Logging ${result.enabled ? 'started' : 'stopped'}`, { type: 'success', position: 'fixed' })
    }
    await refresh()
  })

  panel.querySelector<HTMLButtonElement>('#logging-session-apply')?.addEventListener('click', async () => {
    const input = panel.querySelector<HTMLInputElement>('#logging-session')
    const next = input?.value.trim()
    if (!next || next === state.sessionId) return
    const result = await putConfig({ sessionId: next })
    if ('error' in result) {
      showToast(document.body, `Session: ${result.error}`, { type: 'error', position: 'fixed' })
    } else {
      showToast(document.body, `Session → ${next}`, { type: 'success', position: 'fixed' })
    }
    await refresh()
  })

  panel.querySelector<HTMLButtonElement>('#logging-dir-apply')?.addEventListener('click', async () => {
    const input = panel.querySelector<HTMLInputElement>('#logging-dir')
    const next = input?.value.trim()
    if (!next || next === state.dir) return
    const result = await putConfig({ dir: next })
    if ('error' in result) {
      showToast(document.body, `Directory: ${result.error}`, { type: 'error', position: 'fixed' })
    } else {
      showToast(document.body, `Directory → ${next}`, { type: 'success', position: 'fixed' })
    }
    await refresh()
  })

  panel.querySelector<HTMLButtonElement>('#logging-kinds-apply')?.addEventListener('click', async () => {
    const input = panel.querySelector<HTMLInputElement>('#logging-kinds')
    const raw = input?.value.trim() ?? ''
    const parsed = raw.length === 0 ? ['*'] : raw.split(',').map(s => s.trim()).filter(Boolean)
    const result = await putConfig({ kinds: parsed })
    if ('error' in result) {
      showToast(document.body, `Kinds: ${result.error}`, { type: 'error', position: 'fixed' })
    } else {
      showToast(document.body, `Kinds updated (${parsed.length} pattern${parsed.length === 1 ? '' : 's'})`, { type: 'success', position: 'fixed' })
    }
    await refresh()
  })
}

export const renderLoggingInto = (panel: HTMLElement): { stop: () => void } => {
  let disposed = false
  const refresh = async (): Promise<void> => {
    if (disposed || !panel.isConnected) { stop(); return }
    const state = await fetchState()
    if (disposed || !panel.isConnected) return
    renderPanel(panel, refresh, state)
  }
  const timer = setInterval(() => { if (!document.hidden) void refresh() }, 5_000)
  const stop = (): void => { disposed = true; clearInterval(timer) }
  void refresh()
  return { stop }
}

// Lightweight dot-only refresh — runs for the life of the app so the sidebar
// shows recording state whether or not the Logging modal is open.
let dotTimer: ReturnType<typeof setInterval> | null = null
export const startLoggingStateDot = (): void => {
  if (dotTimer) return
  void fetchState().then(renderStateDot)
  dotTimer = setInterval(() => {
    if (!document.hidden) void fetchState().then(renderStateDot)
  }, 10_000)
}
